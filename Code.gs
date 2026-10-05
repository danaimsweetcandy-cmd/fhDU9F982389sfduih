// ============================================================
// 업무일지 PWA v8.5 백엔드
// - 기존 Log / 로그, Reflection / 회고 데이터 하위 호환
// - 모든 쓰기는 GET + query string
// - 수정시각 + deviceId 버전 비교, tombstone, revision 증분 동기화
// ============================================================

const TOKEN = "여기를_기존_토큰과_같게_바꿔줘";
const APP_ID = "dayeon-worklog";
const SCHEMA_VERSION = 3;

const LOG_SHEET = "Log";
const REFL_SHEET = "Reflection";
const LEGACY_LOG_SHEET = "로그";
const LEGACY_REFL_SHEET = "회고";
const REVISION_KEY = "worklog_revision";

// 앞 7개 컬럼 순서는 기존 버전과 동일하게 유지한다.
const LOG_HEADERS = [
  "id", "date", "time", "cat", "content", "updatedAt", "deleted",
  "origin", "requester", "requestedAt", "dueDate", "project", "memo",
  "highlight", "status", "actualStartedAt", "solved", "deviceId", "rev", "meeting", "support",
  "requestId", "requestState", "completedAt"
];
const REFL_HEADERS = [
  "date", "summary", "difficulty", "achievement", "tomorrow", "updatedAt",
  "deviceId", "rev"
];

const LOG_ALIASES = {
  id: ["id"], date: ["날짜"], time: ["시간"], cat: ["분류"], content: ["내용"],
  updatedAt: ["수정시각"], deleted: ["삭제"]
};
const REFL_ALIASES = {
  date: ["날짜"], summary: ["오늘 한 줄"], difficulty: ["어려웠던 점 & 이유"],
  achievement: ["잘한 점"], tomorrow: ["내일은?"], updatedAt: ["수정시각"]
};

function spreadsheet_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function storeId_() { return spreadsheet_().getId(); }
function props_() { return PropertiesService.getDocumentProperties(); }
function currentRevision_() {
  const n = Number(props_().getProperty(REVISION_KEY));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
function nextRevision_() {
  const n = currentRevision_() + 1;
  props_().setProperty(REVISION_KEY, String(n));
  return n;
}

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

function ensureHeadersForWrite_(sheet, wantedHeaders, aliases) {
  const hm = headerMap_(sheet);
  const missing = wantedHeaders.filter(header => headerIndex_(hm.map, header, aliases) === undefined);
  if (missing.length) sheet.getRange(1, hm.headers.length + 1, 1, missing.length).setValues([missing]);
}

function validDate_(value, allowEmpty) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return allowEmpty ? "" : null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

function validTime_(value, allowEmpty) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return allowEmpty ? "" : null;
  const m = s.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? s : null;
}

function validDateTime_(value, allowEmpty) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return allowEmpty ? "" : null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (!m || validDate_(m[1], false) === null || validTime_(m[2], false) === null) return null;
  return s;
}

function timestamp_(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 946684800000 || n > 4102444800000) return null;
  return Math.floor(n);
}

function text_(value, max, field, allowEmpty) {
  const s = String(value == null ? "" : value);
  if (!allowEmpty && !s.trim()) throw new Error(field + " 값이 비어 있어");
  if (s.length > max) throw new Error(field + " 값이 너무 길어");
  return s;
}

function bool_(value) {
  return value === true || value === 1 || value === "1" || value === "Y" || String(value).toLowerCase() === "true";
}

// 독립 태그는 구버전의 빈칸과 명시적인 false를 구분해야 한다.
function triBool_(value) {
  if (value === "" || value === null || value === undefined) return "";
  if (value === true || value === 1 || value === "1" || value === "Y" || String(value).toLowerCase() === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "N" || String(value).toLowerCase() === "false") return false;
  return "";
}

function payloadTriBool_(value, field) {
  const out = triBool_(value);
  if (out === "" && value !== "" && value !== null && value !== undefined) throw new Error(field + " 값이 올바르지 않아");
  return out;
}

function dateKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, spreadsheet_().getSpreadsheetTimeZone(), "yyyy-MM-dd");
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
    let hour = Number(m[2]) % 12;
    if (m[1] === "오후" || String(m[1]).toUpperCase() === "PM") hour += 12;
    return String(hour).padStart(2, "0") + ":" + m[3];
  }
  const raw = String(rawValue == null ? "" : rawValue).trim();
  const direct = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return direct ? String(Number(direct[1])).padStart(2, "0") + ":" + direct[2] : raw;
}

function normalizeCell_(header, value, displayValue) {
  if (header === "date" || header === "dueDate") return dateKey_(value);
  if (header === "time") return timeKey_(value, displayValue);
  if (header === "updatedAt") {
    if (value instanceof Date) return value.getTime();
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (header === "rev") {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  if (header === "solved" || header === "meeting" || header === "support") return triBool_(value);
  if (header === "deleted" || header === "highlight") return bool_(value);
  return value == null ? "" : value;
}

function readAllRows_(sheet, wantedHeaders, aliases) {
  const range = sheet.getDataRange();
  const values = range.getValues();
  const displays = range.getDisplayValues();
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

function compareVersion_(a, b) {
  const at = Number((a && a.updatedAt) || 0);
  const bt = Number((b && b.updatedAt) || 0);
  if (at !== bt) return at > bt ? 1 : -1;
  const ad = String((a && a.deviceId) || "");
  const bd = String((b && b.deviceId) || "");
  if (ad === bd) return 0;
  return ad > bd ? 1 : -1;
}

function findLatestRowByValue_(sheet, logicalHeader, value, wantedHeaders, aliases) {
  const hm = headerMap_(sheet);
  const targetIndex = headerIndex_(hm.map, logicalHeader, aliases);
  if (targetIndex === undefined) return -1;
  const values = sheet.getDataRange().getValues();
  const target = String(value == null ? "" : value);
  let bestRow = -1;
  let bestItem = null;
  for (let row = 1; row < values.length; row++) {
    const actual = logicalHeader === "date" ? dateKey_(values[row][targetIndex]) : String(values[row][targetIndex] == null ? "" : values[row][targetIndex]);
    if (actual !== target) continue;
    const item = readObjectRow_(sheet, row + 1, wantedHeaders, aliases);
    if (bestRow === -1 || compareVersion_(item, bestItem) >= 0) {
      bestRow = row + 1;
      bestItem = item;
    }
  }
  return bestRow;
}

function findExisting_(sheetNames, logicalHeader, value, wantedHeaders, aliases) {
  let best = null;
  existingSheets_(sheetNames).forEach(sheet => {
    const row = findLatestRowByValue_(sheet, logicalHeader, value, wantedHeaders, aliases);
    if (row === -1) return;
    const item = readObjectRow_(sheet, row, wantedHeaders, aliases);
    if (!best || compareVersion_(item, best.item) >= 0) best = { sheet, row, item };
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
  ["date", "time", "requestedAt", "dueDate", "actualStartedAt", "completedAt", "deviceId"].forEach(header => {
    const index = headerIndex_(hm.map, header, aliases);
    if (index !== undefined && item[header] !== undefined) {
      sheet.getRange(rowNumber, index + 1).setNumberFormat("@").setValue(item[header]);
    }
  });
  return rowNumber;
}

function cleanLogPayload_(payload, requireCore) {
  const p = payload || {};
  const out = {};
  if (!Object.prototype.hasOwnProperty.call(p, "id")) throw new Error("id가 없어");
  out.id = text_(p.id, 200, "id", false).trim();

  if (Object.prototype.hasOwnProperty.call(p, "date")) {
    const v = validDate_(p.date, false); if (v === null) throw new Error("날짜 형식이 올바르지 않아"); out.date = v;
  } else if (requireCore) throw new Error("날짜가 없어");
  if (Object.prototype.hasOwnProperty.call(p, "time")) {
    const v = validTime_(p.time, false); if (v === null) throw new Error("시간 형식이 올바르지 않아"); out.time = v;
  } else if (requireCore) throw new Error("시간이 없어");
  if (Object.prototype.hasOwnProperty.call(p, "cat")) out.cat = text_(p.cat, 40, "분류", true) || "업무";
  else if (requireCore) out.cat = "업무";
  if (Object.prototype.hasOwnProperty.call(p, "content")) out.content = text_(p.content, 500, "업무명", false);
  else if (requireCore) throw new Error("업무명이 없어");

  if (!Object.prototype.hasOwnProperty.call(p, "updatedAt")) throw new Error("수정시각이 없어");
  const ts = timestamp_(p.updatedAt); if (ts === null) throw new Error("수정시각이 올바르지 않아"); out.updatedAt = ts;

  if (Object.prototype.hasOwnProperty.call(p, "deleted")) out.deleted = bool_(p.deleted);
  if (Object.prototype.hasOwnProperty.call(p, "origin")) {
    const origin = String(p.origin || "");
    if (!["", "request", "self"].includes(origin)) throw new Error("발생 경로가 올바르지 않아");
    out.origin = origin;
  }
  if (Object.prototype.hasOwnProperty.call(p, "requester")) out.requester = text_(p.requester, 80, "요청자", true);
  if (Object.prototype.hasOwnProperty.call(p, "requestedAt")) {
    const v = validDateTime_(p.requestedAt, true); if (v === null) throw new Error("요청 시각이 올바르지 않아"); out.requestedAt = v;
  }
  if (Object.prototype.hasOwnProperty.call(p, "dueDate")) {
    const v = validDate_(p.dueDate, true); if (v === null) throw new Error("예정일이 올바르지 않아"); out.dueDate = v;
  }
  if (Object.prototype.hasOwnProperty.call(p, "project")) out.project = text_(p.project, 120, "프로젝트", true);
  if (Object.prototype.hasOwnProperty.call(p, "memo")) out.memo = text_(p.memo, 500, "메모", true);
  if (Object.prototype.hasOwnProperty.call(p, "highlight")) out.highlight = bool_(p.highlight);
  if (Object.prototype.hasOwnProperty.call(p, "status")) {
    const status = String(p.status || "logged");
    if (!["logged", "pending"].includes(status)) throw new Error("상태가 올바르지 않아");
    out.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(p, "actualStartedAt")) {
    const v = validDateTime_(p.actualStartedAt, true); if (v === null) throw new Error("실제 시작 시각이 올바르지 않아"); out.actualStartedAt = v;
  }
  if (Object.prototype.hasOwnProperty.call(p, "solved")) out.solved = payloadTriBool_(p.solved, "문제해결");
  if (Object.prototype.hasOwnProperty.call(p, "meeting")) out.meeting = payloadTriBool_(p.meeting, "회의");
  if (Object.prototype.hasOwnProperty.call(p, "support")) out.support = payloadTriBool_(p.support, "협업·지원");
  if (Object.prototype.hasOwnProperty.call(p, "requestId")) out.requestId = text_(p.requestId, 200, "요청ID", true).trim();
  if (Object.prototype.hasOwnProperty.call(p, "requestState")) {
    const requestState = String(p.requestState || "");
    if (!["", "waiting", "in_progress", "done"].includes(requestState)) throw new Error("요청 상태가 올바르지 않아");
    out.requestState = requestState;
  }
  if (Object.prototype.hasOwnProperty.call(p, "completedAt")) {
    const v = validDateTime_(p.completedAt, true); if (v === null) throw new Error("완료 시각이 올바르지 않아"); out.completedAt = v;
  }
  if (Object.prototype.hasOwnProperty.call(p, "deviceId")) out.deviceId = text_(p.deviceId, 100, "deviceId", true);
  return out;
}

function defaultLog_(cleaned) {
  return {
    id: cleaned.id,
    date: cleaned.date,
    time: cleaned.time,
    cat: cleaned.cat || "업무",
    content: cleaned.content,
    updatedAt: cleaned.updatedAt,
    deleted: cleaned.deleted === true,
    origin: cleaned.origin || "",
    requester: cleaned.requester || "",
    requestedAt: cleaned.requestedAt || "",
    dueDate: cleaned.dueDate || "",
    project: cleaned.project || "",
    memo: cleaned.memo || "",
    highlight: cleaned.highlight === true,
    status: cleaned.status === "pending" ? "pending" : "logged",
    actualStartedAt: cleaned.actualStartedAt || "",
    solved: cleaned.solved === undefined ? "" : cleaned.solved,
    meeting: cleaned.meeting === undefined ? "" : cleaned.meeting,
    support: cleaned.support === undefined ? "" : cleaned.support,
    requestId: cleaned.requestId || "",
    requestState: cleaned.requestState || "",
    completedAt: cleaned.completedAt || "",
    deviceId: cleaned.deviceId || "",
    rev: 0
  };
}

function mergeLogPayload_(existing, payload) {
  const cleaned = cleanLogPayload_(payload, !existing);
  if (!existing) return defaultLog_(cleaned);
  const merged = { ...existing };
  Object.keys(cleaned).forEach(k => { merged[k] = cleaned[k]; });
  // 구버전 클라이언트는 독립 태그를 모르지만 기존 cat=해결/회의 의미는 보존한다.
  if (!Object.prototype.hasOwnProperty.call(payload || {}, "solved") && cleaned.cat === "해결") merged.solved = "";
  if (!Object.prototype.hasOwnProperty.call(payload || {}, "meeting") && cleaned.cat === "회의") merged.meeting = "";
  return merged;
}

function cleanReflectionPayload_(payload) {
  const p = payload || {};
  const date = validDate_(p.date, false);
  if (date === null) throw new Error("회고 날짜가 올바르지 않아");
  const ts = timestamp_(p.updatedAt);
  if (ts === null) throw new Error("회고 수정시각이 올바르지 않아");
  return {
    date,
    summary: text_(p.summary, 500, "한 줄 요약", true),
    difficulty: text_(p.difficulty, 500, "힘들었던 점", true),
    achievement: text_(p.achievement, 500, "잘한 점", true),
    tomorrow: text_(p.tomorrow, 500, "내일은", true),
    updatedAt: ts,
    deviceId: text_(p.deviceId || "", 100, "deviceId", true)
  };
}

function latestByKey_(rows, key) {
  const out = {};
  rows.forEach(row => {
    const id = String(row[key] || "");
    if (!id) return;
    if (!out[id] || compareVersion_(row, out[id]) >= 0) out[id] = row;
  });
  return Object.keys(out).map(k => out[k]);
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
  const allowed = ["ADD_LOG", "UPDATE_LOG", "DELETE_LOG", "UPSERT_REFLECTION"];
  if (!allowed.includes(action)) throw new Error("UNKNOWN_ACTION");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (action === "ADD_LOG" || action === "UPDATE_LOG") {
      const incoming = cleanLogPayload_(payload || {}, true);
      const found = findExisting_([LOG_SHEET, LEGACY_LOG_SHEET], "id", incoming.id, LOG_HEADERS, LOG_ALIASES);
      if (found) {
        const cmp = compareVersion_(found.item, incoming);
        if (cmp > 0 || (cmp === 0 && incoming.deviceId && incoming.deviceId === String(found.item.deviceId || ""))) return { skipped: true, revision: currentRevision_() };
      }
      const target = found || { sheet: getSheet_(LOG_SHEET, LOG_HEADERS), row: 0, item: null };
      const merged = mergeLogPayload_(target.item, payload || {});
      merged.rev = nextRevision_();
      writeObjectRow_(target.sheet, target.row, LOG_HEADERS, LOG_ALIASES, merged);
      return { skipped: false, revision: merged.rev };
    }

    if (action === "DELETE_LOG") {
      const p = payload || {};
      const id = text_(p.id, 200, "id", false).trim();
      const updatedAt = timestamp_(p.updatedAt);
      if (updatedAt === null) throw new Error("수정시각이 올바르지 않아");
      const deviceId = text_(p.deviceId || "", 100, "deviceId", true);
      const incoming = { updatedAt, deviceId };
      const found = findExisting_([LOG_SHEET, LEGACY_LOG_SHEET], "id", id, LOG_HEADERS, LOG_ALIASES);
      if (!found) return { skipped: true, revision: currentRevision_() };
      { const cmp = compareVersion_(found.item, incoming); if (cmp > 0 || (cmp === 0 && deviceId && deviceId === String(found.item.deviceId || ""))) return { skipped: true, revision: currentRevision_() }; }
      const row = { ...found.item, deleted: true, updatedAt, deviceId, rev: nextRevision_() };
      writeObjectRow_(found.sheet, found.row, LOG_HEADERS, LOG_ALIASES, row);
      return { skipped: false, revision: row.rev };
    }

    const incoming = cleanReflectionPayload_(payload || {});
    const found = findExisting_([REFL_SHEET, LEGACY_REFL_SHEET], "date", incoming.date, REFL_HEADERS, REFL_ALIASES);
    if (found) { const cmp = compareVersion_(found.item, incoming); if (cmp > 0 || (cmp === 0 && incoming.deviceId && incoming.deviceId === String(found.item.deviceId || ""))) return { skipped: true, revision: currentRevision_() }; }
    const target = found || { sheet: getSheet_(REFL_SHEET, REFL_HEADERS), row: 0, item: null };
    const merged = { ...(target.item || {}), ...incoming, rev: nextRevision_() };
    writeObjectRow_(target.sheet, target.row, REFL_HEADERS, REFL_ALIASES, merged);
    return { skipped: false, revision: merged.rev };
  } finally {
    lock.releaseLock();
  }
}

function responseBase_() {
  return {
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    capabilities: ["contextFlagsV1", "requestWorkflowV1"],
    storeId: storeId_(),
    serverTime: Date.now(),
    revision: currentRevision_()
  };
}

function checkToken_(event) { return !!(event && event.parameter && event.parameter.token === TOKEN); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function ok_(extra) { return json_({ ok: true, ...responseBase_(), ...(extra || {}) }); }
function fail_(error, code) { return json_({ ok: false, ...responseBase_(), error: String(error || "오류"), code: code || "ERROR" }); }

function doGet(event) {
  const action = (event && event.parameter && event.parameter.action) || "getAll";
  if (!checkToken_(event)) return fail_("토큰이 올바르지 않아", "AUTH");

  if (action === "meta") return ok_({});

  if (action === "probe") {
    try {
      const lock = LockService.getScriptLock();
      lock.waitLock(5000);
      try {
        props_().setProperty("worklog_last_probe", String(Date.now()));
      } finally {
        lock.releaseLock();
      }
      return ok_({ writable: true });
    } catch (err) {
      return fail_(err, "WRITE_PROBE_FAILED");
    }
  }

  if (["ADD_LOG", "UPDATE_LOG", "DELETE_LOG", "UPSERT_REFLECTION"].includes(action)) {
    if (!event.parameter.payload) return fail_("payload가 없어", "BAD_PAYLOAD");
    try {
      const result = applyAction_(action, JSON.parse(event.parameter.payload));
      return ok_({ skipped: !!result.skipped, revision: result.revision });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      return fail_(msg, msg === "UNKNOWN_ACTION" ? "UNKNOWN_ACTION" : "VALIDATION_OR_WRITE");
    }
  }

  if (action !== "getAll") return fail_("알 수 없는 action이야", "UNKNOWN_ACTION");

  try {
    const currentRev = currentRevision_();
    const rawSince = event && event.parameter ? event.parameter.sinceRev : "";
    const hasSince = rawSince !== undefined && rawSince !== null && String(rawSince) !== "";
    const sinceRev = hasSince ? Number(rawSince) : 0;
    const forceFull = !hasSince || !Number.isFinite(sinceRev) || sinceRev < 0 || sinceRev > currentRev;

    const logs = readAllLogs_();
    const reflections = readAllReflections_();
    let logRows = logs.rows;
    let reflObj = reflections.reflections;

    if (!forceFull && sinceRev > 0) {
      logRows = logRows.filter(row => Number(row.rev || 0) > sinceRev);
      const filtered = {};
      Object.keys(reflObj).forEach(k => { if (Number(reflObj[k].rev || 0) > sinceRev) filtered[k] = reflObj[k]; });
      reflObj = filtered;
    }

    return ok_({
      full: forceFull || sinceRev === 0,
      logs: logRows,
      reflections: reflObj,
      sources: (forceFull || sinceRev === 0) ? { logs: logs.sources, reflections: reflections.sources } : undefined
    });
  } catch (err) {
    return fail_(err, "READ_FAILED");
  }
}

function doPost() {
  return fail_("POST는 지원하지 않아. GET을 사용해줘.", "METHOD_NOT_ALLOWED");
}
