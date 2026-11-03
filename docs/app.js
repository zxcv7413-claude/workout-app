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
const hms = s => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
const LB = 0.45359237; // 1lb = 0.45359237kg
const unitOf = ex => (ex && ex.unit === 'lb' ? 'lbs' : 'kg');
const isTime = ex => !!(ex && ex.mode === 'time'); // 초 단위 운동(플랭크 등)
const isBw = ex => !!(ex && (ex.bw || ex.mode === 'time')); // 무게를 입력하지 않는 운동
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
const U = { tab: 'plan', day: todayIdx(), edit: false, stack: [], sheet: null, libPart: '전체', libQ: '', memoPos: {} };
const MIG = 11; // 데이터 형식 버전 (11: 메모 여러 개, 운동 표시 옵션, 화~토 기본 플랜, 휴식 50초)
const REST_DEFAULT = 50;

const planItems = d => d.items.map(([exId, sets, kg, reps]) => ({ uid: uid(), exId, sets, kg, reps }));
function initState() {
  const exercises = DEFAULT_EXERCISES.map(e => ({ ...e, memos: [], photos: [] }));
  const plan = DEFAULT_PLANS.map(d => ({ title: d.title, items: planItems(d) }));
  return { v: 1, exercises, plan, logs: [], active: null, settings: { rest: REST_DEFAULT }, mig: MIG };
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
const maxKg = sets => sets.reduce((m, s) => Math.max(m, num(s.kg)), 0);
// 볼륨(kg) = 무게 × 횟수 × 세트. 덤벨 두 개를 쓰는 운동은 ×2, 파운드 기록은 kg으로 환산, 초 단위 운동은 0.
function entryVol(e) {
  if (e.time) return 0;
  const ex = exById(e.exId), f = (ex && ex.db ? 2 : 1) * (e.unit === 'lb' ? LB : 1);
  return e.sets.reduce((v, s) => v + num(s.kg) * num(s.reps), 0) * f;
}
const entryUnit = e => (e.unit === 'lb' ? 'lbs' : 'kg');
// 기록 한 세트를 글자로 (예: 8kg x 12회 / 13회 / 40초)
function setLine(st, e) {
  const ex = exById(e.exId);
  if (e.time) return `${st.reps}초`;
  if (isBw(ex) && !num(st.kg)) return `${st.reps}회`;
  return `${kgText(st.kg)}${entryUnit(e)} x ${st.reps}회`;
}
// 플랜 항목 한 줄 (예: 4세트 X 75kg X 8회 / 3세트 X 00:00:40)
function itemText(it, ex) {
  if (isTime(ex)) return `${it.sets}세트 X ${hms(it.reps)}`;
  if (isBw(ex)) return `${it.sets}세트 X ${it.reps}회`;
  return `${it.sets}세트 X ${kgText(it.kg)}${unitOf(ex)} X ${it.reps}회`;
}
const estMin = items => Math.round(items.reduce((a, i) => a + i.sets * (40 + S.settings.rest), 0) / 60);
function defaultsFor(exId) {
  const l = logsFor(exId)[0];
  if (l) { const s = l.entry.sets[l.entry.sets.length - 1]; return { sets: l.entry.sets.length, kg: s.kg, reps: s.reps }; }
  return { sets: 3, kg: 0, reps: isTime(exById(exId)) ? 40 : 10 };
}
// 직전 기록(같은 번호 세트, 없으면 마지막 세트)의 무게/횟수와 날짜
function prevSet(exId, i) {
  const l = logsFor(exId)[0]; if (!l) return null;
  const sets = l.entry.sets; return { st: sets[i] || sets[sets.length - 1], entry: l.entry, t: l.log.start };
}
// 1RM 추정(Epley): 무게 × (1 + 횟수/30)
const est1rm = e => e.sets.reduce((m, s) => Math.max(m, num(s.kg) * (1 + num(s.reps) / 30)), 0);
const maxReps = e => e.sets.reduce((m, s) => Math.max(m, num(s.reps)), 0);

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
  $app.innerHTML = html;
  $app.querySelectorAll('.scroll').forEach(e => { if (sc[e.dataset.k]) e.scrollTop = sc[e.dataset.k]; });
  $app.querySelectorAll('.memos').forEach(m => { m.scrollLeft = (U.memoPos[m.dataset.id] || 0) * m.clientWidth; }); // 메모 슬라이드 위치 유지
}
// 메모 슬라이드를 넘길 때 아래 점 표시만 갱신 (다시 그리지 않음)
document.addEventListener('scroll', ev => {
  const t = ev.target; if (!t || !t.classList || !t.classList.contains('memos')) return;
  const i = Math.round(t.scrollLeft / Math.max(1, t.clientWidth)); U.memoPos[t.dataset.id] = i;
  const dots = t.nextElementSibling && t.nextElementSibling.querySelectorAll('span');
  if (dots) dots.forEach((d, k) => d.classList.toggle('on', k === i));
}, true);

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
  if (s.t === 'ana') return `<div class="screen" ${z}>${anaView(s)}</div>`;
  if (s.t === 'caut') return `<div class="screen" ${z}>${cautView(s)}</div>`;
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
          <div class="sub">${itemText(it, ex)}</div>
          ${ex && ex.memos.length ? `<div class="memo">📝 ${esc(ex.memos[0])}${ex.memos.length > 1 ? ` (+${ex.memos.length - 1})` : ''}</div>` : ''}</div></div>${ctl}</div>`;
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
  const pts = logs.slice(0, 20).reverse().map(x => ({ t: x.log.start, v: metric === 'kg' ? maxKg(x.entry.sets) : entryVol(x.entry) }));
  const cards = logs.map(x => `<div class="log-date">${fmtDate(x.log.start)} <span style="color:var(--sub);font-size:13px">${fmtDow(x.log.start)} · ${fmtT(x.log.start)}</span></div>
    <div class="log-card">${x.entry.sets.map(st => `<div>${esc(setLine(st, x.entry))}</div>`).join('')}</div>`).join('');
  return `<div class="chips" style="margin-top:12px"><button class="chip ${metric === 'kg' ? 'on' : ''}" data-a="exMetric" data-v="kg">최대 무게</button><button class="chip ${metric === 'vol' ? 'on' : ''}" data-a="exMetric" data-v="vol">총 볼륨</button></div>
    <div class="chart">${chart(pts, metric === 'kg' ? unitOf(ex) : 'kg')}</div>
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
  else if (sub === 'memo') body = `<h2>내 메모</h2>
      ${ex.memos.map((m, i) => `<div class="sect" style="padding:12px 16px;display:flex;gap:10px;align-items:center" data-a="memoEdit" data-id="${esc(ex.id)}" data-i="${i}"><div style="flex:1;white-space:pre-wrap">${esc(m)}</div><span style="color:var(--sub)">✎</span></div>`).join('') || '<div class="hint">작성한 메모가 없습니다.</div>'}
      <button class="btn block" style="margin-top:12px" data-a="memoAdd" data-id="${esc(ex.id)}">＋ 메모 추가</button>
      <div class="hint" style="margin-top:8px">메모는 여러 개 적을 수 있고, 운동 진행 화면에서 옆으로 넘겨 하나씩 볼 수 있습니다. 플랜 목록에는 첫 번째 메모가 표시됩니다.</div>`;
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

