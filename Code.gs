// ============================================================
// 업무일지 PWA 백엔드 (Google Apps Script)
//
// 사용법:
// 1. 새 구글 스프레드시트를 만든다.
// 2. 확장 프로그램 > Apps Script 를 연다.
// 3. 기본 생성된 코드를 지우고 이 파일 내용을 전부 붙여넣는다.
// 4. 아래 TOKEN 값을 아무도 모를 문자열로 바꾼다 (앱 설정 화면에도 같은 값을 넣어야 함).
//    이 토큰은 강력한 보안 비밀값이 아니라, 공개된 웹앱 URL에 대한 무차별 접근을
//    막는 정도의 목적이다.
// 5. 저장 후 "배포 > 새 배포" > 유형: 웹 앱
//    - 실행 계정: 나
//    - 액세스 권한이 있는 사용자: 모든 사용자 (중요)
//      "나만"으로 하면 앱(브라우저)에서 보내는 요청이 로그인 화면으로
//      막혀서 동기화가 안 됨. URL 자체가 추측 불가능한 긴 값이라
//      "모든 사용자"로 열어도 URL을 모르면 접근할 수 없음.
// 6. 배포 후 나오는 웹 앱 URL과, 4번에서 정한 토큰을 앱의 "설정" 탭에 붙여넣는다.
//    (app.js를 직접 고치지 않아도 앱 안에서 바로 등록 가능)
// 7. 배포 후 처음 한 번은 권한 승인 화면이 뜬다. 본인 계정이므로 승인하면 됨.
//
// 코드를 고친 뒤에는 "배포 관리 > 편집(연필) > 버전: 새 버전"으로 다시 배포해야
// 실제로 반영된다. (URL은 그대로 유지됨)
// ============================================================

const TOKEN = "여기를_바꿔줘_아무도_모를_문자열";

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

function dateKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return Utilities.formatDate(value, tz, "yyyy-MM-dd");
  }
  const s = String(value == null ? "" : value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

function readAllRows_(sheet, headers) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(c => c === "")) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      const value = row[idx];
      if (h === "date") obj[h] = dateKey_(value);
      else if (h === "updatedAt") obj[h] = value instanceof Date ? value.getTime() : (Number(value) || 0);
      else if (h === "deleted") obj[h] = value === true || String(value).toLowerCase() === "true" || value === "Y";
      else obj[h] = value;
    });
    rows.push(obj);
  }
  return rows;
}

function findRowIndexById_(sheet, idCol, idValue) {
  const values = sheet.getDataRange().getValues();
  const target = String(idValue == null ? "" : idValue);
  const compareAsDate = /^\d{4}-\d{2}-\d{2}$/.test(target);
  for (let i = 1; i < values.length; i++) {
    const cell = values[i][idCol];
    const actual = compareAsDate ? dateKey_(cell) : String(cell == null ? "" : cell);
    if (actual === target) return i + 1; // 1-based sheet row
  }
  return -1;
}

