// ============================================================
// 업무일지 PWA v8.2
// 기존 localStorage / Google Sheets 데이터와 하위 호환 유지
// ============================================================
const CONFIG = { GAS_URL: "PUT_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE" };

const LS_LOGS = "worklog_logs";
const LS_REFL = "worklog_reflections";
const LS_OUTBOX = "worklog_outbox";
const LS_GAS_URL = "worklog_gas_url";
const LS_GAS_TOKEN = "worklog_gas_token";
const MAX_GAS_URL_LENGTH = 7500;

const CAT_LABEL = {
  "업무": "업무", "수정": "수정", "검수": "검수", "진행관리": "진행관리",
  "회의": "회의", "해결": "해결한 문제", "기타": "기타", "요청": "요청받은 일"
};
const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"];

const state = {
  logs: [],
  reflections: {},
  currentDate: todayStr(),
  activeOrigin: "",
  requestWhen: "now",
  summaryYear: new Date().getFullYear(),
  summaryMonth: new Date().getMonth(),
  currentView: "today",
  editId: null,
  followToday: true
};

let syncTimer = null;
let flushing = false;
let resyncRequested = false;
let toastTimer = null;
let lastSyncError = "";
let reflTimers = {};
const inFlightQids = new Set();
let modalReturnFocus = null;

function $(id) { return document.getElementById(id); }
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}
function qid() { return "q-" + Date.now() + "-" + Math.random().toString(16).slice(2); }

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function nowTimeStr(d = new Date()) {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function nowLocalDateTime(d = new Date()) { return `${todayStr(d)}T${nowTimeStr(d)}`; }
function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return todayStr(dt);
}
function normalizeDateStr(value) {
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const dt = value instanceof Date ? value : new Date(value);
  return Number.isNaN(dt.getTime()) ? "" : todayStr(dt);
}
function normalizeTimeStr(value) {
  const s = String(value == null ? "" : value).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) {
    const h = Number(m[1]), min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return `${String(h).padStart(2,"0")}:${m[2]}`;
  }
  m = s.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}
