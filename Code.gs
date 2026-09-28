// ============================================================
// 업무일지 PWA v8.1 백엔드
// 기존 Log / Reflection 시트를 그대로 사용하며, 새 컬럼은 오른쪽에만 추가한다.
// 모든 쓰기는 GET + query string 방식만 사용한다.
// ============================================================

const TOKEN = "여기를_기존_토큰과_같게_바꿔줘";

const LOG_SHEET = "Log";
const REFL_SHEET = "Reflection";
const LOG_HEADERS = [
  "id", "date", "time", "cat", "content", "updatedAt", "deleted",
  "origin", "requester", "requestedAt", "dueDate", "project", "memo",
  "highlight", "status", "actualStartedAt"
];
const REFL_HEADERS = ["date", "summary", "difficulty", "achievement", "tomorrow", "updatedAt"];

function getSheet_(name, wantedHeaders) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, wantedHeaders.length).setValues([wantedHeaders]);
    return sheet;
  }
  ensureHeaders_(sheet, wantedHeaders);
  return sheet;
}

// 기존 컬럼과 데이터는 건드리지 않고, 없는 헤더만 맨 오른쪽에 추가한다.
function ensureHeaders_(sheet, wantedHeaders) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  let existing = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(v => String(v || "").trim());
  if (existing.length === 1 && existing[0] === "" && sheet.getLastRow() === 0) existing = [];
  const missing = wantedHeaders.filter(h => !existing.includes(h));
  if (!missing.length) return;
  sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
}

function headerMap_(sheet) {
  const n = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, n).getDisplayValues()[0].map(v => String(v || "").trim());
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i; });
  return { headers, map };
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

function timeKey_(rawValue, displayValue) {
  const displayed = String(displayValue == null ? "" : displayValue).trim();
  let m = displayed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return String(Number(m[1])).padStart(2, "0") + ":" + m[2];
  m = displayed.match(/^(오전|오후|AM|PM)\s*(\d{1,2}):(\d{2})(?::\d{2})?$/i);
  if (m) {
    let h = Number(m[2]) % 12;
    const pm = m[1] === "오후" || String(m[1]).toUpperCase() === "PM";
    if (pm) h += 12;
    return String(h).padStart(2, "0") + ":" + m[3];
  }
  const raw = String(rawValue == null ? "" : rawValue).trim();
  m = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return m ? String(Number(m[1])).padStart(2, "0") + ":" + m[2] : raw;
}

function bool_(v) { return v === true || v === "Y" || String(v).toLowerCase() === "true"; }
function readAllRows_(sheet, wantedHeaders) {
  ensureHeaders_(sheet, wantedHeaders);
  const hm = headerMap_(sheet);
  const values = sheet.getDataRange().getValues();
  const displays = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  const out = [];
  for (let r = 1; r < values.length; r++) {
    if (values[r].every(c => c === "")) continue;
    const obj = {};
    wantedHeaders.forEach(h => {
      const i = hm.map[h];
      if (i === undefined) { obj[h] = ""; return; }
      const v = values[r][i];
      if (h === "date" || h === "dueDate") obj[h] = dateKey_(v);
      else if (h === "time") obj[h] = timeKey_(v, displays[r][i]);
      else if (h === "updatedAt") obj[h] = v instanceof Date ? v.getTime() : (Number(v) || 0);
      else if (h === "deleted" || h === "highlight") obj[h] = bool_(v);
      else obj[h] = v == null ? "" : v;
    });
    out.push(obj);
  }
  return out;
}

function findRowByValue_(sheet, header, value) {
  const hm = headerMap_(sheet);
  const col = hm.map[header];
  if (col === undefined) return -1;
  const values = sheet.getDataRange().getValues();
  const target = String(value == null ? "" : value);
  for (let r = 1; r < values.length; r++) {
    const actual = header === "date" ? dateKey_(values[r][col]) : String(values[r][col] == null ? "" : values[r][col]);
    if (actual === target) return r + 1;
  }
  return -1;
}

function getCellValue_(sheet, row, header) {
  const hm = headerMap_(sheet);
  const col = hm.map[header];
  if (col === undefined) return "";
  return sheet.getRange(row, col + 1).getValue();
}

function writeObjectRow_(sheet, rowNum, wantedHeaders, obj) {
  ensureHeaders_(sheet, wantedHeaders);
  const hm = headerMap_(sheet);
  const width = hm.headers.length;
  const existing = rowNum > 0 ? sheet.getRange(rowNum, 1, 1, width).getValues()[0] : new Array(width).fill("");
  wantedHeaders.forEach(h => {
    const i = hm.map[h];
    if (i !== undefined) existing[i] = obj[h] !== undefined ? obj[h] : "";
  });
  if (rowNum > 0) sheet.getRange(rowNum, 1, 1, width).setValues([existing]);
  else {
    sheet.appendRow(existing);
    rowNum = sheet.getLastRow();
  }
  // 날짜/시간/새 날짜형 문자열은 텍스트로 고정해 로캘 자동변환을 막는다.
  ["date", "time", "requestedAt", "dueDate", "actualStartedAt"].forEach(h => {
    const i = hm.map[h];
    if (i !== undefined) sheet.getRange(rowNum, i + 1).setNumberFormat("@").setValue(obj[h] !== undefined ? obj[h] : "");
  });
  return rowNum;
}

function cleanLog_(p) {
  return {
    id: String(p.id || ""),
    date: dateKey_(p.date),
    time: timeKey_(p.time, p.time),
    cat: String(p.cat || "업무"),
    content: String(p.content || ""),
    updatedAt: Number(p.updatedAt) || Date.now(),
    deleted: bool_(p.deleted),
    origin: p.origin === "request" || p.origin === "self" ? p.origin : "",
    requester: String(p.requester || ""),
    requestedAt: String(p.requestedAt || ""),
    dueDate: dateKey_(p.dueDate),
    project: String(p.project || ""),
    memo: String(p.memo || ""),
    highlight: bool_(p.highlight),
    status: p.status === "pending" ? "pending" : "logged",
    actualStartedAt: String(p.actualStartedAt || "")
  };
}

