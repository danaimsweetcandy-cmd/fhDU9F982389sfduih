# 업무일지 PWA v7

기존 v6의 시간 정규화와 히스토리 전체 수정 기능을 유지하면서, 출시 직전 동기화/복구/UX 안전장치를 추가한 버전.

## 배포 순서

1. 기존 저장소의 `icons/icon-192.png`, `icons/icon-512.png`는 그대로 유지한다.
2. 이 폴더의 `index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js`, `screenshots/`를 GitHub Pages 저장소에 덮어쓴다.
3. Google Sheets Apps Script에서 기존 코드를 `Code.gs` 전체 내용으로 교체한다.
4. `Code.gs` 맨 위 `TOKEN`을 기존 토큰으로 맞춘다.
5. Apps Script에서 `setup()`을 한 번 실행한다. 기존 `로그`/`회고` 또는 호환되는 기존 시트의 데이터는 보존하면서 새 메타 컬럼을 추가한다.
6. 배포 관리에서 웹 앱을 **새 버전**으로 배포한다. 실행 계정은 나, 액세스 권한은 반드시 **모든 사용자**.
7. 앱 설정에서 `연결 확인` 후 `전체 다시 맞추기`를 한 번 실행한다.

## 중요

- 모든 쓰기는 계속 **GET + query string**이다. POST는 비활성화되어 있다.
- 서비스워커 캐시는 `worklog-cache-v7`이다.
- 기존 `worklog_logs`, `worklog_reflections`, `worklog_outbox`, GAS URL/토큰 키를 읽어서 v7 데이터로 마이그레이션한다.
- 삭제는 tombstone으로 유지하고 서버에서 확인되기 전에는 사라지지 않는다.
- 회고는 필드별 버전으로 동기화해 다른 기기에서 서로 다른 회고 칸을 편집해도 한 덩어리로 덮어쓰는 위험을 줄였다.
- 회고 필드는 GET URL 안전성을 위해 각 칸 최대 500자로 제한한다.

## v7 핵심 변경

- queueId 기반 persistent outbox, single-flight, in-flight 변경 보존
- 삭제 tombstone + Undo, 회고 outbox 즉시 기록
- `updatedAt + deviceId` 충돌 판정, 서버 revision/cursor 증분 동기화
- 서버 LockService, validation, idempotent upsert
- timeout, retry/backoff, wrong-app/wrong-sheet 연결 차단
- 오늘 화면에서도 시간/종류/내용 통합 수정
- 날짜 rollover, 입력시간 자동 갱신, draft 복구
- 날짜/시간/종류/내용/회고 전체 검색
- JSON 백업/복원 + CSV, 데이터 진단
- 접근성, 48px급 터치 영역, safe-area, 확대/landscape/multi-window 대응
- 서비스워커의 가짜 API 성공응답 제거, navigation만 index fallback

## 아이콘

현재 제공받은 파일 묶음에는 실제 아이콘 바이너리가 없어 기존 `icon-192.png`, `icon-512.png`를 그대로 사용한다. 기존 512px 아이콘의 `any maskable` 선언은 유지했다. 브랜드 원본 아이콘을 확보하면 별도 `icon-maskable.png`로 분리하는 것이 다음 권장 작업이다.
