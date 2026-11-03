# 운동기록 (PWA)
- 앱 파일: `docs/` (index.html, app.js, data.js, style.css, sw.js, manifest, icons)
- 로컬 확인: `cd docs && python3 -m http.server 8765` → http://localhost:8765
- 아이폰 설치: HTTPS 주소를 Safari로 열기 → 공유 → '홈 화면에 추가'
- 데이터는 기기의 IndexedDB에 저장 → 설정 탭에서 주기적으로 백업(내보내기)
- 서비스워커 캐시: sw.js의 CACHE 값을 올리면 업데이트 강제 가능
