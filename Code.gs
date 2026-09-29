// ============================================================
// 업무일지 PWA v8.2 백엔드
//
// 기존 한글 탭(로그 / 회고)과 영문 탭(Log / Reflection)을 함께 읽는다.
// 과거 행을 옮기거나 삭제하지 않으며, 동일 id/날짜는 최신 수정시각을 사용한다.
// 모든 쓰기는 GET + query string 방식만 사용한다.
// ============================================================

const TOKEN = "여기를_기존_토큰과_같게_바꿔줘";

// 새 기록의 기본 저장소. 기존 한글 탭은 그대로 보존하며 읽기 대상에 포함한다.
const LOG_SHEET = "Log";
const REFL_SHEET = "Reflection";
const LEGACY_LOG_SHEET = "로그";
const LEGACY_REFL_SHEET = "회고";

const LOG_HEADERS = [
  "id", "date", "time", "cat", "content", "updatedAt", "deleted",
  "origin", "requester", "requestedAt", "dueDate", "project", "memo",
  "highlight", "status", "actualStartedAt", "solved"
];
const REFL_HEADERS = ["date", "summary", "difficulty", "achievement", "tomorrow", "updatedAt"];

// 한글 구버전 헤더를 논리적인 v8 필드명으로 연결한다.
const LOG_ALIASES = {
  id: ["id"], date: ["날짜"], time: ["시간"], cat: ["분류"], content: ["내용"],
  updatedAt: ["수정시각"], deleted: ["삭제"]
};
const REFL_ALIASES = {
  date: ["날짜"], summary: ["오늘 한 줄"], difficulty: ["어려웠던 점 & 이유"],
  achievement: ["잘한 점"], tomorrow: ["내일은?"], updatedAt: ["수정시각"]
};

function spreadsheet_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function getSheet_(name, wantedHeaders) {
  const ss = spreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, wantedHeaders.length).setValues([wantedHeaders]);
  }
  return sheet;
}

function existingSheets_(names) {
  const ss = spreadsheet_();
  const seen = {};
  return names.map(name => ss.getSheetByName(name)).filter(sheet => {
    if (!sheet || seen[sheet.getSheetId()]) return false;
    seen[sheet.getSheetId()] = true;
    return true;
  });
}

function headerMap_(sheet) {
  const n = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, n).getDisplayValues()[0]
    .map(value => String(value || "").trim());
  const map = {};
  headers.forEach((header, index) => { if (header) map[header] = index; });
  return { headers, map };
}

function headerIndex_(map, logicalHeader, aliases) {
  const candidates = [logicalHeader].concat((aliases && aliases[logicalHeader]) || []);
  for (let i = 0; i < candidates.length; i++) {
    if (map[candidates[i]] !== undefined) return map[candidates[i]];
  }
  return undefined;
}

// 쓰기 직전에만, 기존 한글 헤더로 표현할 수 없는 v8 필드를 오른쪽에 추가한다.
// 읽기만 할 때는 기존 탭을 전혀 바꾸지 않는다.
function ensureHeadersForWrite_(sheet, wantedHeaders, aliases) {
  const hm = headerMap_(sheet);
  const missing = wantedHeaders.filter(header => headerIndex_(hm.map, header, aliases) === undefined);
  if (missing.length) sheet.getRange(1, hm.headers.length + 1, 1, missing.length).setValues([missing]);
}

function dateKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, spreadsheet_().getSpreadsheetTimeZone(), "yyyy-MM-dd");
  }
  const text = String(value == null ? "" : value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : text;
}

function timeKey_(rawValue, displayValue) {
  const displayed = String(displayValue == null ? "" : displayValue).trim();
  let match = displayed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match) return String(Number(match[1])).padStart(2, "0") + ":" + match[2];
  match = displayed.match(/^(오전|오후|AM|PM)\s*(\d{1,2}):(\d{2})(?::\d{2})?$/i);
  if (match) {
    let hour = Number(match[2]) % 12;
    if (match[1] === "오후" || String(match[1]).toUpperCase() === "PM") hour += 12;
    return String(hour).padStart(2, "0") + ":" + match[3];
  }
  const raw = String(rawValue == null ? "" : rawValue).trim();
  match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return match ? String(Number(match[1])).padStart(2, "0") + ":" + match[2] : raw;
}

function bool_(value) {
  return value === true || value === "Y" || String(value).toLowerCase() === "true";
}

function normalizeCell_(header, value, displayValue) {
  if (header === "date" || header === "dueDate") return dateKey_(value);
  if (header === "time") return timeKey_(value, displayValue);
  if (header === "updatedAt") return value instanceof Date ? value.getTime() : (Number(value) || 0);
  if (header === "deleted" || header === "highlight" || header === "solved") return bool_(value);
  return value == null ? "" : value;
}