// ───────────────────────── 운동 진행 (운동 하나씩 전체 화면)
function startWorkout() {
  const d = S.plan[U.day]; if (!d.items.length) return;
  S.active = {
    start: Date.now(), day: U.day, title: d.title || `${DAYS[U.day]}요일 운동`, restEnd: null, ci: 0, si: 0,
    entries: d.items.map(it => ({ exId: it.exId, sets: Array.from({ length: it.sets }, () => ({ kg: it.kg, reps: it.reps, done: false })) })),
  };
  save(); U.stack.push({ t: 'workout' }); render();
}
// a.ci = 지금 운동, a.si = 지금 세트. 모든 운동을 마치면 a.ci === entries.length 입니다.
const firstUndone = e => { const k = e.sets.findIndex(s => !s.done); return k < 0 ? e.sets.length - 1 : k; };
function gotoEx(a, ci) { a.restEnd = null; a.ci = Math.max(0, Math.min(a.entries.length - 1, ci)); a.si = firstUndone(a.entries[a.ci]); }
function advance(a) { // 마친 세트 다음으로: 다음 세트 → 다음 운동 → (끝)
  const e = a.entries[a.ci];
  if (a.si < e.sets.length - 1) a.si++;
  else if (a.ci < a.entries.length - 1) { a.ci++; a.si = firstUndone(a.entries[a.ci]); }
  else { a.ci = a.entries.length; a.si = 0; }
}
function endRest(a) { // 휴식이 끝나면(또는 건너뛰면) 마친 세트 다음 세트로 넘어갑니다
  a.restEnd = null;
  const e = a.entries[a.ci]; if (e && e.sets[a.si] && e.sets[a.si].done) advance(a);
}