function readObjectRow_(sheet, rowNum, wantedHeaders) {
  ensureHeaders_(sheet, wantedHeaders);
  const hm = headerMap_(sheet);
  const values = sheet.getRange(rowNum, 1, 1, hm.headers.length).getValues()[0];
  const displays = sheet.getRange(rowNum, 1, 1, hm.headers.length).getDisplayValues()[0];
  const obj = {};
  wantedHeaders.forEach(h => {
    const i = hm.map[h];
    if (i === undefined) { obj[h] = ""; return; }
    const v = values[i];
    if (h === "date" || h === "dueDate") obj[h] = dateKey_(v);
    else if (h === "time") obj[h] = timeKey_(v, displays[i]);
    else if (h === "updatedAt") obj[h] = v instanceof Date ? v.getTime() : (Number(v) || 0);
    else if (h === "deleted" || h === "highlight") obj[h] = bool_(v);
    else obj[h] = v == null ? "" : v;
  });
  return obj;
}

// 구버전 클라이언트는 신규 필드를 전혀 보내지 않는다.
// 기존 행을 수정할 때 payload에 실제로 포함된 필드만 덮어써서
// origin/requester/requestedAt 같은 v8+ 메타데이터가 빈 값으로 소실되지 않게 한다.
function mergeLogPayload_(existing, payload, incomingUpdatedAt) {
  const cleaned = cleanLog_(payload || {});
  if (!existing) return { ...cleaned, updatedAt: incomingUpdatedAt };
  const merged = { ...existing };
  LOG_HEADERS.forEach(h => {
    if (Object.prototype.hasOwnProperty.call(payload || {}, h)) merged[h] = cleaned[h];
  });
  merged.id = String(payload.id || existing.id || "");
  merged.updatedAt = incomingUpdatedAt;
  return merged;
}

function applyAction_(action, payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    const incoming = Number(payload && payload.updatedAt) || Date.now();
    if (action === "ADD_LOG" || action === "UPDATE_LOG") {
      const sheet = getSheet_(LOG_SHEET, LOG_HEADERS);
      const id = String((payload && payload.id) || "");
      if (!id) throw new Error("id가 없어");
      const row = findRowByValue_(sheet, "id", id);
      let existing = null;
      if (row !== -1) {
        const current = Number(getCellValue_(sheet, row, "updatedAt")) || 0;
        if (current > incoming) return { skipped:true };
        existing = readObjectRow_(sheet, row, LOG_HEADERS);
      }
      const merged = mergeLogPayload_(existing, payload || {}, incoming);
      writeObjectRow_(sheet, row, LOG_HEADERS, merged);
      return { skipped:false };
    }

    if (action === "DELETE_LOG") {
      const sheet = getSheet_(LOG_SHEET, LOG_HEADERS);
      const row = findRowByValue_(sheet, "id", payload.id);
      if (row === -1) return { skipped:true };
      const current = Number(getCellValue_(sheet, row, "updatedAt")) || 0;
      if (current > incoming) return { skipped:true };
      const hm = headerMap_(sheet).map;
      sheet.getRange(row, hm.deleted + 1).setValue(true);
      sheet.getRange(row, hm.updatedAt + 1).setValue(incoming);
      return { skipped:false };
    }

    if (action === "UPSERT_REFLECTION") {
      const sheet = getSheet_(REFL_SHEET, REFL_HEADERS);
      const date = dateKey_(payload.date);
      const row = findRowByValue_(sheet, "date", date);
      if (row !== -1) {
        const current = Number(getCellValue_(sheet, row, "updatedAt")) || 0;
        if (current > incoming) return { skipped:true };
      }
      const clean = {
        date,
        summary:String(payload.summary || ""), difficulty:String(payload.difficulty || ""),
        achievement:String(payload.achievement || ""), tomorrow:String(payload.tomorrow || ""),
        updatedAt:incoming
      };
      writeObjectRow_(sheet, row, REFL_HEADERS, clean);
      return { skipped:false };
    }
    return { skipped:true };
  } finally {
    lock.releaseLock();
  }
}

function checkToken_(e) { return !!(e && e.parameter && e.parameter.token === TOKEN); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "getAll";
  if (!checkToken_(e)) return json_({ok:false,error:"토큰이 올바르지 않아"});

  if (action !== "getAll") {
    if (!e.parameter.payload) return json_({ok:false,error:"payload가 없어"});
    try {
      const result = applyAction_(action, JSON.parse(e.parameter.payload));
      return json_({ok:true,skipped:!!result.skipped});
    } catch (err) { return json_({ok:false,error:String(err)}); }
  }

  try {
    const logSheet = getSheet_(LOG_SHEET, LOG_HEADERS);
    const reflSheet = getSheet_(REFL_SHEET, REFL_HEADERS);
    const logs = readAllRows_(logSheet, LOG_HEADERS);
    const rows = readAllRows_(reflSheet, REFL_HEADERS);
    const reflections = {};
    rows.forEach(r => {
      if (!r.date) return;
      const prev = reflections[r.date];
      if (!prev || Number(r.updatedAt || 0) >= Number(prev.updatedAt || 0)) reflections[r.date] = r;
    });
    return json_({ok:true,logs,reflections});
  } catch (err) { return json_({ok:false,error:String(err)}); }
}

function doPost() {
  return json_({ok:false,error:"POST는 지원하지 않아. GET을 사용해줘."});
}