function readAllRows_(sheet, wantedHeaders, aliases) {
  const values = sheet.getDataRange().getValues();
  const displays = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  const hm = headerMap_(sheet);
  const out = [];
  for (let row = 1; row < values.length; row++) {
    if (values[row].every(cell => cell === "")) continue;
    const item = {};
    wantedHeaders.forEach(header => {
      const index = headerIndex_(hm.map, header, aliases);
      item[header] = index === undefined ? "" : normalizeCell_(header, values[row][index], displays[row][index]);
    });
    out.push(item);
  }
  return out;
}

function readObjectRow_(sheet, rowNumber, wantedHeaders, aliases) {
  const hm = headerMap_(sheet);
  const values = sheet.getRange(rowNumber, 1, 1, hm.headers.length).getValues()[0];
  const displays = sheet.getRange(rowNumber, 1, 1, hm.headers.length).getDisplayValues()[0];
  const item = {};
  wantedHeaders.forEach(header => {
    const index = headerIndex_(hm.map, header, aliases);
    item[header] = index === undefined ? "" : normalizeCell_(header, values[index], displays[index]);
  });
  return item;
}

function findLatestRowByValue_(sheet, logicalHeader, value, aliases) {
  const hm = headerMap_(sheet);
  const targetIndex = headerIndex_(hm.map, logicalHeader, aliases);
  if (targetIndex === undefined) return -1;
  const updatedIndex = headerIndex_(hm.map, "updatedAt", aliases);
  const values = sheet.getDataRange().getValues();
  const target = String(value == null ? "" : value);
  let bestRow = -1;
  let bestUpdated = -1;
  for (let row = 1; row < values.length; row++) {
    const actual = logicalHeader === "date" ? dateKey_(values[row][targetIndex]) : String(values[row][targetIndex] == null ? "" : values[row][targetIndex]);
    if (actual !== target) continue;
    const updated = updatedIndex === undefined ? 0 : normalizeCell_("updatedAt", values[row][updatedIndex], "");
    if (bestRow === -1 || Number(updated) >= bestUpdated) {
      bestRow = row + 1;
      bestUpdated = Number(updated) || 0;
    }
  }
  return bestRow;
}

function findExisting_(sheetNames, logicalHeader, value, wantedHeaders, aliases) {
  let best = null;
  existingSheets_(sheetNames).forEach(sheet => {
    const row = findLatestRowByValue_(sheet, logicalHeader, value, aliases);
    if (row === -1) return;
    const item = readObjectRow_(sheet, row, wantedHeaders, aliases);
    if (!best || Number(item.updatedAt || 0) >= Number(best.item.updatedAt || 0)) best = { sheet, row, item };
  });
  return best;
}

function writeObjectRow_(sheet, rowNumber, wantedHeaders, aliases, item) {
  ensureHeadersForWrite_(sheet, wantedHeaders, aliases);
  const hm = headerMap_(sheet);
  const width = hm.headers.length;
  const existing = rowNumber > 0 ? sheet.getRange(rowNumber, 1, 1, width).getValues()[0] : new Array(width).fill("");
  wantedHeaders.forEach(header => {
    const index = headerIndex_(hm.map, header, aliases);
    if (index !== undefined && item[header] !== undefined) existing[index] = item[header];
  });
  if (rowNumber > 0) {
    sheet.getRange(rowNumber, 1, 1, width).setValues([existing]);
  } else {
    sheet.appendRow(existing);
    rowNumber = sheet.getLastRow();
  }
  ["date", "time", "requestedAt", "dueDate", "actualStartedAt"].forEach(header => {
    const index = headerIndex_(hm.map, header, aliases);
    if (index !== undefined) sheet.getRange(rowNumber, index + 1).setNumberFormat("@").setValue(item[header] !== undefined ? item[header] : "");
  });
  return rowNumber;
}

function cleanLog_(payload) {
  const p = payload || {};
  return {
    id: String(p.id || ""), date: dateKey_(p.date), time: timeKey_(p.time, p.time),
    cat: String(p.cat || "업무"), content: String(p.content || ""),
    updatedAt: Number(p.updatedAt) || Date.now(), deleted: bool_(p.deleted),
    origin: p.origin === "request" || p.origin === "self" ? p.origin : "",
    requester: String(p.requester || ""), requestedAt: String(p.requestedAt || ""),
    dueDate: dateKey_(p.dueDate), project: String(p.project || ""), memo: String(p.memo || ""),
    highlight: bool_(p.highlight), status: p.status === "pending" ? "pending" : "logged",
    actualStartedAt: String(p.actualStartedAt || ""), solved: bool_(p.solved)
  };
}

function mergeLogPayload_(existing, payload, incomingUpdatedAt) {
  const cleaned = cleanLog_(payload);
  if (!existing) return { ...cleaned, updatedAt: incomingUpdatedAt };
  const merged = { ...existing };
  LOG_HEADERS.forEach(header => {
    if (Object.prototype.hasOwnProperty.call(payload || {}, header)) merged[header] = cleaned[header];
  });
  merged.id = String(payload.id || existing.id || "");
  merged.updatedAt = incomingUpdatedAt;
  return merged;
}