// 메모: 옆으로 넘겨 하나씩 보고, 눌러서 수정
function memoCarousel(ex) {
  const ms = ex.memos || [];
  const slides = ms.length
    ? ms.map((m, i) => `<div class="memo-slide" data-a="memoEdit" data-id="${esc(ex.id)}" data-i="${i}">${esc(m)}</div>`).join('')
    : `<div class="memo-slide empty-m" data-a="memoAdd" data-id="${esc(ex.id)}">탭해서 메모를 추가하세요</div>`;
  const pos = Math.min(U.memoPos[ex.id] || 0, Math.max(0, ms.length - 1));
  const dots = ms.length > 1 ? ms.map((_, i) => `<span class="${i === pos ? 'on' : ''}"></span>`).join('') : '';
  return `<div class="memos" data-id="${esc(ex.id)}">${slides}</div><div class="dots">${dots}<button data-a="memoAdd" data-id="${esc(ex.id)}">＋ 메모</button></div>`;
}
function setRows(a, e, ex) {
  const unit = unitOf(ex), time = isTime(ex), bw = isBw(ex);
  return e.sets.map((s, i) => {
    const cur = i === a.si, p = prevSet(e.exId, i);
    const cls = `srow ${cur ? 'cur' : ''} ${s.done ? 'done' : ''}`;
    if (!cur) {
      const val = time ? `${s.reps} 초` : bw ? `${s.reps} 회` : `${kgText(num(s.kg))} ${unit} / ${s.reps} 회`;
      return `<div class="${cls}" data-a="wPick" data-s="${i}"><span class="sn">${i + 1}세트</span><span class="sv sm">${esc(val)}</span></div>`;
    }
    let prev = '';
    if (p) { // 직전에 운동할 때의 무게(또는 횟수)와 날짜
      const pt = time ? `${p.st.reps}초` : bw ? `${p.st.reps}회` : `${kgText(p.st.kg)}${entryUnit(p.entry)}`;
      prev = `<span class="prev">직전 ${esc(pt)}<br>${fmtShort(p.t)}</span>`;
    }
    const wIn = `<input inputmode="decimal" value="${esc(kgText(num(s.kg)))}" data-w="${a.ci}" data-s="${i}" data-f="kg">`;
    const rIn = `<input inputmode="numeric" value="${esc(s.reps)}" data-w="${a.ci}" data-s="${i}" data-f="reps">`;
    const mid = time ? `<span class="fld">${rIn}<span class="u">초</span></span>${prev}`
      : bw ? `<span class="fld">${rIn}<span class="u">회</span></span>${prev}`
      : `<span class="fld">${wIn}<span class="u">${unit}</span>${ex && ex.db ? '<span class="dbn">덤벨 한 개당</span>' : ''}</span>${prev}<span class="slash">/</span><span class="fld">${rIn}<span class="u">회</span></span>`;
    return `<div class="${cls}"><span class="sn">${i + 1}세트</span><div class="sv">${mid}</div></div>`;
  }).join('');
}
function workoutView() {
  const a = S.active;
  if (!a) return topbar(backBtn, '운동') + '<div class="empty">진행 중인 운동이 없습니다.</div>';
  const n = a.entries.length;
  const nav = `<div class="wk-nav"><button class="icon-btn" data-a="wEx" data-v="-1" aria-label="이전 운동">‹</button><span class="wk-prog">${Math.min(a.ci + 1, n)}/${n}</span><button class="icon-btn" data-a="wEx" data-v="1" aria-label="다음 운동">›</button><button class="chip" data-a="wList">목록</button></div>`;
  const head = `<div class="wk-head">${backBtn}<div class="wk-clock"><i></i><span id="wElapsed">${fmtClock(Date.now() - a.start)}</span></div>${nav}</div>`;
  if (a.ci >= n) { // 모든 운동 완료
    const sets = a.entries.reduce((t, e) => t + e.sets.filter(s => s.done).length, 0);
    return head + `<div class="wk"><div class="empty" style="padding:70px 0 20px"><div style="font-size:48px">🎉</div><h2 style="margin:10px 0 6px">모든 운동을 마쳤어요</h2>총 ${n}종목 · ${sets}세트 완료</div>
      <button class="btn block" data-a="wPrev">↩ 마지막 세트로 돌아가기</button></div>
      <div class="wk-bottom"><button class="b-done" data-a="wFinish">운동 종료하고 저장</button></div>`;
  }
  const e = a.entries[a.ci], ex = exById(e.exId), resting = !!a.restEnd;
  const pid = ex && ex.photos && ex.photos[0];
  const img = pid && P[pid] ? `<img src="${P[pid]}" alt="">` : `<div class="ph">${esc(ex ? ex.part : '?')}<br><small>📷 탭해서 사진 추가</small></div>`;
  return head + `<div class="wk">
      <div class="wk-title">${esc(exName(e.exId))}</div>${ex ? `<span class="wk-tag">${esc(ex.part)}</span>` : ''}
      <div class="wk-img" ${ex ? `data-a="thumbPick" data-id="${esc(ex.id)}"` : ''}>${img}</div>
      ${ex ? memoCarousel(ex) : ''}
      ${ex ? `<div class="wk-tabs"><button data-a="anaOpen" data-id="${esc(ex.id)}">📊 기록 및 분석</button><button data-a="cautOpen" data-id="${esc(ex.id)}">⚠️ 주의사항</button></div>` : ''}
      ${setRows(a, e, ex)}
      ${resting ? `<div class="restpanel"><span style="font-size:13px">휴식</span><span class="tm" id="restTm">${fmtClock(a.restEnd - Date.now())}</span><button data-a="restAdj" data-v="-10">-10초</button><button data-a="restAdj" data-v="10">+10초</button></div>` : ''}
      <div style="height:12px"></div></div>
    <div class="wk-bottom">${resting ? '<button class="b-rest" data-a="restSkip">휴식 건너뛰기</button><button class="b-done" disabled>휴식 중…</button>'
      : '<button class="b-rest" data-a="wRest">휴식 타이머</button><button class="b-done" data-a="wSetDone">세트 완료</button>'}</div>`;
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
    if (left <= 0) { endRest(a); save(); beep(); render(); } // 휴식이 끝나면 다음 세트로
    else { const t = document.getElementById('restTm'); if (t) t.textContent = fmtClock(left); }
  }
}
setInterval(() => { if (S) tick(); }, 500);

