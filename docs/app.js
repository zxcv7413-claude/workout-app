/* 운동기록 PWA — 바닐라 JS + Firebase(로그인/Firestore 동기화, 오프라인 지원) */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDocFromServer, setDoc, deleteDoc, collection, onSnapshot, writeBatch }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// Firebase 웹 설정값 (공개되어도 되는 값이며, 데이터 보호는 로그인 + Firestore 보안 규칙이 담당합니다)
const firebaseConfig = {
  apiKey: 'AIzaSyAQBS9VU0FbPvDeITkNm4Hio5MDXALABGM',
  authDomain: 'workout-app-7b744.firebaseapp.com',
  projectId: 'workout-app-7b744',
  storageBucket: 'workout-app-7b744.firebasestorage.app',
  messagingSenderId: '407418042563',
  appId: '1:407418042563:web:f54317c8fa0ed93033ca76',
};
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// 일부 환경(사파리 홈 화면 앱, 특정 와이파이)에서 기본 연결이 막혀 무한 대기하는 문제를 막기 위해 롱폴링 자동 감지를 켭니다.
const fs = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }), experimentalAutoDetectLongPolling: true });
const AUTH = { status: 'loading', user: null, error: '', busy: false }; // loading | out | in
let UID = null, unsubs = [], loaded = { state: false, logs: false, photos: false };
const ref = {
  state: () => doc(fs, 'users', UID, 'data', 'state'),
  log: id => doc(fs, 'users', UID, 'logs', id),
  photo: id => doc(fs, 'users', UID, 'photos', id),
  logs: () => collection(fs, 'users', UID, 'logs'),
  photos: () => collection(fs, 'users', UID, 'photos'),
};

