const CACHE = 'workout-v6';
const FILES = ['./', './index.html', './style.css', './data.js', './app.js', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];

const FB = ['firebase-app', 'firebase-auth', 'firebase-firestore'].map(n => `https://www.gstatic.com/firebasejs/10.14.1/${n}.js`);
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(FILES);
    // Firebase 모듈도 미리 저장해 두면 오프라인(헬스장)에서도 앱이 열립니다. 실패해도 설치는 계속합니다.
    await Promise.all(FB.map(u => c.add(new Request(u, { mode: 'cors' })).catch(() => { })));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 네트워크 우선, 실패(오프라인) 시 캐시 사용 → 파일을 업데이트하면 다음 실행 때 바로 반영됩니다.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const host = new URL(e.request.url).hostname;
  // Firebase 인증/Firestore 통신은 SDK가 직접 처리하므로 캐시하지 않습니다.
  if (host.endsWith('googleapis.com') || host.endsWith('firebaseio.com') || host.endsWith('firebaseapp.com')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