function finishWorkout() {
  const a = S.active; if (!a) return;
  const entries = a.entries.map(e => {
    const ex = exById(e.exId);
    const o = { exId: e.exId, sets: e.sets.filter(s => s.done).map(s => ({ kg: isBw(ex) ? 0 : num(s.kg), reps: Math.round(num(s.reps)) })) };
    if (ex && ex.unit === 'lb') o.unit = 'lb';
    if (isTime(ex)) o.time = true;
    return o;
  }).filter(e => e.sets.length);
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

// ───────────────────────── 기록 및 분석 / 주의사항 (운동 진행 화면의 탭)
const deltaHtml = (cur, prev, dec) => {
  if (prev === undefined) return '';
  const d = Math.round((cur - prev) * 10 ** dec) / 10 ** dec;
  if (!d) return '<span class="dl">–</span>';
  return `<span class="dl ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'} ${d.toFixed(dec)}</span>`;
};
// 최근 5회 값을 점마다 값·날짜와 함께 보여 주는 꺾은선 그래프
function chart5(pts, dec) {
  const W = 320, H = 170, p = { l: 26, r: 26, t: 30, b: 30 }, n = pts.length;
  let mn = Math.min(...pts.map(x => x.v)), mx = Math.max(...pts.map(x => x.v));
  if (mn === mx) { mn -= 1; mx += 1; } else { const g = (mx - mn) * .15; mn -= g; mx += g; }
  const X = i => n === 1 ? W / 2 : p.l + (W - p.l - p.r) * i / (n - 1);
  const Y = v => p.t + (H - p.t - p.b) * (1 - (v - mn) / (mx - mn));
  const anc = i => n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle';
  const dx = i => n > 1 && i === 0 ? -14 : n > 1 && i === n - 1 ? 14 : 0;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 ${n}회 추이 그래프">
    <line x1="${p.l - 10}" x2="${W - p.r + 10}" y1="${H - p.b + 6}" y2="${H - p.b + 6}" style="stroke:var(--line)" stroke-dasharray="3 3"/>
    ${n > 1 ? `<polyline points="${pts.map((x, i) => `${X(i)},${Y(x.v)}`).join(' ')}" fill="none" stroke-width="2.5" stroke-linejoin="round" style="stroke:var(--accent)"/>` : ''}
    ${pts.map((x, i) => `<circle cx="${X(i)}" cy="${Y(x.v)}" r="4" style="fill:var(--accent)"/>
      <text x="${X(i) + dx(i)}" y="${Y(x.v) - 10}" text-anchor="${anc(i)}" font-size="10" font-weight="700" style="fill:var(--text)">${esc(x.v.toFixed(dec))}</text>
      <text x="${X(i) + dx(i)}" y="${H - 8}" text-anchor="${anc(i)}" font-size="9" style="fill:var(--sub)">${fmtDate(x.t)}</text>`).join('')}</svg>`;
}
function anaView(s) {
  const ex = exById(s.id);
  if (!ex) return topbar(backBtn, '기록 및 분석') + '<div class="empty">삭제된 운동입니다.</div>';
  const logs = logsFor(ex.id); // 최신순
  const time = isTime(ex), unit = unitOf(ex);
  const rows = logs.map(x => ({ t: x.log.start, vol: entryVol(x.entry), w: maxKg(x.entry.sets), rm: est1rm(x.entry), r: maxReps(x.entry),
    tot: x.entry.sets.reduce((a, st) => a + num(st.reps), 0) }));
  const hasW = rows.some(r => r.w > 0);
  const mk = (title, key, suf, dec, o = {}) => {
    const cur = rows[0][key], prev = rows[1] ? rows[1][key] : undefined, k = Math.min(5, rows.length);
    const pts = rows.slice(0, 5).reverse().map(r => ({ t: r.t, v: r[key] }));
    const avg = rows.slice(0, k).reduce((a, r) => a + r[key], 0) / k;
    return `<div class="a-card"><div class="a-h"><span>${title}</span><span class="a-d">${deltaHtml(cur, prev, dec)}</span><b>${cur.toFixed(dec)}${suf}</b></div>
      ${o.desc ? `<div class="a-desc">${o.desc}</div>` : ''}
      ${o.chart ? `<div class="chart">${chart5(pts, dec)}</div><div class="a-avg"><div><b>${avg.toFixed(dec)}</b><small>${suf}</small></div><span>최근 ${k}회 평균</span></div>` : ''}</div>`;
  };
  const volDesc = '운동 중 들어올린 총 무게 (무게 X 반복 횟수 X 세트)' + (ex.db ? '<br>덤벨 두 개 운동이라 ×2를 적용했습니다.' : '') + (ex.unit === 'lb' ? '<br>파운드 무게는 kg으로 환산했습니다.' : '');
  const cards = !rows.length ? '<div class="empty">아직 기록이 없어요.<br>운동을 완료하면 여기에 쌓입니다.</div>'
    : time ? mk('총 시간', 'tot', '초', 0, { desc: '운동 중 버틴 총 시간 (초 X 세트)', chart: true }) + mk('최대 시간', 'r', '초', 0)
    : hasW ? mk('볼륨', 'vol', 'kg', 1, { desc: volDesc, chart: true }) + mk('1RM', 'rm', unit, 1, { desc: '추정치 (무게 × (1 + 횟수 ÷ 30))' })
      + mk('최대 무게', 'w', unit, 1) + mk('최대 횟수', 'r', '회', 0)
    : mk('총 횟수', 'tot', '회', 0, { desc: '운동 중 반복한 총 횟수', chart: true }) + mk('최대 횟수', 'r', '회', 0);
  const recs = rows.length ? '<h2>기록</h2>' + logs.map(x => `<div class="log-date">${fmtDate(x.log.start)}</div>
    <div class="log-card">${x.entry.sets.map(st => `<div>${esc(setLine(st, x.entry))}</div>`).join('')}</div>`).join('') : '';
  return topbar(backBtn, ex.name) + `<div class="scroll" data-k="ana-${ex.id}">${cards}${recs}<div class="pad-bottom" style="height:40px"></div></div>`;
}
function cautView(s) {
  const ex = exById(s.id);
  if (!ex) return topbar(backBtn, '주의사항') + '<div class="empty">삭제된 운동입니다.</div>';
  const c = (ex.guide && ex.guide.caution) || [];
  return topbar(backBtn, ex.name) + `<div class="scroll" data-k="caut-${ex.id}"><h2>주의사항</h2>
    ${c.length ? c.map(x => `<div class="sect" style="padding:14px 16px;margin-top:10px;line-height:1.6">${esc(x)}</div>`).join('') : '<div class="hint">작성된 주의사항이 없습니다. 운동 상세 화면의 ✎에서 입력하세요.</div>'}
    <div class="pad-bottom" style="height:40px"></div></div>`;
}

// ───────────────────────── 기록 탭
function historyView() {
  const logs = [...S.logs].sort((a, b) => b.start - a.start);
  const now = new Date(); const mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - todayIdx());
  const week = logs.filter(l => l.start >= mon.getTime()).length;
  const avg = logs.length ? Math.round(logs.reduce((a, l) => a + (l.end - l.start), 0) / logs.length / 60000) : 0;
  const list = logs.map(l => {
    const sets = l.entries.reduce((a, e) => a + e.sets.length, 0); const vol = l.entries.reduce((a, e) => a + entryVol(e), 0);
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
    ${l.entries.map(e => `<div class="log-date" data-a="openEx" data-id="${esc(e.exId)}">${esc(exName(e.exId))}</div><div class="log-card">${e.sets.map(st => `<div>${esc(setLine(st, e))}</div>`).join('')}</div>`).join('')}
    <button class="btn danger block" style="margin-top:24px" data-a="delSess" data-id="${l.id}">이 기록 삭제</button><div class="pad-bottom" style="height:30px"></div></div>`;
}

// ───────────────────────── 운동 목록 탭
function libList() {
  const q = U.libQ.trim().toLowerCase();
  const list = S.exercises.filter(e => (U.libPart === '전체' || e.part === U.libPart) && (!q || e.name.toLowerCase().includes(q)));
  return list.map(e => `<div class="item" data-a="openEx" data-id="${esc(e.id)}">${thumb(e)}<div class="body"><div class="name">${esc(e.name)}</div>
    <div class="sub">${esc(e.part)}${e.memos.length ? ` · 📝 메모 ${e.memos.length}개` : ''}</div></div><span style="color:var(--sub)">›</span></div>`).join('') || '<div class="empty">검색 결과가 없습니다.</div>';
}
function libView() {
  return `${topbar('', '운동 목록', `<button class="icon-btn" data-a="newEx" aria-label="새 운동" style="font-size:26px;color:var(--accent)">＋</button>`)}
    <div class="scroll" data-k="lib"><input id="libQ" value="${esc(U.libQ)}" placeholder="운동 검색" style="margin-top:4px">
    <div class="chips" style="margin-top:10px">${['전체', ...PARTS].map(p => `<button class="chip ${U.libPart === p ? 'on' : ''}" data-a="libPart" data-v="${p}">${p}</button>`).join('')}</div>
    <div id="libList">${libList()}</div><div class="pad-bottom" style="height:30px"></div></div>`;
}

// ───────────────────────── 설정 탭
function diagText() {
  const pr = document.createElement('div');
  pr.style.cssText = 'position:fixed;left:0;bottom:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden';
  document.body.appendChild(pr); const sb = parseFloat(getComputedStyle(pr).paddingBottom) || 0; pr.remove();
  const st = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const vv = window.visualViewport ? Math.round(window.visualViewport.height) : '-';
  return `홈 화면 앱(standalone): ${st ? '예' : '아니오'}<br>창 ${innerWidth}×${innerHeight} · 화면 ${screen.width}×${screen.height}<br>visualViewport 높이 ${vv} · 하단 안전영역 ${sb}`;
}
function settingsView() {
  return `${topbar('', '설정', '')}<div class="scroll" data-k="set">
    <div class="card"><label style="margin-top:0">기본 휴식 시간 (초)</label><input id="restSec" inputmode="numeric" value="${S.settings.rest}"></div>
    <div class="card"><div style="font-weight:700;margin-bottom:6px">데이터 백업</div>
      <div class="hint">기록은 로그인한 계정의 클라우드에 저장되어 Mac과 아이폰에서 함께 쓸 수 있습니다. 만일을 위해 가끔 내보내기로 파일 백업도 해 두세요.</div>
      <div class="row" style="margin-top:12px"><button class="btn" data-a="export">내보내기</button>
      <label class="btn" style="text-align:center;cursor:pointer">가져오기<input type="file" accept="application/json,.json" id="importIn" style="display:none"></label></div></div>
    <div class="card"><div style="font-weight:700;margin-bottom:6px">계정 · 동기화</div><div class="hint" id="storeInfo">계정: ${esc(AUTH.user ? AUTH.user.email : '-')}<br>기록 ${S.logs.length}회 · 운동 ${S.exercises.length}개</div>
      <button class="btn block" style="margin-top:10px" data-a="logout">로그아웃</button></div>
    <div class="card"><div style="font-weight:700;margin-bottom:6px">화면 진단</div><div class="hint">${diagText()}</div></div>
    <div class="card"><div style="font-weight:700;margin-bottom:6px">기본 가이드 복원</div>
      <div class="hint">기본 운동 목록에서 빠진 항목을 다시 추가합니다. 수정한 가이드·메모는 유지됩니다.</div>
      <button class="btn block" style="margin-top:10px" data-a="restoreDefaults">복원</button></div>
    <div class="card"><div style="font-weight:700;margin-bottom:6px">화~토 기본 플랜 다시 적용</div>
      <div class="hint">참고 앱 기준의 요일별 운동 계획을 다시 넣습니다. 지금 입력된 화~토요일 플랜은 <b>모두 덮어씁니다</b>. (월요일·일요일은 그대로)</div>
      <button class="btn block" style="margin-top:10px" data-a="applyPlans">덮어쓰기</button></div>
    <button class="btn danger block" style="margin-top:18px" data-a="reset">모든 데이터 초기화</button>
    <div class="hint" style="text-align:center;margin-top:16px">운동기록 · 빌드 v11 · 개인용</div><div class="pad-bottom" style="height:30px"></div></div>`;
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
    const ex = exById(it.exId);
    inner = `<h3>${esc(exName(it.exId))}</h3><div class="row">
      <div><label>세트</label><input id="fSets" inputmode="numeric" value="${it.sets}"></div>
      ${isBw(ex) ? '' : `<div><label>무게(${unitOf(ex)})</label><input id="fKg" inputmode="decimal" value="${kgText(it.kg)}"></div>`}
      <div><label>${isTime(ex) ? '시간(초)' : '횟수'}</label><input id="fReps" inputmode="numeric" value="${it.reps}"></div></div>
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
      <label>무게 단위</label><select id="eUnit"><option value="kg" ${ex && ex.unit === 'lb' ? '' : 'selected'}>kg</option><option value="lb" ${ex && ex.unit === 'lb' ? 'selected' : ''}>lbs (파운드)</option></select>
      <label class="chk"><input type="checkbox" id="eDb" ${ex && ex.db ? 'checked' : ''}> 덤벨을 양손에 하나씩 듭니다 (화면에 '덤벨 한 개당', 볼륨 ×2)</label>
      <label class="chk"><input type="checkbox" id="eBw" ${ex && ex.bw ? 'checked' : ''}> 맨몸 운동 (무게를 입력하지 않음)</label>
      <label class="chk"><input type="checkbox" id="eTime" ${ex && ex.mode === 'time' ? 'checked' : ''}> 시간(초)으로 기록하는 운동</label>
      <div class="row" style="margin-top:18px">${ex ? '<button class="btn danger" data-a="delEx">삭제</button>' : ''}<button class="btn primary" data-a="saveEx">저장</button></div>`;
  } else if (s.t === 'memo') {
    const ex = exById(s.id); if (!ex) return '';
    inner = `<h3>${s.i == null ? '새 메모' : '메모 수정'} · ${esc(ex.name)}</h3>
      <textarea id="memoTxt" rows="5" placeholder="예: 시트 3칸, 핀 위치, 팔꿈치 느낌 등">${esc(s.i == null ? '' : ex.memos[s.i])}</textarea>
      <div class="row" style="margin-top:14px">${s.i == null ? '' : '<button class="btn danger" data-a="memoDel">삭제</button>'}<button class="btn primary" data-a="memoSave">저장</button></div>`;
  } else if (s.t === 'wlist') {
    const a = S.active; if (!a) return '';
    const cur = a.entries[a.ci];
    inner = `<h3>오늘 운동 목록</h3>${a.entries.map((e, k) => { const dn = e.sets.filter(x => x.done).length;
      return `<button class="pick" data-a="wGo" data-w="${k}"><span>${k === a.ci ? '▶ ' : ''}${esc(exName(e.exId))}</span><small>${dn}/${e.sets.length}${dn === e.sets.length ? ' ✓' : ''}</small></button>`; }).join('')}
      <button class="btn block" style="margin-top:14px" data-a="wAddEx">＋ 운동 추가</button>
      ${cur ? `<div class="row" style="margin-top:10px"><button class="btn" data-a="wAddSet">＋ 세트 (${esc(exName(cur.exId))})</button><button class="btn" data-a="wDelSet">－ 세트</button></div>` : ''}
      <button class="btn block" style="margin-top:10px" data-a="wPrev">↩ 이전 세트로 되돌리기</button>
      <button class="btn primary block" style="margin-top:10px" data-a="wFinish">운동 종료하고 저장</button>`;
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
      const kgEl = document.getElementById('fKg'); if (kgEl) it.kg = num(kgEl.value); // 맨몸·시간 운동은 무게 칸이 없음
      it.reps = Math.max(1, Math.round(num(document.getElementById('fReps').value)) || 1);
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
    case 'openEx': { const ex = exById(id); if (!ex) break; U.stack.push({ t: 'ex', id, tab: 'rec', sub: ex.memos.length ? 'memo' : 'guide', metric: 'kg' }); break; }
    case 'anaOpen': U.stack.push({ t: 'ana', id }); break;
    case 'cautOpen': U.stack.push({ t: 'caut', id }); break;
    case 'memoAdd': U.sheet = { t: 'memo', id, i: null }; break;
    case 'memoEdit': U.sheet = { t: 'memo', id, i }; break;
    case 'memoSave': {
      const s = U.sheet, ex = exById(s.id), txt = document.getElementById('memoTxt').value.trim();
      if (!txt) { toast('내용을 입력하세요'); return; }
      if (s.i == null) { ex.memos.push(txt); U.memoPos[ex.id] = ex.memos.length - 1; } else ex.memos[s.i] = txt;
      U.sheet = null; save(); break;
    }
    case 'memoDel': {
      const s = U.sheet, ex = exById(s.id);
      if (ex && s.i != null && confirm('이 메모를 삭제할까요?')) { ex.memos.splice(s.i, 1); U.memoPos[ex.id] = Math.max(0, Math.min(U.memoPos[ex.id] || 0, ex.memos.length - 1)); U.sheet = null; save(); }
      break;
    }
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
    case 'wSetDone': { // 세트 완료 → (마지막 세트가 아니면) 휴식 자동 시작, 마지막 세트면 바로 다음 운동
      const a = S.active, e = a.entries[a.ci]; if (!e || a.restEnd) break;
      e.sets[a.si].done = true;
      try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (er) { /* ignore */ }
      if (a.si < e.sets.length - 1) a.restEnd = Date.now() + S.settings.rest * 1000; else advance(a);
      save(); break;
    }
    case 'wRest': { const a = S.active; if (a && !a.restEnd) { a.restEnd = Date.now() + S.settings.rest * 1000; save(); } break; } // 세트를 마치지 않고 휴식만 시작
    case 'wPick': { const a = S.active; if (a && !a.restEnd) a.si = +el.dataset.s; break; }
    case 'wEx': { const a = S.active; gotoEx(a, a.ci + (+v)); save(); break; }
    case 'wGo': gotoEx(S.active, +el.dataset.w); U.sheet = null; save(); break;
    case 'wList': U.sheet = { t: 'wlist' }; break;
    case 'wPrev': { // 이전 세트로 되돌리고 완료 표시를 취소
      const a = S.active; a.restEnd = null;
      if (a.ci >= a.entries.length) { a.ci = a.entries.length - 1; a.si = a.entries[a.ci].sets.length - 1; }
      else if (a.si > 0) a.si--;
      else if (a.ci > 0) { a.ci--; a.si = a.entries[a.ci].sets.length - 1; }
      a.entries[a.ci].sets[a.si].done = false; U.sheet = null; save(); break;
    }
    case 'wAddSet': { const a = S.active, e = a.entries[Math.min(a.ci, a.entries.length - 1)]; const l = e.sets[e.sets.length - 1] || { kg: 0, reps: 10 }; e.sets.push({ kg: l.kg, reps: l.reps, done: false }); save(); break; }
    case 'wDelSet': { const a = S.active, e = a.entries[Math.min(a.ci, a.entries.length - 1)]; if (e.sets.length > 1) { e.sets.pop(); a.si = Math.min(a.si, e.sets.length - 1); } save(); break; }
    case 'wFinish': U.sheet = null; finishWorkout(); break;
    case 'restAdj': S.active.restEnd = Math.max(Date.now() + 1000, S.active.restEnd + (+v) * 1000); save(); break;
    case 'restSkip': endRest(S.active); save(); break;
    case 'applyPlans':
      if (confirm('화~토요일 플랜을 기본 플랜으로 덮어씁니다. 지금 입력된 화~토 플랜은 사라집니다. 계속할까요?')) {
        for (let k = 1; k <= 5; k++) S.plan[k] = { title: DEFAULT_PLANS[k].title, items: planItems(DEFAULT_PLANS[k]) };
        const miss = ensureDefaultExercises(S); save(); toast(`화~토 플랜을 적용했습니다${miss ? ` (운동 ${miss}개 추가)` : ''}`);
      }
      break;
    case 'sess': U.stack.push({ t: 'sess', id }); break;
    case 'delSess': if (confirm('이 운동 기록을 삭제할까요?')) { S.logs = S.logs.filter(l => l.id !== id); removeLog(id); U.stack.pop(); save(); } break;
    case 'export': exportData(); return;
    case 'restoreDefaults': {
      const n = ensureDefaultExercises(S);
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
  const opt = { unit: document.getElementById('eUnit').value === 'lb' ? 'lb' : undefined, db: document.getElementById('eDb').checked || undefined,
    bw: document.getElementById('eBw').checked || undefined, mode: document.getElementById('eTime').checked ? 'time' : undefined };
  if (s.id) { const ex = exById(s.id); Object.assign(ex, { name, part, guide }, opt); U.sheet = null; save(); render(); return; }
  const ex = { id: 'c-' + uid(), name, part, guide, memos: [], photos: [], ...opt }; S.exercises.push(ex);
  if (s.forTarget) { U.sheet = { ctx: s.forTarget }; addToTarget(ex.id); return; }
  U.sheet = null; save(); render();
}

// 입력 이벤트(리렌더 없이 상태만 갱신)
document.addEventListener('input', ev => {
  if (!ready()) return;
  const t = ev.target;
  if (t.dataset && t.dataset.f && S.active) { S.active.entries[+t.dataset.w].sets[+t.dataset.s][t.dataset.f] = t.value; save(); }
  else if (t.id === 'dayTitle') { S.plan[U.day].title = t.value; save(); }
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
// 기본 운동 목록과 맞추기: 빠진 운동 추가, 이름 변경(직접 바꾸지 않은 것만), 표시 옵션 채우기. 추가한 운동 수를 돌려줍니다.
function ensureDefaultExercises(s) {
  let n = 0;
  DEFAULT_EXERCISES.forEach(d => {
    const ex = s.exercises.find(e => e.id === d.id);
    if (!ex) { s.exercises.push({ ...d, memos: [], photos: [] }); n++; return; }
    const rn = EX_RENAMES[d.id]; if (rn && ex.name === rn[0]) ex.name = rn[1];
    ['db', 'unit', 'mode', 'bw'].forEach(k => { if (d[k] !== undefined && ex[k] === undefined) ex[k] = d[k]; });
  });
  return n;
}
// 데이터 형식 이전 (한 번만 실행). 사용자가 이미 입력한 요일 플랜은 건드리지 않습니다.
function migrate(s) {
  if ((s.mig || 0) >= MIG) return;
  ensureDefaultExercises(s);
  if (s.settings.rest === 90) s.settings.rest = REST_DEFAULT; // 옛 기본값(90초)이면 50초로
  DEFAULT_PLANS.forEach((d, k) => { const p = s.plan[k]; if (p && d.items.length && !p.items.length && !p.title) { p.title = d.title; p.items = planItems(d); } }); // 비어 있는 요일만
  const ic = s.plan[0].items.find(x => x.exId === 'incline-db-curl'); if (ic && ic.sets === 3 && ic.kg === 6 && ic.reps === 10) ic.reps = 12; // 확인되지 않았던 임의 값 보정
  s.mig = MIG;
}
function normalizeState(s) {
  s.settings = s.settings || { rest: REST_DEFAULT }; s.active = s.active || null; s.logs = s.logs || [];
  s.exercises.forEach(e => { e.photos = e.photos || []; if (!Array.isArray(e.memos)) e.memos = e.memo ? [e.memo] : []; delete e.memo; }); // 메모 한 개 → 여러 개
  const a = s.active; // 진행 중이던 운동이 이전 형식이면 현재 위치(운동·세트)를 계산
  if (a && typeof a.ci !== 'number') {
    a.ci = a.entries.findIndex(e => e.sets.some(x => !x.done)); if (a.ci < 0) a.ci = a.entries.length;
    a.si = a.ci < a.entries.length ? firstUndone(a.entries[a.ci]) : 0;
  }
  migrate(s);
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
    let raw; try { raw = JSON.parse(snap.data().json); } catch (e) { return fail(e); }
    const needMig = (raw.mig || 0) < MIG;
    try { S = normalizeState({ ...raw, logs: cloudLogs }); } catch (e) { return fail(e); }
    if (needMig) writeState(); // 이전된 형식을 바로 저장
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
setInterval(() => { if (AUTH.status === 'in' && !ready()) render(); }, 1500); // 로딩 진단 표시 갱신
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
render();