// ───────────────────────── 유틸
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
const pad = n => String(n).padStart(2, '0');
const fmtDate = ts => { const d = new Date(ts); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}.`; };
const fmtShort = ts => { const d = new Date(ts); return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };
const fmtT = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDow = ts => DAYS[(new Date(ts).getDay() + 6) % 7];
const fmtClock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); return (h ? h + ':' : '') + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60); };
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? 0 : n; };
const kgText = n => (Math.round(n * 100) / 100).toString();
const todayIdx = () => (new Date().getDay() + 6) % 7;
const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// ───────────────────────── (구버전) 기기 내 IndexedDB — 기존 데이터를 클라우드로 옮길 때만 읽습니다
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('workout-app', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('photos'); };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  get(store, key) {
    return new Promise(res => { const q = DB.db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
  },
  put(store, key, val) {
    return new Promise(res => { const tx = DB.db.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key); tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
  },
  del(store, key) {
    return new Promise(res => { const tx = DB.db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => res(); });
  },
  all(store) {
    return new Promise(res => {
      const out = {}; const q = DB.db.transaction(store).objectStore(store).openCursor();
      q.onsuccess = () => { const c = q.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
      q.onerror = () => res(out);
    });
  },
  clear(store) { return new Promise(res => { const tx = DB.db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = () => res(); }); },
};

// ───────────────────────── 상태
let S, P = {}; // S: 앱 데이터, P: 사진(id → dataURL)
const U = { tab: 'plan', day: todayIdx(), edit: false, stack: [], sheet: null, libPart: '전체', libQ: '' };

function initState() {
  const exercises = DEFAULT_EXERCISES.map(e => ({ ...e, memo: '', photos: [] }));
  const plan = DAYS.map(() => ({ title: '', items: [] }));
  plan[0] = { title: DEFAULT_PLAN_MON.title, items: DEFAULT_PLAN_MON.items.map(([exId, sets, kg, reps]) => ({ uid: uid(), exId, sets, kg, reps })) };
  return { v: 1, exercises, plan, logs: [], active: null, settings: { rest: 90 } };
}
let saveTimer = null;
const ready = () => AUTH.status === 'in' && loaded.state && loaded.logs && loaded.photos && S;
const fail = e => { console.error(e); toast('저장에 실패했습니다'); };
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 250); }
// 상태 문서(운동 목록·플랜·진행 중 운동·설정)를 저장. 기록(logs)과 사진은 각각 별도 문서로 저장합니다.
function writeState() {
  const { logs, ...rest } = S;
  setDoc(ref.state(), { json: JSON.stringify(rest), updatedAt: Date.now() }).catch(fail);
}
function flush() { clearTimeout(saveTimer); if (ready()) writeState(); }
const saveLog = l => { if (UID) setDoc(ref.log(l.id), { json: JSON.stringify(l), start: l.start }).catch(fail); };
const removeLog = id => { if (UID) deleteDoc(ref.log(id)).catch(fail); };
const savePhoto = (id, data) => { if (UID) setDoc(ref.photo(id), { data }).catch(fail); };
const removePhoto = id => { if (UID) deleteDoc(ref.photo(id)).catch(fail); };
// 기록/사진 문서를 통째로 교체 (가져오기·초기화용). 한 번에 최대 500건이라 나눠서 처리합니다.
async function replaceAll(newS, newP) {
  const ops = [];
  S.logs.forEach(l => ops.push(b => b.delete(ref.log(l.id))));
  Object.keys(P).forEach(k => ops.push(b => b.delete(ref.photo(k))));
  newS.logs.forEach(l => ops.push(b => b.set(ref.log(l.id), { json: JSON.stringify(l), start: l.start })));
  Object.keys(newP).forEach(k => ops.push(b => b.set(ref.photo(k), { data: newP[k] })));
  S = newS; P = newP; writeState(); // 최초 생성 시에는 아직 ready()가 아니므로 직접 저장
  // 오프라인이어도 쓰기는 대기열에 쌓였다가 연결되면 반영됩니다.
  for (let i = 0; i < ops.length; i += 400) { const b = writeBatch(fs); ops.slice(i, i + 400).forEach(f => f(b)); b.commit().catch(fail); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else tick(); });
window.addEventListener('pagehide', flush);

const exById = id => S.exercises.find(e => e.id === id);
const exName = id => (exById(id) || { name: '(삭제된 운동)' }).name;
function logsFor(exId) {
  return [...S.logs].sort((a, b) => b.start - a.start)
    .map(l => ({ log: l, entry: l.entries.find(e => e.exId === exId) })).filter(x => x.entry);
}
const maxKg = sets => sets.reduce((m, s) => Math.max(m, s.kg), 0);
const volume = sets => sets.reduce((v, s) => v + s.kg * s.reps, 0);
const estMin = items => Math.round(items.reduce((a, i) => a + i.sets * (40 + S.settings.rest), 0) / 60);
function lastText(exId) {
  const l = logsFor(exId)[0]; if (!l) return '';
  return `지난 기록 (${fmtShort(l.log.start)}): ` + l.entry.sets.map(s => `${kgText(s.kg)}kg×${s.reps}`).join(', ');
}
function defaultsFor(exId) {
  const l = logsFor(exId)[0];
  if (l) { const s = l.entry.sets[l.entry.sets.length - 1]; return { sets: l.entry.sets.length, kg: s.kg, reps: s.reps }; }
  return { sets: 3, kg: 0, reps: 10 };
}

// ───────────────────────── 렌더링 공통
const backBtn = '<button class="icon-btn" data-a="back" aria-label="뒤로" style="font-size:30px">‹</button>';
const spacer = '<span class="icon-btn"></span>';
const topbar = (l, title, r) => `<div class="topbar">${l || spacer}<h1>${esc(title)}</h1>${r || spacer}</div>`;
function thumb(ex) {
  const pid = ex && ex.photos && ex.photos[0];
  const act = ex ? `data-a="thumbPick" data-id="${esc(ex.id)}"` : '';
  if (pid && P[pid]) return `<div class="thumb" ${act}><img src="${P[pid]}" alt=""></div>`;
  return `<div class="thumb" ${act}>${esc(ex ? ex.part : '?')}<span class="cam">📷</span></div>`;
}

function authView() {
  if (AUTH.status === 'loading' || (AUTH.status === 'in' && !ready())) {
    const f = n => (loaded[n] ? '✓' : '…');
    return `<div class="screen" style="align-items:center;justify-content:center;padding:24px;text-align:center"><div style="color:var(--sub)">불러오는 중…</div>
      ${AUTH.status === 'in' ? `<div class="hint" style="margin-top:14px">상태 ${f('state')} · 기록 ${f('logs')} · 사진 ${f('photos')}<br>${navigator.onLine ? '온라인' : '⚠️ 오프라인'}</div>
      ${AUTH.error ? `<div style="color:var(--danger);margin-top:10px;font-size:13px;word-break:break-all">${esc(AUTH.error)}</div>` : ''}
      <button class="btn" style="margin-top:20px" data-a="reload">다시 시도</button>
      <button class="btn" style="margin-top:10px" data-a="logout">로그아웃</button>` : ''}</div>`;
  }
  return `<div class="screen" style="justify-content:center;padding:24px">
    <div style="text-align:center;font-size:44px">🏋️</div><h1 style="text-align:center;margin:6px 0 20px">운동기록</h1>
    <label>이메일</label><input id="loginEmail" type="email" autocomplete="username" autocapitalize="off" inputmode="email" value="${esc(AUTH.email || '')}">
    <label>비밀번호</label><input id="loginPw" type="password" autocomplete="current-password">
    ${AUTH.error ? `<div style="color:var(--danger);margin-top:12px;font-size:14px">${esc(AUTH.error)}</div>` : ''}
    <button class="btn primary block" style="margin-top:20px" data-a="login" ${AUTH.busy ? 'disabled' : ''}>${AUTH.busy ? '로그인 중…' : '로그인'}</button></div>`;
}

function render() {
  if (!ready()) { $app.innerHTML = authView(); return; }
  const sc = {}; $app.querySelectorAll('.scroll').forEach(e => sc[e.dataset.k] = e.scrollTop);
  let html = baseView();
  U.stack.forEach((s, i) => { html += screenView(s, i); });
  html += sheetView();
  html += restBarHtml();
  $app.innerHTML = html;
  $app.querySelectorAll('.scroll').forEach(e => { if (sc[e.dataset.k]) e.scrollTop = sc[e.dataset.k]; });
}

function baseView() {
  const tabs = [['plan', '📋', '플랜'], ['history', '🕘', '기록'], ['lib', '🏋️', '운동'], ['set', '⚙️', '설정']];
  const body = { plan: planView, history: historyView, lib: libView, set: settingsView }[U.tab]();
  return `<div class="screen" style="z-index:1">${body}
    <div class="tabbar">${tabs.map(([k, ic, t]) => `<button class="${U.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}"><span class="ic">${ic}</span>${t}</button>`).join('')}</div></div>`;
}
function screenView(s, i) {
  const z = `style="z-index:${10 + i}"`;
  if (s.t === 'ex') return `<div class="screen" ${z}>${exView(s)}</div>`;
  if (s.t === 'workout') return `<div class="screen" ${z}>${workoutView()}</div>`;
  if (s.t === 'sess') return `<div class="screen" ${z}>${sessView(s)}</div>`;
  return '';
}

// ───────────────────────── 플랜 탭
function planView() {
  const d = S.plan[U.day]; const today = todayIdx();
  const items = d.items.map((it, i) => {
    const ex = exById(it.exId);
    const ctl = U.edit
      ? `<div class="ctl"><button data-a="up" data-i="${i}">▲</button><button data-a="down" data-i="${i}">▼</button></div><button class="icon-btn" style="color:var(--danger)" data-a="delItem" data-i="${i}">✕</button>`
      : `<button class="icon-btn" data-a="itemMenu" data-i="${i}" aria-label="수정">⋯</button>`;
    return `<div class="item">
      <div data-a="openEx" data-id="${esc(it.exId)}" style="display:contents">${thumb(ex)}
        <div class="body"><div class="name">${esc(exName(it.exId))}</div>
          <div class="sub">${it.sets}세트 X ${kgText(it.kg)}kg X ${it.reps}회</div>
          ${ex && ex.memo ? `<div class="memo">📝 ${esc(ex.memo)}</div>` : ''}</div></div>${ctl}</div>`;
  }).join('');
  const act = S.active;
  const btn = d.items.length || act
    ? `<button class="fab" data-a="${act ? 'resume' : 'start'}">${act ? '운동 이어하기' : '시작하기'}</button>` : '';
  return `${topbar('', `${DAYS[U.day]}요일 플랜`, '')}
  <div class="days">${DAYS.map((x, i) => `<button class="${i === U.day ? 'on' : ''} ${i === today ? 'today' : ''}" data-a="day" data-v="${i}">${x}</button>`).join('')}</div>
  <div class="scroll" data-k="plan${U.day}">
    <input id="dayTitle" value="${esc(d.title)}" placeholder="이 날의 부위 (예: 등, 이두)" style="margin:6px 0 4px">
    <div class="meta"><span>총 ${d.items.length}개</span><span>|</span><span>⏱ ${estMin(d.items)} 분</span><span class="sp"></span>
      <button class="chip ${U.edit ? 'on' : ''}" data-a="toggleEdit">${U.edit ? '완료' : '⇅ 순서 변경'}</button></div>
    ${items || '<div class="empty">아직 계획된 운동이 없어요.<br>아래 버튼으로 운동을 추가해 보세요.</div>'}
    <button class="btn block" style="margin-top:16px" data-a="addEx">＋ 운동 추가</button>
    <div class="pad-bottom"></div></div>
  <div class="wrap-bottom">${btn}</div>`;
}

// ───────────────────────── 운동 상세
function exView(s) {
  const ex = exById(s.id);
  if (!ex) return topbar(backBtn, '운동') + '<div class="empty">삭제된 운동입니다.</div>';
  const tab = s.tab || 'rec';
  const head = topbar(backBtn, ex.name, `<button class="icon-btn" data-a="editEx" data-id="${esc(ex.id)}" aria-label="편집" style="font-size:18px">✎</button>`) +
    `<div class="tabs2"><button class="${tab === 'rec' ? 'on' : ''}" data-a="exTab" data-v="rec">분석/기록</button><button class="${tab === 'guide' ? 'on' : ''}" data-a="exTab" data-v="guide">가이드/메모</button></div>`;
  return head + `<div class="scroll" data-k="ex-${ex.id}-${tab}-${s.sub}">${tab === 'rec' ? exRec(ex, s) : exGuide(ex, s)}<div class="pad-bottom" style="height:40px"></div></div>`;
}
function exRec(ex, s) {
  const logs = logsFor(ex.id);
  const metric = s.metric || 'kg';
  const pts = logs.slice(0, 20).reverse().map(x => ({ t: x.log.start, v: metric === 'kg' ? maxKg(x.entry.sets) : volume(x.entry.sets) }));
  const cards = logs.map(x => `<div class="log-date">${fmtDate(x.log.start)} <span style="color:var(--sub);font-size:13px">${fmtDow(x.log.start)} · ${fmtT(x.log.start)}</span></div>
    <div class="log-card">${x.entry.sets.map(st => `<div>${kgText(st.kg)}kg x ${st.reps}회</div>`).join('')}</div>`).join('');
  return `<div class="chips" style="margin-top:12px"><button class="chip ${metric === 'kg' ? 'on' : ''}" data-a="exMetric" data-v="kg">최대 무게</button><button class="chip ${metric === 'vol' ? 'on' : ''}" data-a="exMetric" data-v="vol">총 볼륨</button></div>
    <div class="chart">${chart(pts, metric === 'kg' ? 'kg' : '')}</div>
    <h2>기록</h2>${cards || '<div class="empty">아직 기록이 없어요.<br>운동을 완료하면 여기에 쌓입니다.</div>'}`;
}
function exGuide(ex, s) {
  const sub = s.sub || 'guide'; const gd = ex.guide || {};
  const ol = a => `<ol>${(a || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol>`;
  const chips = [['eq', '기구 사용법'], ['memo', '내 메모'], ['guide', '운동 가이드']]
    .map(([k, t]) => `<button class="chip ${sub === k ? 'on' : ''}" data-a="exSub" data-v="${k}">${t}</button>`).join('');
  const photos = (ex.photos || []).filter(p => P[p]).map(p => `<div style="position:relative"><img class="photo" src="${P[p]}" alt="">
      <div style="position:absolute;right:8px;top:22px;display:flex;gap:6px">
      ${p === ex.photos[0] ? '<span class="chip" style="background:#000a;color:var(--accent)">대표</span>' : `<button class="chip" style="background:#000a" data-a="photoMain" data-p="${p}">대표로</button>`}
      <button class="chip" style="background:#000a" data-a="photoDel" data-p="${p}">삭제</button></div></div>`).join('');
  let body = '';
  if (sub === 'eq') body = `<h2>기구 사용법</h2>${(gd.eq || []).length ? ol(gd.eq) : '<div class="hint">작성된 내용이 없습니다. 우측 상단 ✎에서 입력하세요.</div>'}`;
  else if (sub === 'memo') body = `<h2>내 메모</h2><textarea id="exMemo" rows="6" placeholder="예: 시트 3칸, 핀 위치, 팔꿈치 느낌 등">${esc(ex.memo)}</textarea>
      <div class="hint" style="margin-top:8px">여기에 적은 메모는 플랜 목록과 운동 진행 화면에 계속 표시됩니다.</div>`;
  else body = `<h2>운동 가이드</h2><h3>시작 자세</h3>${ol(gd.start)}<h3>운동 동작</h3>${ol(gd.motion)}
      <h3>호흡법</h3><div style="line-height:1.7;color:#dfe1e5">${esc(gd.breath || '-')}</div><h3>주의사항</h3>${ol(gd.caution)}`;
  return `<div class="chips" style="margin-top:12px">${chips}</div>${body}
    <h2 style="font-size:18px">예시 사진</h2>${photos || '<div class="hint">첨부한 사진이 없습니다.</div>'}
    <label class="btn block" style="margin-top:12px;cursor:pointer">📷 사진 추가<input type="file" accept="image/*" id="photoIn" data-id="${esc(ex.id)}" style="display:none"></label>`;
}

// 간단한 꺾은선 그래프(SVG)
function chart(pts, unit) {
  if (!pts.length) return '<div class="empty" style="padding:30px 0">그래프를 그릴 기록이 없습니다.</div>';
  const W = 320, H = 150, p = { l: 38, r: 14, t: 16, b: 26 };
  let mn = Math.min(...pts.map(x => x.v)), mx = Math.max(...pts.map(x => x.v));
  if (mn === mx) { mn = Math.max(0, mn - 1); mx += 1; }
  const X = i => pts.length === 1 ? p.l + (W - p.l - p.r) / 2 : p.l + (W - p.l - p.r) * i / (pts.length - 1);
  const Y = v => p.t + (H - p.t - p.b) * (1 - (v - mn) / (mx - mn));
  const line = pts.map((x, i) => `${X(i)},${Y(x.v)}`).join(' ');
  const lab = (v) => kgText(v) + (unit || '');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="추이 그래프">
    <line x1="${p.l}" x2="${W - p.r}" y1="${Y(mn)}" y2="${Y(mn)}" style="stroke:var(--line)"/>
    <line x1="${p.l}" x2="${W - p.r}" y1="${Y(mx)}" y2="${Y(mx)}" style="stroke:var(--line)" stroke-dasharray="3 3"/>
    <text x="${p.l - 4}" y="${Y(mx) + 4}" text-anchor="end" font-size="10" style="fill:var(--sub)">${esc(lab(mx))}</text>
    <text x="${p.l - 4}" y="${Y(mn) + 4}" text-anchor="end" font-size="10" style="fill:var(--sub)">${esc(lab(mn))}</text>
    ${pts.length > 1 ? `<polyline points="${line}" fill="none" stroke-width="2.5" stroke-linejoin="round" style="stroke:var(--accent)"/>` : ''}
    ${pts.map((x, i) => `<circle cx="${X(i)}" cy="${Y(x.v)}" r="3.5" style="fill:var(--accent)"/>`).join('')}
    <text x="${X(pts.length - 1)}" y="${Y(pts[pts.length - 1].v) - 8}" text-anchor="${pts.length > 1 ? 'end' : 'middle'}" font-size="11" font-weight="700" style="fill:var(--text)">${esc(lab(pts[pts.length - 1].v))}</text>
    <text x="${p.l}" y="${H - 6}" font-size="10" style="fill:var(--sub)">${fmtShort(pts[0].t)}</text>
    <text x="${W - p.r}" y="${H - 6}" text-anchor="end" font-size="10" style="fill:var(--sub)">${fmtShort(pts[pts.length - 1].t)}</text></svg>`;
}

// ───────────────────────── 운동 진행
function startWorkout() {
  const d = S.plan[U.day]; if (!d.items.length) return;
  S.active = {
    start: Date.now(), day: U.day, title: d.title || `${DAYS[U.day]}요일 운동`, restEnd: null,
    entries: d.items.map(it => ({ exId: it.exId, sets: Array.from({ length: it.sets }, () => ({ kg: it.kg, reps: it.reps, done: false })) })),
  };
  save(); U.stack.push({ t: 'workout' }); render();
}
function workoutView() {
  const a = S.active; if (!a) return topbar(backBtn, '운동') + '<div class="empty">진행 중인 운동이 없습니다.</div>';
  const cards = a.entries.map((e, wi) => {
    const ex = exById(e.exId); const last = lastText(e.exId);
    const done = e.sets.filter(s => s.done).length;
    return `<div class="w-card"><div class="nm"><span>${esc(exName(e.exId))}</span>
        <span style="display:flex;gap:6px;align-items:center"><span style="font-size:13px;color:var(--sub)">${done}/${e.sets.length}</span>
        <button class="chip" data-a="wInfo" data-id="${esc(e.exId)}">가이드</button></span></div>
      ${ex && ex.memo ? `<div class="memo">📝 ${esc(ex.memo)}</div>` : ''}
      ${last ? `<div class="last">${esc(last)}</div>` : ''}
      <div class="setrow" style="color:var(--sub);font-size:12px"><span></span><span style="text-align:center">kg</span><span style="text-align:center">회</span><span></span></div>
      ${e.sets.map((s, si) => `<div class="setrow ${s.done ? 'done' : ''}"><span class="n">${si + 1}</span>
        <input inputmode="decimal" value="${kgText(s.kg)}" data-w="${wi}" data-s="${si}" data-f="kg">
        <input inputmode="numeric" value="${s.reps}" data-w="${wi}" data-s="${si}" data-f="reps">
        <button class="ck" data-a="wToggle" data-w="${wi}" data-s="${si}" aria-label="완료">✓</button></div>`).join('')}
      <div class="row" style="margin-top:10px"><button class="btn" data-a="wAddSet" data-w="${wi}">＋ 세트</button><button class="btn" data-a="wDelSet" data-w="${wi}">－ 세트</button></div></div>`;
  }).join('');
  return topbar(backBtn, a.title, `<button class="chip" data-a="wFinish" style="background:var(--accent);color:#05231c;font-weight:700">종료</button>`) +
    `<div style="text-align:center;color:var(--sub);font-size:13px;margin-top:-4px">시작 ${fmtT(a.start)} · 경과 <b id="wElapsed" style="color:var(--text)">${fmtClock(Date.now() - a.start)}</b></div>
    <div class="scroll" data-k="workout">${cards}<button class="btn block" style="margin-top:14px" data-a="wAddEx">＋ 운동 추가</button><div class="pad-bottom" style="height:150px"></div></div>
    <div class="wrap-bottom"><button class="fab" data-a="wFinish">운동 종료하고 저장</button></div>`;
}
function restBarHtml() {
  const a = S.active; if (!a || !a.restEnd || !U.stack.some(s => s.t === 'workout')) return '';
  return `<div class="restbar"><span style="font-size:13px">휴식</span><span class="tm" id="restTm">${fmtClock(a.restEnd - Date.now())}</span>
    <button data-a="restAdj" data-v="-10">-10s</button><button data-a="restAdj" data-v="10">+10s</button><button data-a="restSkip">건너뛰기</button></div>`;
}
let actx = null;
function beep() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach(t => { const o = actx.createOscillator(), g = actx.createGain(); o.connect(g); g.connect(actx.destination);
      o.frequency.value = 880; g.gain.value = 0.15; o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.15); });
  } catch (e) { /* 소리 불가 시 무시 */ }
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}
function tick() {
  const a = S && S.active; if (!a) return;
  const el = document.getElementById('wElapsed'); if (el) el.textContent = fmtClock(Date.now() - a.start);
  if (a.restEnd) {
    const left = a.restEnd - Date.now();
    if (left <= 0) { a.restEnd = null; save(); beep(); render(); }
    else { const t = document.getElementById('restTm'); if (t) t.textContent = fmtClock(left); }
  }
}
setInterval(() => { if (S) tick(); }, 500);