function normalizeDateTimeLocal(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${m[1]}T${String(Number(m[2])).padStart(2,"0")}:${m[3]}`;
}
function formatDateMain(dateStr) {
  const d = normalizeDateStr(dateStr);
  if (!d) return "날짜 미상";
  const [y,m,day] = d.split("-").map(Number);
  const dt = new Date(y,m-1,day);
  return `${m}월 ${day}일 ${WEEKDAY_KR[dt.getDay()]}요일`;
}
function formatShortDate(dateStr) {
  const d = normalizeDateStr(dateStr);
  if (!d) return "";
  const [,m,day] = d.split("-");
  return `${Number(m)}/${Number(day)}`;
}
function formatDateTime(value) {
  const v = normalizeDateTimeLocal(value);
  if (!v) return "";
  const [d,t] = v.split("T");
  return `${formatShortDate(d)} ${t}`;
}
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value == null ? "" : value);
  return div.innerHTML;
}
function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1900);
}
function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch {
    setSyncDot("error");
    toast("기기 저장 공간이 부족해. 백업 후 저장 공간을 확인해줘.");
    return false;
  }
}
function getGasUrl() { return (localStorage.getItem(LS_GAS_URL) || CONFIG.GAS_URL || "").trim(); }
function setGasUrl(v) { return safeStorageSet(LS_GAS_URL, String(v || "").trim()); }
function getGasToken() { return (localStorage.getItem(LS_GAS_TOKEN) || "").trim(); }
function setGasToken(v) { return safeStorageSet(LS_GAS_TOKEN, String(v || "").trim()); }
function isGasUrlSet() { const u = getGasUrl(); return !!u && !u.startsWith("PUT_YOUR"); }

function normalizeLog(raw) {
  raw = raw || {};
  const cat = String(raw.cat || "업무");
  const date = normalizeDateStr(raw.date) || todayStr();
  const hasSolved = raw.solved !== undefined && raw.solved !== null && raw.solved !== "";
  const solved = hasSolved
    ? (raw.solved === true || raw.solved === "true" || raw.solved === "Y")
    : cat === "해결";
  return {
    ...raw,
    id: raw.id || uid(),
    date,
    time: normalizeTimeStr(raw.time) || "00:00",
    cat,
    content: String(raw.content || ""),
    updatedAt: Number(raw.updatedAt) || 0,
    deleted: raw.deleted === true || raw.deleted === "true" || raw.deleted === "Y",
    origin: raw.origin === "request" || raw.origin === "self" ? raw.origin : "",
    requester: String(raw.requester || ""),
    requestedAt: normalizeDateTimeLocal(raw.requestedAt),
    dueDate: normalizeDateStr(raw.dueDate),
    project: String(raw.project || ""),
    memo: String(raw.memo || ""),
    solved,
    highlight: raw.highlight === true || raw.highlight === "true" || raw.highlight === "Y",
    status: raw.status === "pending" ? "pending" : "logged",
    actualStartedAt: normalizeDateTimeLocal(raw.actualStartedAt)
  };
}
function normalizeReflection(raw, key) {
  raw = raw || {};
  const date = normalizeDateStr(raw.date || key);
  if (!date) return null;
  return {
    date,
    summary: String(raw.summary || ""),
    difficulty: String(raw.difficulty || ""),
    achievement: String(raw.achievement || ""),
    tomorrow: String(raw.tomorrow || ""),
    updatedAt: Number(raw.updatedAt) || 0
  };
}

function loadLocal() {
  try { state.logs = (JSON.parse(localStorage.getItem(LS_LOGS)) || []).map(normalizeLog); }
  catch { state.logs = []; }
  try {
    const raw = JSON.parse(localStorage.getItem(LS_REFL)) || {};
    const out = {};
    Object.keys(raw).forEach(k => {
      const r = normalizeReflection(raw[k], k);
      if (!r) return;
      if (!out[r.date] || r.updatedAt >= out[r.date].updatedAt) out[r.date] = r;
    });
    state.reflections = out;
  } catch { state.reflections = {}; }
  saveLocalLogs(); saveLocalRefl();
  normalizeOutbox();
}
function saveLocalLogs() { return safeStorageSet(LS_LOGS, JSON.stringify(state.logs)); }
function saveLocalRefl() { return safeStorageSet(LS_REFL, JSON.stringify(state.reflections)); }

function getOutbox() {
  try { return JSON.parse(localStorage.getItem(LS_OUTBOX)) || []; }
  catch { return []; }
}
function setOutbox(v) { return safeStorageSet(LS_OUTBOX, JSON.stringify(v)); }
function normalizeOutbox() {
  const box = getOutbox().map(item => ({ ...item, qid: item.qid || qid(), queuedAt: Number(item.queuedAt) || Date.now() }));
  setOutbox(box);
}
function getOutboxKey(action, payload) {
  if (!payload) return null;
  if (action === "UPSERT_REFLECTION") return "REFL:" + payload.date;
  if (payload.id !== undefined) return "LOG:" + payload.id;
  return null;
}
function queueOutbox(action, payload) {
  const box = getOutbox();
  const key = getOutboxKey(action, payload);
  if (key) {
    const idx = box.findIndex(x => getOutboxKey(x.action, x.payload) === key);
    if (idx !== -1) {
      const prev = box[idx];
      if (action === "DELETE_LOG" && prev.action === "ADD_LOG" && !inFlightQids.has(prev.qid)) {
        box.splice(idx, 1);
        if (!setOutbox(box)) return false;
        scheduleSync();
        return true;
      }
      let mergedAction = action;
      if (prev.action === "ADD_LOG" && action === "UPDATE_LOG") mergedAction = "ADD_LOG";
      box[idx] = { action: mergedAction, payload, queuedAt: Date.now(), qid: qid() };
      if (!setOutbox(box)) return false;
      scheduleSync();
      return true;
    }
  }
  box.push({ action, payload, queuedAt: Date.now(), qid: qid() });
  if (!setOutbox(box)) return false;
  scheduleSync();
  return true;
}
function scheduleSync() {
  setSyncDot("pending");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (flushing) { resyncRequested = true; return; }
    syncNow(true);
  }, 800);
}
function setSyncDot(status) {
  const el = $("syncDot");
  if (el) el.className = "sync-dot" + (status ? " " + status : "");
  const labels = { "": "동기화 미설정", ok: "동기화 완료", pending: "전송 대기 중", error: "동기화 오류" };
  const label = labels[status] || "동기화 상태";
  const text = $("syncStatusText");
  if (text) text.textContent = label;
  const btn = $("syncBtn");
  if (btn) {
    btn.setAttribute("aria-label", `지금 동기화. 현재 ${label}`);
    btn.title = `지금 동기화 · ${label}`;
  }
}

async function gasCall(action, payload) {
  const p = new URLSearchParams();
  p.set("action", action);
  p.set("token", getGasToken());
  if (payload !== undefined) p.set("payload", JSON.stringify(payload));
  const url = getGasUrl() + "?" + p.toString();
  if (url.length > MAX_GAS_URL_LENGTH) {
    throw new Error("기록이 너무 길어서 시트에 전송할 수 없어. 내용을 조금 줄여줘.");
  }
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("서버 응답을 읽지 못했어"); }
  if (!data || data.ok === false) throw new Error((data && data.error) || "동기화 오류");
  return data;
}

// qid가 같은 항목만 제거한다. 전송 중 같은 로그가 다시 수정되어 새 qid가 생기면 새 요청은 보존된다.
async function flushOutbox() {
  if (!isGasUrlSet()) { setSyncDot(""); return true; }
  if (flushing) { resyncRequested = true; return false; }
  const snapshot = getOutbox();
  if (!snapshot.length) { setSyncDot("ok"); return true; }
  flushing = true;
  setSyncDot("pending");
  let failed = false;
  lastSyncError = "";
  for (const item of snapshot) {
    inFlightQids.add(item.qid);
    try {
      await gasCall(item.action, item.payload);
      const current = getOutbox();
      const next = current.filter(x => x.qid !== item.qid);
      if (next.length !== current.length && !setOutbox(next)) failed = true;
    } catch (e) {
      failed = true;
      lastSyncError = (e && e.message) || "동기화 오류";
    } finally {
      inFlightQids.delete(item.qid);
    }
  }
  flushing = false;
  const pending = getOutbox().length;
  const needsAnotherPass = resyncRequested || (pending > 0 && !failed);
  resyncRequested = false;
  setSyncDot(failed ? "error" : pending ? "pending" : "ok");
  if (needsAnotherPass) scheduleSync();
  return !failed;
}

async function fetchAndMergeAll() {
  if (!isGasUrlSet()) return false;
  const data = await gasCall("getAll");
  mergeServerData(data);
  return true;
}
function mergeServerData(data) {
  const byId = {};
  state.logs.forEach(l => { byId[l.id] = normalizeLog(l); });
  (data.logs || []).forEach(raw => {
    if (!raw || !raw.id) return;
    const s = normalizeLog(raw);
    const l = byId[s.id];
    if (!l || s.updatedAt >= Number(l.updatedAt || 0)) byId[s.id] = s;
  });
  state.logs = Object.values(byId);
  saveLocalLogs();

  const refl = data.reflections || {};
  Object.keys(refl).forEach(k => {
    const s = normalizeReflection(refl[k], k);
    if (!s) return;
    const l = state.reflections[s.date];
    if (!l || s.updatedAt >= Number(l.updatedAt || 0)) state.reflections[s.date] = s;
  });
  saveLocalRefl();
  renderCurrentView();
}
async function syncNow(quiet = false) {
  if (flushing) { resyncRequested = true; return false; }
  if (!isGasUrlSet()) { setSyncDot(""); if (!quiet) toast("설정에서 구글 시트 연동을 먼저 해줘"); return false; }
  setSyncDot("pending");
  const flushed = await flushOutbox();
  try {
    await fetchAndMergeAll();
    setSyncDot(!flushed ? "error" : getOutbox().length ? "pending" : "ok");
    if (!quiet) {
      if (!flushed) toast(lastSyncError || "일부 기록을 시트에 보내지 못했어");
      else toast(!getOutbox().length ? "동기화 완료" : "일부 기록이 전송 대기 중이야");
    }
    return true;
  } catch (e) {
    setSyncDot("error");
    if (!quiet) toast(e.message || "동기화 실패");
    return false;
  }
}

function logPayload(item) {
  const x = normalizeLog(item);
  return {
    id:x.id,date:x.date,time:x.time,cat:x.cat,content:x.content,updatedAt:x.updatedAt,deleted:!!x.deleted,
    origin:x.origin,requester:x.requester,requestedAt:x.requestedAt,dueDate:x.dueDate,project:x.project,memo:x.memo,
    solved:!!x.solved,highlight:!!x.highlight,status:x.status,actualStartedAt:x.actualStartedAt
  };
}

function requestDueDate() {
  const base = todayStr();
  if (state.requestWhen === "tomorrow") return addDays(base, 1);
  if (state.requestWhen === "date") return normalizeDateStr($("requestDueDate").value) || base;
  return base;
}
function resetQuickMeta() {
  state.activeOrigin = "";
  state.requestWhen = "now";
  document.querySelectorAll(".origin-chip").forEach(b => { const on = b.dataset.origin === ""; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
  document.querySelectorAll(".when-chip").forEach(b => { const on = b.dataset.when === "now"; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
  $("requestFields").hidden = true;
  $("requestDueDate").hidden = true;
  $("requesterInput").value = "";
  $("quickSolved").checked = false;
  $("quickProject").value = "";
  $("quickMemo").value = "";
  const d = document.querySelector(".extra-details"); if (d) d.open = false;
}
function addQuickLog() {
  const content = $("quickContent").value.trim();
  if (!content) { toast("업무명을 입력해줘"); return; }
  const now = new Date();
  const requestedAt = state.activeOrigin === "request" ? nowLocalDateTime(now) : "";
  const dueDate = state.activeOrigin === "request" ? requestDueDate() : "";
  const pending = state.activeOrigin === "request" && state.requestWhen !== "now";
  const item = normalizeLog({
    id: uid(),
    date: pending ? dueDate : state.currentDate,
    time: nowTimeStr(now),
    cat: "업무",
    content,
    origin: state.activeOrigin,
    requester: state.activeOrigin === "request" ? $("requesterInput").value.trim() : "",
    requestedAt,
    dueDate,
    project: $("quickProject").value.trim(),
    memo: $("quickMemo").value.trim(),
    solved: $("quickSolved").checked,
    highlight: false,
    status: pending ? "pending" : "logged",
    actualStartedAt: pending ? "" : `${pending ? dueDate : state.currentDate}T${nowTimeStr(now)}`,
    updatedAt: Date.now(), deleted:false
  });
  state.logs.push(item);
  if (!saveLocalLogs()) { state.logs.pop(); return; }
  if (!queueOutbox("ADD_LOG", logPayload(item))) toast("기기에는 저장했지만 동기화 대기 저장에 실패했어.");
  $("quickContent").value = "";
  resetQuickMeta();
  renderToday();
  toast(pending ? "요청을 할 일로 남겼어" : "기록했어");
}
function startPending(id) {
  const item = state.logs.find(x => x.id === id);
  if (!item || item.status !== "pending") return;
  const now = new Date();
  const date = todayStr(now), time = nowTimeStr(now);
  if (!updateLog(id, { status:"logged", date, time, actualStartedAt:nowLocalDateTime(now) })) return;
  state.currentDate = date;
  state.followToday = true;
  renderToday();
  toast("시작한 업무로 기록했어");
}
function postponePending(id, days) {
  const item = state.logs.find(x => x.id === id);
  if (!item || item.status !== "pending") return;
  const dueDate = addDays(item.dueDate || todayStr(), days);
  if (!updateLog(id, { dueDate, date:dueDate })) return;
  renderToday();
}
function deleteLogItem(id) {
  const item = state.logs.find(x => x.id === id);
  if (!item) return;
  const before = { ...item };
  item.deleted = true;
  item.updatedAt = Date.now();
  if (!saveLocalLogs()) { Object.assign(item, before); return; }
  if (!queueOutbox("DELETE_LOG", { id, updatedAt:item.updatedAt })) toast("삭제는 기기에 반영됐지만 서버 전송 대기 저장에 실패했어.");
  renderCurrentView();
}
function updateLog(id, fields) {
  const item = state.logs.find(x => x.id === id);
  if (!item) return false;
  const before = { ...item };
  Object.assign(item, fields);
  item.date = normalizeDateStr(item.date) || item.date;
  item.time = normalizeTimeStr(item.time) || item.time;
  item.requestedAt = normalizeDateTimeLocal(item.requestedAt);
  item.dueDate = normalizeDateStr(item.dueDate);
  if (item.status !== "pending" && (fields.date !== undefined || fields.time !== undefined)) {
    item.actualStartedAt = `${item.date}T${item.time}`;
  } else {
    item.actualStartedAt = normalizeDateTimeLocal(item.actualStartedAt);
  }
  item.updatedAt = Date.now();
  if (!saveLocalLogs()) { Object.assign(item, before); return false; }
  if (!queueOutbox("UPDATE_LOG", logPayload(item))) toast("수정은 기기에 반영됐지만 서버 전송 대기 저장에 실패했어.");
  return true;
}
function returnToPending(id) {
  const item = state.logs.find(x => x.id === id);
  if (!item || item.origin !== "request" || item.status === "pending") return false;
  const dueDate = item.dueDate || item.date || todayStr();
  return updateLog(id, { status:"pending", dueDate, date:dueDate, actualStartedAt:"" });
}
function toggleHighlight(id) {
  const item = state.logs.find(x => x.id === id);
  if (!item) return;
  updateLog(id, { highlight: !item.highlight });
  renderCurrentView();
}
function logsForDate(date) {
  return state.logs.filter(x => !x.deleted && x.status !== "pending" && x.date === date).sort((a,b) => a.time.localeCompare(b.time) || a.updatedAt - b.updatedAt);
}
function pendingLogs() {
  return state.logs.filter(x => !x.deleted && x.status === "pending").sort((a,b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || (a.requestedAt || "").localeCompare(b.requestedAt || ""));
}

function getReflection(date) {
  return state.reflections[date] || { date, summary:"", difficulty:"", achievement:"", tomorrow:"", updatedAt:0 };
}
function saveReflectionField(date, field, value) {
  const previous = { ...getReflection(date) };
  if (!state.reflections[date]) state.reflections[date] = getReflection(date);
  state.reflections[date][field] = value;
  state.reflections[date].updatedAt = Date.now();
  if (!saveLocalRefl()) { state.reflections[date] = previous; return; }
  if (!queueOutbox("UPSERT_REFLECTION", { ...state.reflections[date] })) {
    toast("회고는 기기에 저장했지만 서버 전송 대기 저장에 실패했어.");
  }
  const h = $("saveHint");
  if (h) {
    h.textContent = "기기에 저장됨";
    clearTimeout(reflTimers[date]);
    reflTimers[date] = setTimeout(() => { if (h) h.textContent = " "; }, 1300);
  }
  updateReflectionHint();
}
function updateReflectionHint() {
  const r = getReflection(state.currentDate);
  const vals = [r.summary,r.difficulty,r.achievement,r.tomorrow].filter(Boolean);
  $("reflectionHint").textContent = vals.length ? (r.summary || "작성됨").slice(0,18) : "비어있음";
}

function requesterOptions() {
  const names = [...new Set(state.logs.filter(x => !x.deleted).map(x => x.requester).filter(Boolean))].sort();
  $("requesterList").innerHTML = names.map(x => `<option value="${escapeHtml(x)}"></option>`).join("");
}
function logMetaHtml(item) {
  const tags = [];
  if (item.solved) tags.push(`<span class="mini-tag solved">문제해결</span>`);
  if (item.origin === "request") {
    tags.push(`<span class="mini-tag request">요청받음${item.requester ? " · " + escapeHtml(item.requester) : ""}</span>`);
    if (item.requestedAt) tags.push(`<span class="mini-tag">${escapeHtml(formatDateTime(item.requestedAt))} 요청</span>`);
    if (item.dueDate) tags.push(`<span class="mini-tag">예정 ${escapeHtml(formatShortDate(item.dueDate))}</span>`);
  }
  if (item.origin === "self") tags.push(`<span class="mini-tag self">내가 먼저 함</span>`);
  if (item.project) tags.push(`<span class="mini-tag project">${escapeHtml(item.project)}</span>`);
  if (item.cat === "요청" && !item.origin) tags.push(`<span class="mini-tag request">기존 요청 기록</span>`);
  return tags.join("");
}
function logRowHtml(item) {
  const legacyLabel = item.cat && item.cat !== "업무" && !(item.cat === "해결" && item.solved)
    ? `<strong>${escapeHtml(CAT_LABEL[item.cat] || item.cat)}</strong> `
    : "";
  return `<div class="log-item" data-cat="${escapeHtml(item.cat)}" data-solved="${item.solved ? "true" : "false"}" data-id="${escapeHtml(item.id)}">
    <div class="log-time">${escapeHtml(item.time)}</div><div class="log-bar"></div>
    <div class="log-main"><div class="log-title">${legacyLabel}${escapeHtml(item.content)}</div>
      ${logMetaHtml(item) ? `<div class="log-tags">${logMetaHtml(item)}</div>` : ""}
      ${item.memo ? `<div class="log-note">${escapeHtml(item.memo)}</div>` : ""}
    </div>
    <div class="log-actions"><button class="star-btn${item.highlight ? " on" : ""}" data-star="${escapeHtml(item.id)}" aria-label="${item.highlight ? "대표 업무 해제" : "대표 업무로 표시"}" aria-pressed="${item.highlight ? "true" : "false"}">${item.highlight ? "★" : "☆"}</button><button class="more-btn" data-edit="${escapeHtml(item.id)}" aria-label="수정">⋯</button></div>
  </div>`;
}

function renderToday() {
  const current = normalizeDateStr(state.currentDate);
  const [cy, cm, cd] = current.split("-").map(Number);
  const cdt = new Date(cy, cm - 1, cd);
  $("todayDateMain").textContent = `${cm}월 ${cd}일`;
  $("todayDateSub").textContent = `${cy}년 · ${WEEKDAY_KR[cdt.getDay()]}요일`;
  $("reflectionTitle").textContent = state.currentDate === todayStr() ? "오늘 회고" : "이 날 회고";
  requesterOptions();

  const pending = pendingLogs();
  $("pendingSection").hidden = pending.length === 0;
  $("pendingCount").textContent = pending.length ? String(pending.length) : "";
  $("pendingList").innerHTML = pending.map(x => {
    const due = x.dueDate || x.date;
    const overdue = due && due < todayStr();
    const when = due === todayStr() ? "오늘" : due === addDays(todayStr(),1) ? "내일" : formatShortDate(due);
    return `<article class="pending-card" data-id="${escapeHtml(x.id)}">
      <div class="pending-main"><div class="pending-title">${escapeHtml(x.content)}</div>
      <div class="pending-meta">${x.requester ? escapeHtml(x.requester) + " · " : ""}${x.requestedAt ? formatDateTime(x.requestedAt) + " 요청 · " : ""}<span class="pending-due${overdue ? " overdue" : ""}">${overdue ? "기한 지남 · " : ""}${escapeHtml(when)}</span>${x.solved ? " · 문제해결" : ""}${x.project ? " · " + escapeHtml(x.project) : ""}</div></div>
      <button class="start-btn" data-start="${escapeHtml(x.id)}">시작</button>
      <div class="pending-actions"><button class="text-btn" data-tomorrow="${escapeHtml(x.id)}">+1일</button><button class="text-btn" data-edit="${escapeHtml(x.id)}">수정</button></div>
    </article>`;
  }).join("");

  const items = logsForDate(state.currentDate);
  $("dayCount").textContent = items.length ? `${items.length}건` : "";
  $("timeline").innerHTML = items.length ? items.map(logRowHtml).join("") : `<div class="timeline-empty">아직 기록이 없어.</div>`;

  const r = getReflection(state.currentDate);
  $("fSummary").value = r.summary;
  $("fDifficulty").value = r.difficulty;
  $("fAchievement").value = r.achievement;
  $("fTomorrow").value = r.tomorrow;
  updateReflectionHint();
}

function monthKey(year, month0) { return `${year}-${String(month0+1).padStart(2,"0")}`; }
function renderSummary() {
  const key = monthKey(state.summaryYear, state.summaryMonth);
  $("monthLabel").textContent = `${state.summaryYear}년 ${state.summaryMonth+1}월`;
  const rows = state.logs.filter(x => !x.deleted && x.status !== "pending" && x.date.startsWith(key));
  const requestsReceived = state.logs.filter(x => !x.deleted && ((x.origin === "request" && (x.requestedAt || "").startsWith(key)) || (x.cat === "요청" && !x.requestedAt && x.date.startsWith(key))));
  const pendingCreated = requestsReceived.filter(x => x.status === "pending");
  const highlights = rows.filter(x => x.highlight);
  const self = rows.filter(x => x.origin === "self");
  const requestsProcessed = rows.filter(x => x.origin === "request" || x.cat === "요청");
  const solved = rows.filter(x => x.solved);
  const projects = {};
  rows.forEach(x => { if (x.project) projects[x.project] = (projects[x.project] || 0) + 1; });
  const projectEntries = Object.entries(projects).sort((a,b) => b[1]-a[1]);
  const refl = Object.values(state.reflections).filter(r => r.date.startsWith(key)).sort((a,b) => b.date.localeCompare(a.date));

  const list = arr => arr.length ? `<div class="summary-list">${arr.map(x => {
    const meta = [formatShortDate(x.date)];
    if (x.cat && x.cat !== "업무" && !(x.cat === "해결" && x.solved)) meta.push(CAT_LABEL[x.cat] || x.cat);
    if (x.solved) meta.push("문제해결");
    if (x.requester) meta.push(x.requester);
    if (x.project) meta.push(x.project);
    return `<div class="summary-item"><div class="title">${escapeHtml(x.content)}</div><div class="meta">${meta.map(escapeHtml).join(" · ")}</div></div>`;
  }).join("")}</div>` : `<div class="summary-empty">기록 없음</div>`;
  const reflEntries = refl.filter(r => r.achievement || r.difficulty).slice(0,12);

  $("monthSummary").innerHTML = `
    <section class="summary-card"><h2>대표 업무</h2>${list(highlights)}</section>
    <section class="summary-card"><h2>업무 흐름</h2><div class="metric-grid">
      <div class="metric"><strong>${rows.length}</strong><span>전체 기록</span></div>
      <div class="metric"><strong>${requestsReceived.length}</strong><span>요청받음</span></div>
      <div class="metric"><strong>${requestsProcessed.length}</strong><span>요청 처리</span></div>
      <div class="metric"><strong>${self.length}</strong><span>내가 먼저 함</span></div>
      <div class="metric"><strong>${pendingCreated.length}</strong><span>요청 중 대기</span></div>
    </div></section>
    <section class="summary-card"><h2>내가 먼저 챙긴 일</h2>${list(self)}</section>
    <section class="summary-card"><h2>해결한 문제</h2>${list(solved)}</section>
    <section class="summary-card"><h2>프로젝트·회사 기여</h2>${projectEntries.length ? `<div class="project-chips">${projectEntries.map(([p,n]) => `<span class="project-chip">${escapeHtml(p)} · ${n}</span>`).join("")}</div>` : `<div class="summary-empty">프로젝트를 적은 기록이 아직 없어.</div>`}</section>
    <section class="summary-card"><h2>회고에서 남긴 성장·부담 신호</h2>${reflEntries.length ? `<div class="reflection-month">${reflEntries.map(r => `<div class="entry"><div class="date">${formatShortDate(r.date)}</div>${r.achievement ? `<div class="text"><strong>잘한 점</strong> ${escapeHtml(r.achievement)}</div>` : ""}${r.difficulty ? `<div class="text"><strong>힘들었던 점</strong> ${escapeHtml(r.difficulty)}</div>` : ""}</div>`).join("")}</div>` : `<div class="summary-empty">작성한 회고가 없어.</div>`}</section>`;
}

function allDatesWithData() {
  const set = new Set();
  state.logs.filter(x => !x.deleted && x.status !== "pending").forEach(x => set.add(x.date));
  Object.values(state.reflections).forEach(r => { if (r.summary || r.difficulty || r.achievement || r.tomorrow) set.add(r.date); });
  return [...set].sort().reverse();
}
function renderHistory(filter = $("searchInput").value || "") {
  const q = filter.trim().toLowerCase();
  const dates = allDatesWithData().filter(date => {
    if (!q) return true;
    const items = logsForDate(date);
    const r = getReflection(date);
    return [...items.map(x => [x.content,x.requester,x.project,x.memo,CAT_LABEL[x.cat]||x.cat,x.solved ? "문제해결 해결한 문제" : ""].join(" ")), r.summary,r.difficulty,r.achievement,r.tomorrow].join(" ").toLowerCase().includes(q);
  });
  if (!dates.length) { $("histList").innerHTML = `<div class="hist-empty">검색되는 기록이 없어.</div>`; return; }
  $("histList").innerHTML = dates.map(date => {
    const items = logsForDate(date), r = getReflection(date);
    const preview = r.summary || (items[0] && items[0].content) || "";
    const reflRows = [["한 줄 요약",r.summary],["힘들었던 점",r.difficulty],["잘한 점",r.achievement],["내일은",r.tomorrow]].filter(x => x[1]);
    return `<details class="hist-card"><summary><div class="hist-head"><span class="hist-date">${escapeHtml(formatDateMain(date))}</span><span class="hist-count">${items.length}건</span></div><div class="hist-preview">${escapeHtml(preview)}</div></summary><div class="hist-body">${items.map(logRowHtml).join("")}${reflRows.length ? `<div class="refl-block">${reflRows.map(([k,v]) => `<div class="refl-row"><div class="k">${k}</div><div class="v">${escapeHtml(v)}</div></div>`).join("")}</div>` : ""}</div></details>`;
  }).join("");
}

function renderSettings() {
  $("gasUrlInput").value = isGasUrlSet() ? getGasUrl() : "";
  $("gasTokenInput").value = getGasToken();
  $("dataStatusText").textContent = `기록 ${state.logs.filter(x => !x.deleted).length}건 · 회고 ${Object.keys(state.reflections).length}일 · 전송 대기 ${getOutbox().length}건`;
}
function renderCurrentView() {
  if (state.currentView === "today") renderToday();
  else if (state.currentView === "summary") renderSummary();
  else if (state.currentView === "history") renderHistory();
  else if (state.currentView === "settings") renderSettings();
}
function switchView(view) {
  state.currentView = view;
  document.querySelectorAll(".view").forEach(v => { v.hidden = v.id !== `view-${view}`; });
  document.querySelectorAll(".tab-btn").forEach(b => {
    const active = b.dataset.view === view;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  renderCurrentView();
}

function modalFocusable() {
  if ($("editModal").hidden) return [];
  return [...$("editModal").querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.hidden && el.offsetParent !== null);
}
function openEdit(id) {
  const item = state.logs.find(x => x.id === id); if (!item) return;
  state.editId = id;
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $("editDate").value = item.date;
  $("editTime").value = item.time;
  const legacyCat = item.cat && item.cat !== "업무" ? (CAT_LABEL[item.cat] || item.cat) : "";
  $("editLegacyCatWrap").hidden = !legacyCat;
  $("editLegacyCat").textContent = legacyCat;
  $("editContent").value = item.content;
  $("editOrigin").value = item.origin;
  $("editRequester").value = item.requester;
  $("editRequestedAt").value = item.requestedAt;
  $("editDueDate").value = item.dueDate;
  $("editProject").value = item.project;
  $("editMemo").value = item.memo;
  $("editSolved").checked = !!item.solved;
  $("editHighlight").checked = !!item.highlight;
  $("editRequestFields").hidden = item.origin !== "request";
  $("editReturnPendingBtn").hidden = !(item.origin === "request" && item.status !== "pending");
  $("editModal").hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => $("editContent").focus());
}
function closeEdit() {
  state.editId = null;
  $("editModal").hidden = true;
  document.body.classList.remove("modal-open");
  const target = modalReturnFocus;
  modalReturnFocus = null;
  if (target && document.contains(target)) requestAnimationFrame(() => target.focus());
}
function saveEdit() {
  const id = state.editId; if (!id) return;
  const item = state.logs.find(x => x.id === id); if (!item) return;
  const content = $("editContent").value.trim();
  if (!content) { toast("업무명을 입력해줘"); return; }
  const origin = $("editOrigin").value;
  const date = $("editDate").value;
  const time = $("editTime").value;
  const fields = {
    date, time,
    content, origin,
    requester: origin === "request" ? $("editRequester").value.trim() : "",
    requestedAt: origin === "request" ? $("editRequestedAt").value : "",
    dueDate: origin === "request" ? $("editDueDate").value : "",
    project: $("editProject").value.trim(),
    memo: $("editMemo").value.trim(),
    solved: $("editSolved").checked,
    highlight: $("editHighlight").checked,
    actualStartedAt: item.status === "pending" ? "" : `${date}T${time}`
  };
  if (!updateLog(id, fields)) return;
  closeEdit(); renderCurrentView(); toast("수정했어");
}

function downloadBackup() {
  const data = { exportedAt: new Date().toISOString(), logs: state.logs, reflections: state.reflections, outbox: getOutbox() };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = `업무일지_백업_${todayStr()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function bindEvents() {
  document.querySelectorAll(".origin-chip").forEach(b => b.addEventListener("click", () => {
    state.activeOrigin = b.dataset.origin;
    document.querySelectorAll(".origin-chip").forEach(x => { const on = x === b; x.classList.toggle("active", on); x.setAttribute("aria-pressed", String(on)); });
    $("requestFields").hidden = state.activeOrigin !== "request";
  }));
  document.querySelectorAll(".when-chip").forEach(b => b.addEventListener("click", () => {
    state.requestWhen = b.dataset.when;
    document.querySelectorAll(".when-chip").forEach(x => { const on = x === b; x.classList.toggle("active", on); x.setAttribute("aria-pressed", String(on)); });
    $("requestDueDate").hidden = state.requestWhen !== "date";
    if (state.requestWhen === "date" && !$("requestDueDate").value) $("requestDueDate").value = addDays(todayStr(),1);
  }));
  $("quickAddBtn").addEventListener("click", addQuickLog);
  $("quickContent").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addQuickLog(); } });

  $("prevDay").addEventListener("click", () => { state.currentDate = addDays(state.currentDate,-1); state.followToday = false; renderToday(); });
  $("nextDay").addEventListener("click", () => { state.currentDate = addDays(state.currentDate,1); state.followToday = false; renderToday(); });
  $("todayBtn").addEventListener("click", () => { state.currentDate = todayStr(); state.followToday = true; renderToday(); });

  ["fSummary","fDifficulty","fAchievement","fTomorrow"].forEach(id => {
    const map = {fSummary:"summary",fDifficulty:"difficulty",fAchievement:"achievement",fTomorrow:"tomorrow"};
    $(id).addEventListener("input", e => saveReflectionField(state.currentDate, map[id], e.target.value));
  });

  document.addEventListener("click", e => {
    const start = e.target.closest("[data-start]"); if (start) { startPending(start.dataset.start); return; }
    const tomorrow = e.target.closest("[data-tomorrow]"); if (tomorrow) { postponePending(tomorrow.dataset.tomorrow,1); return; }
    const star = e.target.closest("[data-star]"); if (star) { toggleHighlight(star.dataset.star); return; }
    const edit = e.target.closest("[data-edit]"); if (edit) { openEdit(edit.dataset.edit); return; }
    if (e.target.closest("[data-close-modal]")) closeEdit();
  });

  $("editOrigin").addEventListener("change", e => { $("editRequestFields").hidden = e.target.value !== "request"; });
  $("editSaveBtn").addEventListener("click", saveEdit);
  $("editReturnPendingBtn").addEventListener("click", () => {
    const id = state.editId;
    if (!id || !returnToPending(id)) return;
    closeEdit(); renderCurrentView(); toast("해야 할 요청으로 되돌렸어");
  });
  $("editDeleteBtn").addEventListener("click", () => {
    if (!state.editId) return;
    if (!confirm("이 기록을 삭제할까?")) return;
    const id = state.editId; closeEdit(); deleteLogItem(id); toast("삭제했어");
  });

  document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
  $("prevMonth").addEventListener("click", () => { state.summaryMonth--; if (state.summaryMonth < 0) {state.summaryMonth=11;state.summaryYear--;} renderSummary(); });
  $("nextMonth").addEventListener("click", () => { state.summaryMonth++; if (state.summaryMonth > 11) {state.summaryMonth=0;state.summaryYear++;} renderSummary(); });
  $("searchInput").addEventListener("input", e => renderHistory(e.target.value));

  $("syncBtn").addEventListener("click", () => syncNow(false));
  $("syncNowBtn").addEventListener("click", () => syncNow(false));
  $("gasUrlSave").addEventListener("click", async () => {
    setGasUrl($("gasUrlInput").value);
    setGasToken($("gasTokenInput").value);
    if (!isGasUrlSet()) { $("gasStatusText").textContent = "웹 앱 URL을 입력해줘."; return; }
    $("gasStatusText").textContent = "연결 확인 중";
    const ok = await syncNow(true);
    $("gasStatusText").textContent = ok ? "연결됨" : "연결 실패. URL, 토큰, 배포 권한을 확인해줘.";
    renderSettings();
  });
  $("exportBackupBtn").addEventListener("click", downloadBackup);

  document.addEventListener("keydown", e => {
    if ($("editModal").hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeEdit(); return; }
    if (e.key !== "Tab") return;
    const focusables = modalFocusable();
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  window.addEventListener("online", () => syncNow(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // 오늘을 따라가던 상태일 때만 자정 이후 날짜를 갱신한다. 과거 날짜를 일부러 보고 있으면 유지한다.
      if (state.currentView === "today" && state.followToday) state.currentDate = todayStr();
      renderCurrentView();
      syncNow(true);
    }
  });
}

function init() {
  loadLocal();
  document.querySelectorAll(".origin-chip,.when-chip").forEach(b => b.setAttribute("aria-pressed", String(b.classList.contains("active"))));
  bindEvents();
  renderToday();
  setSyncDot(isGasUrlSet() ? (getOutbox().length ? "pending" : "ok") : "");
  if (isGasUrlSet()) syncNow(true);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