function latestByKey_(rows, key) {
  const out = {};
  rows.forEach(row => {
    const id = String(row[key] || "");
    if (!id) return;
    if (!out[id] || Number(row.updatedAt || 0) >= Number(out[id].updatedAt || 0)) out[id] = row;
  });
  return Object.keys(out).map(key => out[key]);
}

function sourceSummary_(rows) {
  const dates = rows.map(row => row.date).filter(Boolean).sort();
  return { rows: rows.length, oldestDate: dates[0] || "", newestDate: dates[dates.length - 1] || "" };
}

function readAllLogs_() {
  const sheets = [getSheet_(LOG_SHEET, LOG_HEADERS)].concat(existingSheets_([LEGACY_LOG_SHEET]));
  const all = [];
  const sources = {};
  sheets.forEach(sheet => {
    const rows = readAllRows_(sheet, LOG_HEADERS, LOG_ALIASES);
    sources[sheet.getName()] = sourceSummary_(rows);
    rows.forEach(row => all.push(row));
  });
  return { rows: latestByKey_(all, "id"), sources };
}

function readAllReflections_() {
  const sheets = [getSheet_(REFL_SHEET, REFL_HEADERS)].concat(existingSheets_([LEGACY_REFL_SHEET]));
  const all = [];
  const sources = {};
  sheets.forEach(sheet => {
    const rows = readAllRows_(sheet, REFL_HEADERS, REFL_ALIASES);
    sources[sheet.getName()] = sourceSummary_(rows);
    rows.forEach(row => all.push(row));
  });
  const reflections = {};
  latestByKey_(all, "date").forEach(row => { reflections[row.date] = row; });
  return { reflections, sources };
}

function applyAction_(action, payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    const incoming = Number(payload && payload.updatedAt) || Date.now();
    if (action === "ADD_LOG" || action === "UPDATE_LOG") {
      const id = String((payload && payload.id) || "");
      if (!id) throw new Error("id가 없어");
      const found = findExisting_([LOG_SHEET, LEGACY_LOG_SHEET], "id", id, LOG_HEADERS, LOG_ALIASES);
      if (found && Number(found.item.updatedAt || 0) > incoming) return { skipped: true };
      const target = found || { sheet: getSheet_(LOG_SHEET, LOG_HEADERS), row: 0, item: null };
      const merged = mergeLogPayload_(target.item, payload || {}, incoming);
      writeObjectRow_(target.sheet, target.row, LOG_HEADERS, LOG_ALIASES, merged);
      return { skipped: false };
    }

    if (action === "DELETE_LOG") {
      const found = findExisting_([LOG_SHEET, LEGACY_LOG_SHEET], "id", payload && payload.id, LOG_HEADERS, LOG_ALIASES);
      if (!found || Number(found.item.updatedAt || 0) > incoming) return { skipped: true };
      writeObjectRow_(found.sheet, found.row, LOG_HEADERS, LOG_ALIASES, { ...found.item, deleted: true, updatedAt: incoming });
      return { skipped: false };
    }

    if (action === "UPSERT_REFLECTION") {
      const date = dateKey_(payload && payload.date);
      if (!date) throw new Error("회고 날짜가 없어");
      const found = findExisting_([REFL_SHEET, LEGACY_REFL_SHEET], "date", date, REFL_HEADERS, REFL_ALIASES);
      if (found && Number(found.item.updatedAt || 0) > incoming) return { skipped: true };
      const target = found || { sheet: getSheet_(REFL_SHEET, REFL_HEADERS), row: 0, item: null };
      const merged = {
        ...(target.item || {}), date,
        summary: String(payload.summary || ""), difficulty: String(payload.difficulty || ""),
        achievement: String(payload.achievement || ""), tomorrow: String(payload.tomorrow || ""), updatedAt: incoming
      };
      writeObjectRow_(target.sheet, target.row, REFL_HEADERS, REFL_ALIASES, merged);
      return { skipped: false };
    }
    return { skipped: true };
  } finally {
    lock.releaseLock();
  }
}

function checkToken_(event) { return !!(event && event.parameter && event.parameter.token === TOKEN); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function doGet(event) {
  const action = (event && event.parameter && event.parameter.action) || "getAll";
  if (!checkToken_(event)) return json_({ ok: false, error: "토큰이 올바르지 않아" });
  if (action !== "getAll") {
    if (!event.parameter.payload) return json_({ ok: false, error: "payload가 없어" });
    try {
      const result = applyAction_(action, JSON.parse(event.parameter.payload));
      return json_({ ok: true, skipped: !!result.skipped });
    } catch (err) { return json_({ ok: false, error: String(err) }); }
  }
  try {
    const logs = readAllLogs_();
    const reflections = readAllReflections_();
    return json_({ ok: true, logs: logs.rows, reflections: reflections.reflections, sources: { logs: logs.sources, reflections: reflections.sources } });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
}

function doPost() {
  return json_({ ok: false, error: "POST는 지원하지 않아. GET을 사용해줘." });
}