function finishWorkout() {
  const a = S.active; if (!a) return;
  const entries = a.entries.map(e => ({ exId: e.exId, sets: e.sets.filter(s => s.done).map(s => ({ kg: num(s.kg), reps: Math.round(num(s.reps)) })) })).filter(e => e.sets.length);
  if (!entries.length) {
    if (confirm('완료한 세트가 없습니다. 기록하지 않고 운동을 종료할까요?')) { S.active = null; U.stack = []; save(); render(); }
    return;
  }
  if (!confirm('운동을 종료하고 저장할까요?')) return;
  const log = { id: uid(), start: a.start, end: Date.now(), day: a.day, title: a.title, entries };
  S.logs.push(log); saveLog(log);
  if (confirm('오늘 수행한 무게/횟수를 플랜에 반영할까요?\n(마지막으로 완료한 세트 기준)')) {
    entries.forEach(e => {
      const it = S.plan[a.day].items.find(i => i.exId === e.exId); const last = e.sets[e.sets.length - 1];
      if (it) { it.kg = last.kg; it.reps = last.reps; }
    });
  }
  S.active = null; U.stack = []; U.tab = 'history'; save(); render(); toast('운동이 저장되었습니다');
}

// ───────────────────────── 기록 탭
function historyView() {
  const logs = [...S.logs].sort((a, b) => b.start - a.start);
  const now = new Date(); const mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - todayIdx());
  const week = logs.filter(l => l.start >= mon.getTime()).length;
  const avg = logs.length ? Math.round(logs.reduce((a, l) => a + (l.end - l.start), 0) / logs.length / 60000) : 0;
  const list = logs.map(l => {
    const sets = l.entries.reduce((a, e) => a + e.sets.length, 0); const vol = l.entries.reduce((a, e) => a + volume(e.sets), 0);
    return `<button class="sess" data-a="sess" data-id="${l.id}"><div class="h"><span>${fmtDate(l.start)} ${fmtDow(l.start)}</span><span style="color:var(--accent)">${Math.round((l.end - l.start) / 60000)}분</span></div>
      <div class="s">${esc(l.title)} · ${fmtT(l.start)} ~ ${fmtT(l.end)}</div><div class="s">${l.entries.length}종목 · ${sets}세트 · 볼륨 ${Math.round(vol).toLocaleString()}kg</div></button>`;
  }).join('');
  return `${topbar('', '운동 기록', '')}<div class="scroll" data-k="hist">
    <div class="stats"><div class="card"><b>${week}</b><span>이번 주 운동</span></div><div class="card"><b>${logs.length}</b><span>전체 운동</span></div><div class="card"><b>${avg}<small style="font-size:13px">분</small></b><span>평균 시간</span></div></div>
    ${list || '<div class="empty">아직 운동 기록이 없어요.<br>플랜 탭에서 운동을 시작해 보세요.</div>'}<div class="pad-bottom" style="height:30px"></div></div>`;
}
function sessView(s) {
  const l = S.logs.find(x => x.id === s.id);
  if (!l) return topbar(backBtn, '기록') + '<div class="empty">기록을 찾을 수 없습니다.</div>';
  return topbar(backBtn, `${fmtDate(l.start)} ${fmtDow(l.start)}`) + `<div class="scroll" data-k="sess-${l.id}">
    <div class="card"><div style="font-weight:700">${esc(l.title)}</div><div class="hint">시작 ${fmtT(l.start)} · 종료 ${fmtT(l.end)} · 총 ${Math.round((l.end - l.start) / 60000)}분</div></div>
    ${l.entries.map(e => `<div class="log-date" data-a="openEx" data-id="${esc(e.exId)}">${esc(exName(e.exId))}</div><div class="log-card">${e.sets.map(st => `<div>${kgText(st.kg)}kg x ${st.reps}회</div>`).join('')}</div>`).join('')}
    <button class="btn danger block" style="margin-top:24px" data-a="delSess" data-id="${l.id}">이 기록 삭제</button><div class="pad-bottom" style="height:30px"></div></div>`;
}

