// ============================================================
// 설정: Apps Script 배포 후 이 URL을 교체하세요.
// ============================================================
const CONFIG = {
  GAS_URL: "https://script.google.com/macros/s/AKfycbzUwwsJ3WQwBln-wAUH_RmORiTJ6F_mPFpRR3U2cY1YSiT8NZor3FzO_K6Vi2uRyjxR/exec"
};

const LS_LOGS = "worklog_logs";
const LS_REFL = "worklog_reflections";
const LS_OUTBOX = "worklog_outbox";

const CATS = ["업무", "회의", "요청", "해결", "기타"];
const CAT_LABEL = { "업무": "업무", "회의": "회의", "요청": "요청받은 일", "해결": "해결한 문제", "기타": "기타" };
const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"];

// ---------------- 상태 ----------------
const state = {
  logs: [],          // {id, date, time, cat, content, updatedAt, deleted}
  reflections: {},   // date -> {summary, difficulty, achievement, tomorrow, updatedAt}
  currentDate: todayStr(),
  activeCat: "업무",
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(), // 0-based
  selectedCalDay: null,
  currentView: "today"
};

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowTimeStr() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return todayStr(dt);
}

function formatDateMain(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}월 ${d}일 ${WEEKDAY_KR[dt.getDay()]}요일`;
}

// ---------------- 로컬 저장 ----------------
function loadLocal() {
  try { state.logs = JSON.parse(localStorage.getItem(LS_LOGS)) || []; } catch (e) { state.logs = []; }
  try { state.reflections = JSON.parse(localStorage.getItem(LS_REFL)) || {}; } catch (e) { state.reflections = {}; }
}

function saveLocalLogs() {
  localStorage.setItem(LS_LOGS, JSON.stringify(state.logs));
}
function saveLocalRefl() {
  localStorage.setItem(LS_REFL, JSON.stringify(state.reflections));
}

function getOutbox() {
  try { return JSON.parse(localStorage.getItem(LS_OUTBOX)) || []; } catch (e) { return []; }
}
function setOutbox(arr) {
  localStorage.setItem(LS_OUTBOX, JSON.stringify(arr));
}
function queueOutbox(action, payload) {
  const box = getOutbox();
  box.push({ action, payload, queuedAt: Date.now() });
  setOutbox(box);
  scheduleSync();
}

// ---------------- 동기화 ----------------
let syncTimer = null;
function scheduleSync() {
  setSyncDot("pending");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flushOutbox, 900);
}

function setSyncDot(status) {
  const el = document.getElementById("syncDot");
  if (!el) return;
  el.className = "sync-dot " + status;
}

async function flushOutbox() {
  if (!CONFIG.GAS_URL || CONFIG.GAS_URL.startsWith("PUT_YOUR")) { setSyncDot(""); return; }
  const box = getOutbox();
  if (box.length === 0) { setSyncDot("ok"); return; }
  setSyncDot("pending");
  const rest = [];
  for (const item of box) {
    try {
      await fetch(CONFIG.GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(item)
      });
    } catch (e) {
      rest.push(item);
    }
  }
  setOutbox(rest);
  setSyncDot(rest.length === 0 ? "ok" : "error");
}

async function fetchAndMergeAll() {
  if (!CONFIG.GAS_URL || CONFIG.GAS_URL.startsWith("PUT_YOUR")) return;
  try {
    setSyncDot("pending");
    const res = await fetch(CONFIG.GAS_URL + "?action=getAll");
    const data = await res.json();
    mergeServerData(data);
    setSyncDot("ok");
  } catch (e) {
    setSyncDot("error");
  }
}

function mergeServerData(data) {
  const serverLogs = data.logs || [];
  const localById = {};
  state.logs.forEach(l => { localById[l.id] = l; });
  serverLogs.forEach(sl => {
    const local = localById[sl.id];
    if (!local || (sl.updatedAt || 0) >= (local.updatedAt || 0)) {
      localById[sl.id] = sl;
    }
  });
  state.logs = Object.values(localById).filter(l => !l.deleted);
  saveLocalLogs();

  const serverRefl = data.reflections || {};
  Object.keys(serverRefl).forEach(date => {
    const s = serverRefl[date];
    const l = state.reflections[date];
    if (!l || (s.updatedAt || 0) >= (l.updatedAt || 0)) {
      state.reflections[date] = s;
    }
  });
  saveLocalRefl();
  renderCurrentView();
}

window.addEventListener("online", () => { flushOutbox(); fetchAndMergeAll(); });

// ---------------- 로그 항목 ----------------
function addLogItem(cat, time, content) {
  content = content.trim();
  if (!content) return;
  const item = {
    id: uid(),
    date: state.currentDate,
    time: time || nowTimeStr(),
    cat,
    content,
    updatedAt: Date.now()
  };
  state.logs.push(item);
  saveLocalLogs();
  queueOutbox("ADD_LOG", item);
  renderToday();
}

function addLogItemForDate(date, cat, time, content) {
  content = content.trim();
  if (!content) return;
  const item = { id: uid(), date, time: time || "00:00", cat, content, updatedAt: Date.now() };
  state.logs.push(item);
  saveLocalLogs();
  queueOutbox("ADD_LOG", item);
}

function deleteLogItem(id) {
  const idx = state.logs.findIndex(l => l.id === id);
  if (idx === -1) return;
  state.logs.splice(idx, 1);
  saveLocalLogs();
  queueOutbox("DELETE_LOG", { id, updatedAt: Date.now() });
}

function updateLogContent(id, content) {
  const item = state.logs.find(l => l.id === id);
  if (!item) return;
  content = content.trim();
  if (!content) { deleteLogItem(id); renderCurrentView(); return; }
  item.content = content;
  item.updatedAt = Date.now();
  saveLocalLogs();
  queueOutbox("UPDATE_LOG", item);
}

function logsForDate(date) {
  return state.logs.filter(l => l.date === date).sort((a, b) => a.time.localeCompare(b.time));
}

// ---------------- 회고(리플렉션) ----------------
const FIELD_MAP = { fSummary: "summary", fDifficulty: "difficulty", fAchievement: "achievement", fTomorrow: "tomorrow" };
let reflTimers = {};

function getReflection(date) {
  return state.reflections[date] || { summary: "", difficulty: "", achievement: "", tomorrow: "", updatedAt: 0 };
}

function saveReflectionField(date, field, value) {
  if (!state.reflections[date]) state.reflections[date] = { summary: "", difficulty: "", achievement: "", tomorrow: "", updatedAt: 0 };
  state.reflections[date][field] = value;
  state.reflections[date].updatedAt = Date.now();
  saveLocalRefl();
  clearTimeout(reflTimers[date]);
  reflTimers[date] = setTimeout(() => {
    queueOutbox("UPSERT_REFLECTION", { date, ...state.reflections[date] });
    const hint = document.getElementById("saveHint");
    if (hint) { hint.textContent = "저장됨"; setTimeout(() => { if (hint) hint.textContent = "\u00A0"; }, 1500); }
  }, 500);
  updateReflectionHint();
}

function updateReflectionHint() {
  const r = getReflection(state.currentDate);
  const hint = document.getElementById("reflectionHint");
  if (!hint) return;
  hint.textContent = r.summary ? r.summary.slice(0, 16) : "비어있음";
}

// ============================================================
// 렌더링: 오늘 뷰
// ============================================================
function renderToday() {
  document.getElementById("todayDateMain").textContent = formatDateMain(state.currentDate);
  const [y] = state.currentDate.split("-");
  document.getElementById("todayDateSub").textContent = y + "년";

  const items = logsForDate(state.currentDate);
  const tl = document.getElementById("timeline");
  tl.innerHTML = "";
  if (items.length === 0) {
    tl.innerHTML = `<div class="timeline-empty">아직 기록이 없어요. 위에서 바로 적어보세요.</div>`;
  } else {
    items.forEach(item => {
      const row = document.createElement("div");
      row.className = "log-item";
      row.dataset.cat = item.cat;
      row.innerHTML = `
        <div class="time">${item.time}</div>
        <div class="bar"></div>
        <div class="content" data-id="${item.id}">
          <span class="cat-label">${CAT_LABEL[item.cat] || item.cat}</span><span class="txt">${escapeHtml(item.content)}</span>
        </div>
        <button class="del" data-id="${item.id}" aria-label="삭제">×</button>
      `;
      tl.appendChild(row);
    });
  }

  const r = getReflection(state.currentDate);
  document.getElementById("fSummary").value = r.summary || "";
  document.getElementById("fDifficulty").value = r.difficulty || "";
  document.getElementById("fAchievement").value = r.achievement || "";
  document.getElementById("fTomorrow").value = r.tomorrow || "";
  updateReflectionHint();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// 렌더링: 캘린더 뷰
// ============================================================
function renderCalendar() {
  document.getElementById("monthLabel").textContent = `${state.calYear}년 ${state.calMonth + 1}월`;
  const grid = document.getElementById("calDays");
  grid.innerHTML = "";

  const first = new Date(state.calYear, state.calMonth, 1);
  const startOffset = (first.getDay() + 6) % 7; // 월요일 시작
  const daysInMonth = new Date(state.calYear, state.calMonth + 1, 0).getDate();
  const prevDaysInMonth = new Date(state.calYear, state.calMonth, 0).getDate();

  const cells = [];
  for (let i = startOffset - 1; i >= 0; i--) {
    cells.push({ day: prevDaysInMonth - i, other: true, dateStr: null });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const m = String(state.calMonth + 1).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    cells.push({ day: d, other: false, dateStr: `${state.calYear}-${m}-${dd}` });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ day: cells.length, other: true, dateStr: null });
  }

  const todayS = todayStr();
  cells.forEach(cell => {
    const div = document.createElement("div");
    div.className = "cal-day" + (cell.other ? " other-month" : "");
    if (cell.dateStr === todayS) div.classList.add("today");
    if (cell.dateStr === state.selectedCalDay) div.classList.add("selected");
    const meetingCount = cell.dateStr ? state.logs.filter(l => l.date === cell.dateStr && l.cat === "회의").length : 0;
    let dotsHtml = "";
    if (meetingCount > 0) {
      const n = Math.min(meetingCount, 3);
      dotsHtml = `<div class="dots">${"<span class=\"dot\"></span>".repeat(n)}</div>`;
    }
    div.innerHTML = `<span>${cell.day}</span>${dotsHtml}`;
    if (cell.dateStr) {
      div.addEventListener("click", () => {
        state.selectedCalDay = cell.dateStr;
        renderCalendar();
        renderDaySheet(cell.dateStr);
      });
    }
    grid.appendChild(div);
  });

  if (state.selectedCalDay) {
    renderDaySheet(state.selectedCalDay);
  } else {
    document.getElementById("daySheet").hidden = true;
  }
}

function renderDaySheet(dateStr) {
  const sheet = document.getElementById("daySheet");
  sheet.hidden = false;
  const meetings = state.logs.filter(l => l.date === dateStr && l.cat === "회의").sort((a, b) => a.time.localeCompare(b.time));
  const listHtml = meetings.length
    ? meetings.map(m => `<div class="log-item" data-cat="회의"><div class="time">${m.time}</div><div class="bar"></div><div class="content">${escapeHtml(m.content)}</div><button class="del" data-id="${m.id}" aria-label="삭제">×</button></div>`).join("")
    : `<div class="empty">이 날 기록된 회의가 없어요.</div>`;

  sheet.innerHTML = `
    <h3>${formatDateMain(dateStr)}</h3>
    ${listHtml}
    <div class="sched-form">
      <input type="time" id="schedTime" value="${nowTimeStr()}">
      <input type="text" id="schedContent" placeholder="회의/일정 내용">
      <button id="schedAdd">추가</button>
    </div>
    <div class="goto" id="gotoDay">이 날 업무일지 전체 보기 →</div>
  `;

  sheet.querySelectorAll(".del").forEach(btn => {
    btn.addEventListener("click", () => {
      deleteLogItem(btn.dataset.id);
      renderCalendar();
    });
  });
  document.getElementById("schedAdd").addEventListener("click", () => {
    const t = document.getElementById("schedTime").value;
    const c = document.getElementById("schedContent").value;
    if (!c.trim()) return;
    addLogItemForDate(dateStr, "회의", t, c);
    renderCalendar();
  });
  document.getElementById("gotoDay").addEventListener("click", () => {
    state.currentDate = dateStr;
    switchView("today");
  });
}

// ============================================================
// 렌더링: 히스토리 뷰
// ============================================================
function allDatesWithData() {
  const set = new Set();
  state.logs.forEach(l => set.add(l.date));
  Object.keys(state.reflections).forEach(d => {
    const r = state.reflections[d];
    if (r.summary || r.difficulty || r.achievement || r.tomorrow) set.add(d);
  });
  return Array.from(set).sort().reverse();
}

function renderHistory(filter = "") {
  const list = document.getElementById("histList");
  list.innerHTML = "";
  const dates = allDatesWithData();
  const q = filter.trim().toLowerCase();

  const filtered = dates.filter(date => {
    if (!q) return true;
    const items = logsForDate(date);
    const r = getReflection(date);
    const hay = [
      ...items.map(i => i.content),
      r.summary, r.difficulty, r.achievement, r.tomorrow
    ].join(" ").toLowerCase();
    return hay.includes(q);
  });

  if (filtered.length === 0) {
    list.innerHTML = `<div class="hist-empty">기록이 아직 없어요.</div>`;
    return;
  }

  filtered.forEach(date => {
    const items = logsForDate(date);
    const r = getReflection(date);
    const det = document.createElement("details");
    det.className = "hist-card";
    const previewText = r.summary || (items[0] ? items[0].content : "");
    det.innerHTML = `
      <summary>
        <div class="row1">
          <span class="hdate">${formatDateMain(date)}</span>
          <span class="hcount">${items.length}건</span>
        </div>
        <div class="hsummary">${escapeHtml(previewText)}</div>
      </summary>
      <div class="hbody">
        ${items.map(i => `<div class="log-item" data-cat="${i.cat}"><div class="time">${i.time}</div><div class="bar"></div><div class="content"><span class="cat-label">${CAT_LABEL[i.cat] || i.cat}</span>${escapeHtml(i.content)}</div></div>`).join("") || `<div class="timeline-empty">기록된 일 없음</div>`}
        ${(r.summary || r.difficulty || r.achievement || r.tomorrow) ? `
        <div class="refl-block">
          ${r.difficulty ? `<div><div class="k">어려웠던 점 &amp; 이유</div><div class="v">${escapeHtml(r.difficulty)}</div></div>` : ""}
          ${r.achievement ? `<div><div class="k">잘한 점</div><div class="v">${escapeHtml(r.achievement)}</div></div>` : ""}
          ${r.tomorrow ? `<div><div class="k">내일은?</div><div class="v">${escapeHtml(r.tomorrow)}</div></div>` : ""}
        </div>` : ""}
      </div>
    `;
    list.appendChild(det);
  });
}

// ============================================================
// 뷰 전환
// ============================================================
function switchView(view) {
  state.currentView = view;
  document.getElementById("view-today").hidden = view !== "today";
  document.getElementById("view-calendar").hidden = view !== "calendar";
  document.getElementById("view-history").hidden = view !== "history";
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  renderCurrentView();
}

function renderCurrentView() {
  if (state.currentView === "today") renderToday();
  else if (state.currentView === "calendar") renderCalendar();
  else if (state.currentView === "history") renderHistory(document.getElementById("searchInput").value);
}

// ============================================================
// 이벤트 바인딩
// ============================================================
function initEvents() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.querySelectorAll(".chip").forEach(chip => {
    if (chip.dataset.cat === state.activeCat) chip.classList.add("active");
    chip.addEventListener("click", () => {
      state.activeCat = chip.dataset.cat;
      document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
    });
  });

  document.getElementById("itemTime").value = nowTimeStr();

  const contentInput = document.getElementById("itemContent");
  const addBtn = document.getElementById("addBtn");
  function doAdd() {
    const time = document.getElementById("itemTime").value || nowTimeStr();
    addLogItem(state.activeCat, time, contentInput.value);
    contentInput.value = "";
    document.getElementById("itemTime").value = nowTimeStr();
    contentInput.focus();
  }
  addBtn.addEventListener("click", doAdd);
  contentInput.addEventListener("keydown", e => { if (e.key === "Enter") doAdd(); });

  document.getElementById("timeline").addEventListener("click", e => {
    if (e.target.classList.contains("del")) {
      deleteLogItem(e.target.dataset.id);
      renderToday();
    }
  });
  // 항목 내용 탭하면 인라인 수정
  document.getElementById("timeline").addEventListener("click", e => {
    const el = e.target.closest(".content");
    if (!el || el.querySelector("input")) return;
    const id = el.dataset.id;
    const item = state.logs.find(l => l.id === id);
    if (!item) return;
    const input = document.createElement("input");
    input.type = "text";
    input.value = item.content;
    input.style.width = "100%";
    input.style.border = "1px solid var(--line)";
    input.style.borderRadius = "6px";
    input.style.padding = "4px 6px";
    input.style.font = "inherit";
    el.innerHTML = "";
    el.appendChild(input);
    input.focus();
    input.select();
    function commit() { updateLogContent(id, input.value); renderToday(); }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); });
  });

  document.getElementById("prevDay").addEventListener("click", () => { state.currentDate = addDays(state.currentDate, -1); renderToday(); });
  document.getElementById("nextDay").addEventListener("click", () => { state.currentDate = addDays(state.currentDate, 1); renderToday(); });
  document.getElementById("todayBtn").addEventListener("click", () => { state.currentDate = todayStr(); renderToday(); });

  Object.keys(FIELD_MAP).forEach(elId => {
    const el = document.getElementById(elId);
    el.addEventListener("input", () => saveReflectionField(state.currentDate, FIELD_MAP[elId], el.value));
  });

  document.getElementById("prevMonth").addEventListener("click", () => {
    state.calMonth--; if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; }
    state.selectedCalDay = null;
    renderCalendar();
  });
  document.getElementById("nextMonth").addEventListener("click", () => {
    state.calMonth++; if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; }
    state.selectedCalDay = null;
    renderCalendar();
  });

  document.getElementById("searchInput").addEventListener("input", e => renderHistory(e.target.value));
}

// ============================================================
// 시작
// ============================================================
function init() {
  loadLocal();
  initEvents();
  renderToday();
  flushOutbox();
  fetchAndMergeAll();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
