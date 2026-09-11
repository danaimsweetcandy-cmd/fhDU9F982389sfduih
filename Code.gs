// ============================================================
// 업무일지 PWA 백엔드 (Google Apps Script)
//
// 사용법:
// 1. 새 구글 스프레드시트를 만든다.
// 2. 확장 프로그램 > Apps Script 를 연다.
// 3. 기본 생성된 코드를 지우고 이 파일 내용을 전부 붙여넣는다.
// 4. 저장 후 "배포 > 새 배포" > 유형: 웹 앱
//    - 실행 계정: 나
//    - 액세스 권한이 있는 사용자: 모든 사용자 (중요)
//      "나만"으로 하면 앱(브라우저)에서 보내는 요청이 로그인 화면으로
//      막혀서 동기화가 안 됨. URL 자체가 추측 불가능한 긴 값이라
//      "모든 사용자"로 열어도 URL을 모르면 접근할 수 없음.
// 5. 배포 후 나오는 웹 앱 URL을 앱의 "설정" 탭에 붙여넣는다.
//    (app.js를 직접 고치지 않아도 앱 안에서 바로 등록 가능)
// 6. 배포 후 처음 한 번은 권한 승인 화면이 뜬다. 본인 계정이므로 승인하면 됨.
// ============================================================

const LOG_SHEET = "Log";
const REFL_SHEET = "Reflection";
const LOG_HEADERS = ["id", "date", "time", "cat", "content", "updatedAt", "deleted"];
const REFL_HEADERS = ["date", "summary", "difficulty", "achievement", "tomorrow", "updatedAt"];

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function readAllRows_(sheet, headers) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(c => c === "")) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = row[idx]; });
    rows.push(obj);
  }
  return rows;
}

function findRowIndexById_(sheet, idCol, idValue) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][idCol] === idValue) return i + 1; // 1-based sheet row
  }
  return -1;
}

function applyAction_(action, payload) {
  if (action === "ADD_LOG" || action === "UPDATE_LOG") {
    const sheet = getSheet_(LOG_SHEET, LOG_HEADERS);
    const idx = findRowIndexById_(sheet, 0, payload.id);
    const row = LOG_HEADERS.map(h => payload[h] !== undefined ? payload[h] : "");
    if (idx === -1) {
      sheet.appendRow(row);
    } else {
      sheet.getRange(idx, 1, 1, LOG_HEADERS.length).setValues([row]);
    }
  } else if (action === "DELETE_LOG") {
    const sheet = getSheet_(LOG_SHEET, LOG_HEADERS);
    const idx = findRowIndexById_(sheet, 0, payload.id);
    if (idx !== -1) {
      sheet.getRange(idx, 7).setValue(true); // deleted 컬럼
      sheet.getRange(idx, 6).setValue(payload.updatedAt || Date.now());
    }
  } else if (action === "UPSERT_REFLECTION") {
    const sheet = getSheet_(REFL_SHEET, REFL_HEADERS);
    const idx = findRowIndexById_(sheet, 0, payload.date);
    const row = REFL_HEADERS.map(h => payload[h] !== undefined ? payload[h] : "");
    if (idx === -1) {
      sheet.appendRow(row);
    } else {
      sheet.getRange(idx, 1, 1, REFL_HEADERS.length).setValues([row]);
    }
  }
}

function doGet(e) {
  const action = (e.parameter.action || "getAll");

  // 쓰기 동작(ADD_LOG 등)도 GET으로 처리한다.
  // 이유: Apps Script 웹앱은 POST 요청에도 내부적으로 302 리다이렉트를 거치는데,
  // 브라우저 fetch가 이 리다이렉트를 따라가면서 POST를 GET으로 바꾸고 body를
  // 날려버리는 경우가 있어 doPost가 아예 호출되지 않을 수 있다. GET은 이 문제가 없다.
  if (action !== "getAll" && e.parameter.payload) {
    try {
      const payload = JSON.parse(e.parameter.payload);
      applyAction_(action, payload);
      return ContentService.createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (action === "getAll") {
    const logSheet = getSheet_(LOG_SHEET, LOG_HEADERS);
    const reflSheet = getSheet_(REFL_SHEET, REFL_HEADERS);
    const logs = readAllRows_(logSheet, LOG_HEADERS).filter(l => !l.deleted);
    const reflRows = readAllRows_(reflSheet, REFL_HEADERS);
    const reflections = {};
    reflRows.forEach(r => { reflections[r.date] = r; });
    return ContentService.createTextOutput(JSON.stringify({ logs, reflections }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(JSON.stringify({ error: "unknown action" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  applyAction_(body.action, body.payload);
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