// ───────────────────────── 운동 목록 탭
function libList() {
  const q = U.libQ.trim().toLowerCase();
  const list = S.exercises.filter(e => (U.libPart === '전체' || e.part === U.libPart) && (!q || e.name.toLowerCase().includes(q)));
  return list.map(e => `<div class="item" data-a="openEx" data-id="${esc(e.id)}">${thumb(e)}<div class="body"><div class="name">${esc(e.name)}</div>
    <div class="sub">${esc(e.part)}${e.memo ? ' · 📝 메모 있음' : ''}</div></div><span style="color:var(--sub)">›</span></div>`).join('') || '<div class="empty">검색 결과가 없습니다.</div>';
}
function libView() {
  return `${topbar('', '운동 목록', `<button class="icon-btn" data-a="newEx" aria-label="새 운동" style="font-size:26px;color:var(--accent)">＋</button>`)}
    <div class="scroll" data-k="lib"><input id="libQ" value="${esc(U.libQ)}" placeholder="운동 검색" style="margin-top:4px">
    <div class="chips" style="margin-top:10px">${['전체', ...PARTS].map(p => `<button class="chip ${U.libPart === p ? 'on' : ''}" data-a="libPart" data-v="${p}">${p}</button>`).join('')}</div>
    <div id="libList">${libList()}</div><div class="pad-bottom" style="height:30px"></div></div>`;
}