// action을 실제 시트에 반영한다. 이미 서버에 더 최신(updatedAt이 더 큰) 데이터가
// 있으면 들어온 요청은 무시(skip)한다 - 오래된 클라이언트 요청이 최신 데이터를
// 덮어쓰는 것을 막기 위함.
function applyAction_(action, payload) {
  const incomingUpdatedAt = Number(payload.updatedAt) || Date.now();

  if (action === "ADD_LOG" || action === "UPDATE_LOG") {
    const sheet = getSheet_(LOG_SHEET, LOG_HEADERS);
    const idx = findRowIndexById_(sheet, 0, payload.id);
    if (idx !== -1) {
      const existing = sheet.getRange(idx, 1, 1, LOG_HEADERS.length).getValues()[0];
      const existingUpdatedAt = Number(existing[5]) || 0; // updatedAt 컬럼(6번째)
      if (existingUpdatedAt > incomingUpdatedAt) return { skipped: true };
    }
    const row = LOG_HEADERS.map(h => payload[h] !== undefined ? payload[h] : "");
    if (idx === -1) {
      sheet.appendRow(row);
    } else {
      sheet.getRange(idx, 1, 1, LOG_HEADERS.length).setValues([row]);
    }
    return { skipped: false };

  } else if (action === "DELETE_LOG") {
    const sheet = getSheet_(LOG_SHEET, LOG_HEADERS);
    const idx = findRowIndexById_(sheet, 0, payload.id);
    if (idx === -1) return { skipped: true }; // 삭제할 원본 자체가 없음
    const existing = sheet.getRange(idx, 1, 1, LOG_HEADERS.length).getValues()[0];
    const existingUpdatedAt = Number(existing[5]) || 0;
    if (existingUpdatedAt > incomingUpdatedAt) return { skipped: true };
    sheet.getRange(idx, 7).setValue(true);              // deleted 컬럼
    sheet.getRange(idx, 6).setValue(incomingUpdatedAt);  // updatedAt 컬럼
    return { skipped: false };

  } else if (action === "UPSERT_REFLECTION") {
    const sheet = getSheet_(REFL_SHEET, REFL_HEADERS);
    const idx = findRowIndexById_(sheet, 0, payload.date);
    if (idx !== -1) {
      const existing = sheet.getRange(idx, 1, 1, REFL_HEADERS.length).getValues()[0];
      const existingUpdatedAt = Number(existing[5]) || 0; // updatedAt 컬럼(6번째)
      if (existingUpdatedAt > incomingUpdatedAt) return { skipped: true };
    }
    const row = REFL_HEADERS.map(h => payload[h] !== undefined ? payload[h] : "");
    if (idx === -1) {
      sheet.appendRow(row);
    } else {
      sheet.getRange(idx, 1, 1, REFL_HEADERS.length).setValues([row]);
    }
    return { skipped: false };
  }
  return { skipped: true };
}

function checkToken_(e) {
  return !!(e && e.parameter && e.parameter.token === TOKEN);
}

function doGet(e) {
  const action = (e.parameter.action || "getAll");

  if (!checkToken_(e)) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "토큰이 올바르지 않아" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 쓰기 동작(ADD_LOG 등)도 GET으로 처리한다.
  // 이유: Apps Script 웹앱은 POST 요청에도 내부적으로 302 리다이렉트를 거치는데,
  // 브라우저 fetch가 이 리다이렉트를 따라가면서 POST를 GET으로 바꾸고 body를
  // 날려버리는 경우가 있어 doPost가 아예 호출되지 않을 수 있다. GET은 이 문제가 없다.
  if (action !== "getAll" && e.parameter.payload) {
    try {
      const payload = JSON.parse(e.parameter.payload);
      const result = applyAction_(action, payload);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, skipped: !!result.skipped }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (action === "getAll") {
    const logSheet = getSheet_(LOG_SHEET, LOG_HEADERS);
    const reflSheet = getSheet_(REFL_SHEET, REFL_HEADERS);
    // 삭제된(tombstone) 로그도 그대로 포함해서 반환한다.
    // 다른 기기가 "이 항목이 삭제됐다"는 사실을 알아야 자기 local 캐시에서도 지울 수 있다.
    // 화면에 삭제된 항목이 보이지 않게 하는 처리는 클라이언트(app.js의 mergeServerData)가 한다.
    const logs = readAllRows_(logSheet, LOG_HEADERS);
    const reflRows = readAllRows_(reflSheet, REFL_HEADERS);
    const reflections = {};
    reflRows.forEach(r => {
      if (!r.date) return;
      const prev = reflections[r.date];
      if (!prev || Number(r.updatedAt || 0) >= Number(prev.updatedAt || 0)) {
        reflections[r.date] = r;
      }
    });
    return ContentService.createTextOutput(JSON.stringify({ ok: true, logs, reflections }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "unknown action" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  // 이 프로젝트의 클라이언트는 더 이상 POST를 사용하지 않는다.
  // (Apps Script 웹앱의 내부 리다이렉트 과정에서 POST body가 사라지는 문제 때문)
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "POST는 지원하지 않아. GET을 사용해줘." }))
    .setMimeType(ContentService.MimeType.JSON);
}