// ───────────────────────── 설정 탭
function settingsView() {
  return `${topbar('', '설정', '')}<div class="scroll" data-k="set">
    <div class="card"><label style="margin-top:0">기본 휴식 시간 (초)</label><input id="restSec" inputmode="numeric" value="${S.settings.rest}"></div>
    <div class="card"><div style="font-weight:700;margin-bottom:6px">데이터 백업</div>
      <div class="hint">기록은 로그인한 계정의 클라우드에 저장되어 Mac과 아이폰에서 함께 쓸 수 있습니다. 만일을 위해 가끔 내보내기로 파일 백업도 해 두세요.</div>
      <div class="row" style="margin-top:12px"><button class="btn" data-a="export">내보내기</button>
      <label class="btn" style="text-align:center;cursor:pointer">가져오기<input type="file" accept="application/json,.json" id="importIn" style="display:none"></label></div></div>
    <div class="card"><div style="font-weight:700;margin-bottom:6px">계정 · 동기화</div><div class="hint" id="storeInfo">계정: ${esc(AUTH.user ? AUTH.user.email : '-')}<br>기록 ${S.logs.length}회 · 운동 ${S.exercises.length}개</div>
      <button class="btn block" style="margin-top:10px" data-a="logout">로그아웃</button></div>
    <div class="card"><div style="font-weight:700;margin-bottom:6px">기본 가이드 복원</div>
      <div class="hint">기본 운동 목록에서 빠진 항목을 다시 추가합니다. 수정한 가이드·메모는 유지됩니다.</div>
      <button class="btn block" style="margin-top:10px" data-a="restoreDefaults">복원</button></div>
    <button class="btn danger block" style="margin-top:18px" data-a="reset">모든 데이터 초기화</button>
    <div class="hint" style="text-align:center;margin-top:16px">운동기록 v2 · 개인용</div><div class="pad-bottom" style="height:30px"></div></div>`;
}

// ───────────────────────── 시트(모달)
function sheetView() {
  const s = U.sheet; if (!s) return '';
  let inner = '';
  if (s.t === 'add') {
    inner = `<h3>운동 추가</h3><input id="pickQ" placeholder="운동 검색" value="${esc(s.q || '')}">
      <div class="chips" style="margin-top:10px">${['전체', ...PARTS].map(p => `<button class="chip ${s.part === p ? 'on' : ''}" data-a="pickPart" data-v="${p}">${p}</button>`).join('')}</div>
      <div id="pickList">${pickList()}</div>
      <button class="btn primary block" style="margin-top:14px" data-a="newExFromPick">＋ 새 운동 직접 만들기</button>`;
  } else if (s.t === 'item') {
    const it = S.plan[s.day].items[s.i]; if (!it) return '';
    inner = `<h3>${esc(exName(it.exId))}</h3><div class="row">
      <div><label>세트</label><input id="fSets" inputmode="numeric" value="${it.sets}"></div>
      <div><label>무게(kg)</label><input id="fKg" inputmode="decimal" value="${kgText(it.kg)}"></div>
      <div><label>횟수</label><input id="fReps" inputmode="numeric" value="${it.reps}"></div></div>
      <div class="row" style="margin-top:18px"><button class="btn danger" data-a="delItem" data-i="${s.i}">플랜에서 제거</button><button class="btn primary" data-a="saveItem">저장</button></div>`;
  } else if (s.t === 'editEx') {
    const ex = s.id ? exById(s.id) : null; const gd = (ex && ex.guide) || {};
    inner = `<h3>${ex ? '운동 편집' : '새 운동'}</h3>
      <label>이름</label><input id="eName" value="${esc(ex ? ex.name : '')}" placeholder="운동 이름">
      <label>부위</label><select id="ePart">${PARTS.map(p => `<option ${ex && ex.part === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <label>기구 사용법 (한 줄에 하나)</label><textarea id="eEq">${esc((gd.eq || []).join('\n'))}</textarea>
      <label>시작 자세</label><textarea id="eStart">${esc((gd.start || []).join('\n'))}</textarea>
      <label>운동 동작</label><textarea id="eMotion">${esc((gd.motion || []).join('\n'))}</textarea>
      <label>호흡법</label><input id="eBreath" value="${esc(gd.breath || '')}">
      <label>주의사항</label><textarea id="eCaution">${esc((gd.caution || []).join('\n'))}</textarea>
      <div class="row" style="margin-top:18px">${ex ? '<button class="btn danger" data-a="delEx">삭제</button>' : ''}<button class="btn primary" data-a="saveEx">저장</button></div>`;
  }
  return `<div class="overlay" data-a="closeSheet"><div class="sheet">${inner}</div></div>`;
}
function pickList() {
  const s = U.sheet; const q = (s.q || '').trim().toLowerCase();
  const list = S.exercises.filter(e => (s.part === '전체' || e.part === s.part) && (!q || e.name.toLowerCase().includes(q)));
  return list.map(e => `<button class="pick" data-a="pickEx" data-id="${esc(e.id)}"><span>${esc(e.name)}</span><small>${esc(e.part)}</small></button>`).join('') || '<div class="empty">검색 결과가 없습니다.</div>';
}

// ───────────────────────── 이벤트
function addToTarget(exId) {
  const d = defaultsFor(exId);
  if (U.sheet.ctx === 'workout' && S.active) {
    S.active.entries.push({ exId, sets: Array.from({ length: d.sets }, () => ({ kg: d.kg, reps: d.reps, done: false })) });
  } else S.plan[U.day].items.push({ uid: uid(), exId, sets: d.sets, kg: d.kg, reps: d.reps });
  U.sheet = null; save(); render();
}
function topEx() { const s = U.stack[U.stack.length - 1]; return s && s.t === 'ex' ? s : null; }

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-a]'); if (!el) return;
  if (el.classList.contains('overlay') && ev.target !== el) return;
  const a = el.dataset.a, v = el.dataset.v, id = el.dataset.id, i = el.dataset.i !== undefined ? +el.dataset.i : null;
  if (a === 'login') { doLogin(); return; }
  if (a === 'reload') { location.reload(); return; }
  if (a === 'logout') { if (confirm('로그아웃할까요?')) signOut(auth); return; }
  if (!ready()) return;
  const d = S.plan[U.day];
  switch (a) {
    case 'tab': U.tab = v; U.edit = false; break;
    case 'day': U.day = +v; U.edit = false; break;
    case 'toggleEdit': U.edit = !U.edit; break;
    case 'up': if (i > 0) { [d.items[i - 1], d.items[i]] = [d.items[i], d.items[i - 1]]; save(); } break;
    case 'down': if (i < d.items.length - 1) { [d.items[i + 1], d.items[i]] = [d.items[i], d.items[i + 1]]; save(); } break;
    case 'delItem': if (U.sheet && U.sheet.t === 'item') { U.sheet = null; } d.items.splice(i, 1); save(); break;
    case 'itemMenu': U.sheet = { t: 'item', day: U.day, i }; break;
    case 'saveItem': {
      const it = d.items[U.sheet.i];
      it.sets = Math.max(1, Math.min(20, Math.round(num(document.getElementById('fSets').value)) || 1));
      it.kg = num(document.getElementById('fKg').value); it.reps = Math.max(1, Math.round(num(document.getElementById('fReps').value)) || 1);
      U.sheet = null; save(); break;
    }
    case 'closeSheet': U.sheet = null; break;
    case 'addEx': U.sheet = { t: 'add', part: '전체', q: '', ctx: 'plan' }; break;
    case 'wAddEx': U.sheet = { t: 'add', part: '전체', q: '', ctx: 'workout' }; break;
    case 'pickPart': U.sheet.part = v; break;
    case 'pickEx': addToTarget(id); return;
    case 'newExFromPick': U.sheet = { t: 'editEx', id: null, forTarget: U.sheet.ctx }; break;
    case 'newEx': U.sheet = { t: 'editEx', id: null, forTarget: null }; break;
    case 'editEx': U.sheet = { t: 'editEx', id }; break;
    case 'saveEx': saveEx(); return;
    case 'delEx': {
      const ex = exById(U.sheet.id);
      if (ex && confirm(`'${ex.name}' 운동을 삭제할까요? 플랜에서도 제거됩니다. (과거 기록은 남습니다)`)) {
        S.exercises = S.exercises.filter(e => e.id !== ex.id); S.plan.forEach(p => p.items = p.items.filter(x => x.exId !== ex.id));
        (ex.photos || []).forEach(p => { delete P[p]; removePhoto(p); });
        U.sheet = null; U.stack = U.stack.filter(s => !(s.t === 'ex' && s.id === ex.id)); save();
      }
      break;
    }
    case 'openEx': { const ex = exById(id); if (!ex) break; U.stack.push({ t: 'ex', id, tab: 'rec', sub: ex.memo ? 'memo' : 'guide', metric: 'kg' }); break; }
    case 'wInfo': { const ex = exById(id); U.stack.push({ t: 'ex', id, tab: 'guide', sub: 'guide', metric: 'kg' }); break; }
    case 'back': U.stack.pop(); break;
    case 'exTab': topEx().tab = v; break;
    case 'exSub': topEx().sub = v; break;
    case 'exMetric': topEx().metric = v; break;
    case 'photoDel': {
      const ex = exById(topEx().id);
      if (confirm('이 사진을 삭제할까요?')) { ex.photos = ex.photos.filter(p => p !== el.dataset.p); delete P[el.dataset.p]; removePhoto(el.dataset.p); save(); }
      break;
    }
    case 'thumbPick': thumbInput.dataset.id = id; thumbInput.value = ''; thumbInput.click(); return;
    case 'photoMain': { const ex = exById(topEx().id); ex.photos = [el.dataset.p, ...ex.photos.filter(x => x !== el.dataset.p)]; save(); break; }
    case 'libPart': U.libPart = v; break;
    case 'start': startWorkout(); return;
    case 'resume': U.stack.push({ t: 'workout' }); break;
    case 'wToggle': {
      const st = S.active.entries[+el.dataset.w].sets[+el.dataset.s]; st.done = !st.done;
      if (st.done) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { /* ignore */ }
        S.active.restEnd = Date.now() + S.settings.rest * 1000; } else S.active.restEnd = null;
      save(); break;
    }
    case 'wAddSet': { const e = S.active.entries[+el.dataset.w]; const l = e.sets[e.sets.length - 1] || { kg: 0, reps: 10 }; e.sets.push({ kg: l.kg, reps: l.reps, done: false }); save(); break; }
    case 'wDelSet': { const e = S.active.entries[+el.dataset.w]; if (e.sets.length > 1) e.sets.pop(); save(); break; }
    case 'wFinish': finishWorkout(); return;
    case 'restAdj': S.active.restEnd = Math.max(Date.now() + 1000, S.active.restEnd + (+v) * 1000); save(); break;
    case 'restSkip': S.active.restEnd = null; save(); break;
    case 'sess': U.stack.push({ t: 'sess', id }); break;
    case 'delSess': if (confirm('이 운동 기록을 삭제할까요?')) { S.logs = S.logs.filter(l => l.id !== id); removeLog(id); U.stack.pop(); save(); } break;
    case 'export': exportData(); return;
    case 'restoreDefaults': {
      let n = 0; DEFAULT_EXERCISES.forEach(e => { if (!exById(e.id)) { S.exercises.push({ ...e, memo: '', photos: [] }); n++; } });
      save(); toast(n ? `${n}개 운동을 복원했습니다` : '복원할 항목이 없습니다'); break;
    }
    case 'reset':
      if (confirm('모든 플랜·기록·메모·사진이 삭제됩니다. 계속할까요?') && confirm('정말 초기화할까요? 되돌릴 수 없습니다.')) {
        replaceAll(initState(), {}); U.stack = []; U.tab = 'plan';
      }
      break;
    default: return;
  }
  render();
  if (a === 'tab' && U.tab === 'set') accountInfo();
});

function saveEx() {
  const name = document.getElementById('eName').value.trim(); if (!name) { toast('이름을 입력하세요'); return; }
  const guide = {
    eq: lines(document.getElementById('eEq').value), start: lines(document.getElementById('eStart').value),
    motion: lines(document.getElementById('eMotion').value), breath: document.getElementById('eBreath').value.trim(),
    caution: lines(document.getElementById('eCaution').value),
  };
  const part = document.getElementById('ePart').value; const s = U.sheet;
  if (s.id) { const ex = exById(s.id); Object.assign(ex, { name, part, guide }); U.sheet = null; save(); render(); return; }
  const ex = { id: 'c-' + uid(), name, part, guide, memo: '', photos: [] }; S.exercises.push(ex);
  if (s.forTarget) { U.sheet = { ctx: s.forTarget }; addToTarget(ex.id); return; }
  U.sheet = null; save(); render();
}

// 입력 이벤트(리렌더 없이 상태만 갱신)
document.addEventListener('input', ev => {
  if (!ready()) return;
  const t = ev.target;
  if (t.dataset && t.dataset.f && S.active) { S.active.entries[+t.dataset.w].sets[+t.dataset.s][t.dataset.f] = t.value; save(); }
  else if (t.id === 'dayTitle') { S.plan[U.day].title = t.value; save(); }
  else if (t.id === 'exMemo') { exById(topEx().id).memo = t.value; save(); }
  else if (t.id === 'libQ') { U.libQ = t.value; document.getElementById('libList').innerHTML = libList(); }
  else if (t.id === 'pickQ') { U.sheet.q = t.value; document.getElementById('pickList').innerHTML = pickList(); }
  else if (t.id === 'restSec') { const n = Math.round(num(t.value)); if (n >= 5 && n <= 900) { S.settings.rest = n; save(); } }
});

document.addEventListener('change', async ev => {
  if (!ready()) return;
  const t = ev.target;
  if (t.id === 'photoIn' && t.files[0]) {
    try {
      const url = await resizeImage(t.files[0]); const pid = 'p-' + uid(); P[pid] = url; savePhoto(pid, url);
      const ex = exById(t.dataset.id); ex.photos = ex.photos || []; ex.photos.push(pid); save(); render(); toast('사진을 추가했습니다');
    } catch (e) { toast('사진을 불러오지 못했습니다'); }
  } else if (t.id === 'importIn' && t.files[0]) importData(t.files[0]);
});
const thumbInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
thumbInput.style.display = 'none'; document.body.appendChild(thumbInput);
thumbInput.addEventListener('change', async () => {
  const f = thumbInput.files[0]; const ex = ready() && exById(thumbInput.dataset.id); if (!f || !ex) return;
  try {
    const url = await resizeImage(f); const pid = 'p-' + uid(); P[pid] = url; savePhoto(pid, url);
    ex.photos = [pid, ...(ex.photos || [])]; save(); render(); toast('대표 사진으로 설정했습니다');
  } catch (e) { toast('사진을 불러오지 못했습니다'); }
});
function resizeImage(file, max = 900) {
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas');
      c.width = Math.round(img.width * r); c.height = Math.round(img.height * r); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(u); res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => rej(new Error('image')); img.src = u;
  });
}

// ───────────────────────── 백업
async function exportData() {
  flush();
  const blob = new Blob([JSON.stringify({ app: 'workout', version: 1, exportedAt: Date.now(), S, P })], { type: 'application/json' });
  const name = `운동기록-백업-${fmtDate(Date.now()).replace(/\./g, '')}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function importData(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (!obj.S || !Array.isArray(obj.S.exercises) || !Array.isArray(obj.S.plan)) throw new Error('형식 오류');
    if (!confirm('현재 데이터를 백업 파일의 내용으로 덮어씁니다. 계속할까요?')) return;
    obj.S.logs = obj.S.logs || [];
    await replaceAll(normalizeState(obj.S), obj.P || {});
    U.stack = []; U.tab = 'plan'; render(); toast('가져오기 완료');
  } catch (e) { alert('백업 파일을 읽을 수 없습니다.'); }
}
function accountInfo() {
  const el = document.getElementById('storeInfo'); if (!el) return;
  el.innerHTML = `계정: ${esc(AUTH.user ? AUTH.user.email : '-')}<br>${navigator.onLine ? '온라인 — 변경 사항이 자동으로 동기화됩니다' : '⚠️ 오프라인 — 연결되면 자동으로 동기화됩니다'}<br>기록 ${S.logs.length}회 · 운동 ${S.exercises.length}개`;
}

// ───────────────────────── 로그인 / 클라우드 동기화
function normalizeState(s) {
  s.settings = s.settings || { rest: 90 }; s.active = s.active || null; s.logs = s.logs || [];
  s.exercises.forEach(e => { e.photos = e.photos || []; e.memo = e.memo || ''; });
  return s;
}
let cloudLogs = [], shown = false, renderPending = false, bootstrapping = false;
function stopSync() { unsubs.forEach(u => u()); unsubs = []; loaded = { state: false, logs: false, photos: false }; cloudLogs = []; bootstrapping = false; }
function afterRemote() {
  if (!(loaded.state && loaded.logs && loaded.photos)) return;
  if (!shown) { shown = true; if (S.active && !U.stack.some(x => x.t === 'workout')) U.stack.push({ t: 'workout' }); render(); return; }
  const a = document.activeElement;
  if (a && $app.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { renderPending = true; return; } // 입력 중에는 화면 갱신을 미룸
  render();
}
document.addEventListener('focusout', () => {
  if (!renderPending) return;
  setTimeout(() => { const a = document.activeElement; if (!(a && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) { renderPending = false; render(); } }, 80);
});
// 이 기기에 예전(로그인 도입 전)에 저장된 데이터가 있으면 클라우드로 옮기고, 없으면 기본 데이터로 시작
async function bootstrapCloud() {
  let st = null, ph = {};
  try { await DB.open(); const old = await DB.get('kv', 'state'); if (old && Array.isArray(old.exercises)) { st = old; ph = await DB.all('photos'); } } catch (e) { /* 없음 */ }
  S = { logs: [] }; P = {};
  await replaceAll(normalizeState(st || initState()), ph);
}
function startSync() {
  stopSync();
  unsubs.push(onSnapshot(ref.state(), snap => {
    if (!snap.exists()) {
      // 상태 문서가 없으면 서버에 직접 확인한 뒤에만 최초 데이터를 만듭니다(오래된 캐시 때문에 기존 데이터를 덮어쓰지 않도록).
      if (!bootstrapping) {
        bootstrapping = true;
        getDocFromServer(ref.state()).then(d => { if (!d.exists()) return bootstrapCloud(); bootstrapping = false; })
          .catch(e => { bootstrapping = false; AUTH.error = '서버 확인 실패 (' + (e.code || e.message) + ') — 다시 시도를 눌러 주세요'; render(); });
      }
      return;
    }
    if (loaded.state && snap.metadata.hasPendingWrites) return; // 내가 방금 쓴 변경은 이미 반영되어 있음
    try { S = normalizeState({ ...JSON.parse(snap.data().json), logs: cloudLogs }); } catch (e) { return fail(e); }
    loaded.state = true; afterRemote();
  }, e => { console.error(e); AUTH.error = '데이터를 불러오지 못했습니다 (' + (e.code || e.message) + ')'; render(); }));
  unsubs.push(onSnapshot(ref.logs(), snap => {
    cloudLogs = snap.docs.map(d => { try { return JSON.parse(d.data().json); } catch (e) { return null; } }).filter(Boolean);
    if (S) S.logs = cloudLogs;
    loaded.logs = true; afterRemote();
  }, console.error));
  unsubs.push(onSnapshot(ref.photos(), snap => {
    P = {}; snap.docs.forEach(d => { P[d.id] = d.data().data; });
    loaded.photos = true; afterRemote();
  }, console.error));
}
const AUTH_MSG = {
  'auth/invalid-credential': '이메일 또는 비밀번호가 올바르지 않습니다.', 'auth/wrong-password': '이메일 또는 비밀번호가 올바르지 않습니다.',
  'auth/user-not-found': '이메일 또는 비밀번호가 올바르지 않습니다.', 'auth/invalid-email': '이메일 형식을 확인하세요.',
  'auth/too-many-requests': '시도가 너무 많습니다. 잠시 후 다시 시도하세요.', 'auth/network-request-failed': '네트워크에 연결할 수 없습니다.',
};
function doLogin() {
  const email = document.getElementById('loginEmail').value.trim(), pw = document.getElementById('loginPw').value;
  if (!email || !pw) { AUTH.error = '이메일과 비밀번호를 입력하세요.'; AUTH.email = email; render(); return; }
  AUTH.busy = true; AUTH.error = ''; AUTH.email = email; render();
  signInWithEmailAndPassword(auth, email, pw).catch(e => { AUTH.busy = false; AUTH.error = AUTH_MSG[e.code] || ('로그인 실패 (' + (e.code || e.message) + ')'); render(); });
}
document.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.id === 'loginPw') doLogin(); });
onAuthStateChanged(auth, user => {
  if (user) { AUTH.status = 'in'; AUTH.user = user; AUTH.error = ''; AUTH.busy = false; UID = user.uid; render(); startSync(); }
  else { stopSync(); AUTH.status = 'out'; AUTH.user = null; AUTH.busy = false; UID = null; S = undefined; P = {}; U.stack = []; U.sheet = null; shown = false; render(); }
});

// ───────────────────────── 시작
// iOS 홈 화면 앱에서 화면 아래쪽이 비는 문제 방지: 실제 화면 높이를 계산해 앱 높이로 지정합니다.
function fitHeight() {
  let h = window.innerHeight;
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (standalone && window.innerHeight > window.innerWidth) h = Math.max(h, Math.max(screen.height, screen.width)); // 세로 모드
  document.documentElement.style.setProperty('--app-h', h + 'px');
}
fitHeight(); window.addEventListener('resize', fitHeight); window.addEventListener('orientationchange', () => setTimeout(fitHeight, 200));
setInterval(() => { if (AUTH.status === 'in' && !ready()) render(); }, 1500); // 로딩 진단 표시 갱신
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
render();
