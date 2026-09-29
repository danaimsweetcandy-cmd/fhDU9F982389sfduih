// ============================================================
// 업무일지 PWA v8.4
// 기록은 가볍게, 데이터는 보수적으로 보존하는 출시 후보
// ============================================================
const CONFIG = { GAS_URL: "PUT_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE" };
const APP_VERSION = "8.4.0";
const APP_ID = "dayeon-worklog";
const API_SCHEMA_VERSION = 3;
const REQUIRED_SERVER_CAPABILITY = "contextFlagsV1";

const LS_LOGS = "worklog_logs";
const LS_REFL = "worklog_reflections";
const LS_OUTBOX = "worklog_outbox";
const LS_GAS_URL = "worklog_gas_url";
const LS_GAS_TOKEN = "worklog_gas_token";
const LS_DEVICE_ID = "worklog_device_id";
const LS_STORE_ID = "worklog_store_id";
const LS_REV = "worklog_server_revision";
const LS_RECOVERY = "worklog_recovery";
const LS_TXN = "worklog_storage_journal";
const LS_LAST_SYNC = "worklog_last_success_sync";
const LS_SYNC_LEASE = "worklog_sync_lease";
const MAX_GAS_URL_LENGTH = 6500;
const FETCH_TIMEOUT_MS = 15000;
const SYNC_LEASE_MS = 25000;
const RECOVERY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_MAX = 100;
const ALLOWED_ACTIONS = new Set(["ADD_LOG","UPDATE_LOG","DELETE_LOG","UPSERT_REFLECTION"]);

const CAT_LABEL = {
  "업무": "업무", "수정": "수정", "검수": "검수", "진행관리": "진행관리",
  "회의": "회의", "해결": "해결한 문제", "기타": "기타", "요청": "요청받은 일"
};
const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"];

const state = {
  logs: [], reflections: {}, currentDate: todayStr(), activeOrigin: "", requestWhen: "now",
  summaryYear: new Date().getFullYear(), summaryMonth: new Date().getMonth(), currentView: "today",
  editId: null, followToday: true, serverStoreId: "", serverRevision: 0, clockSkewMs: 0
};

let syncTimer = null;
let flushing = false;
let syncRunning = false;
const protectedCorruptKeys = new Set();
let resyncRequested = false;
let toastTimer = null;
let lastSyncError = "";
let reflTimers = {};
const inFlightQids = new Set();
let modalReturnFocus = null;
const TAB_ID = "tab-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
let DEVICE_ID = "";
let lastMutationAt = 0;
let sharedChannel = null;
let serverCapabilityVerified = false;

function $(id) { return document.getElementById(id); }
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}
function qid() { return "q-" + Date.now() + "-" + Math.random().toString(16).slice(2); }
function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function nowTimeStr(d = new Date()) { return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); }
function nowLocalDateTime(d = new Date()) { return `${todayStr(d)}T${nowTimeStr(d)}`; }
function addDays(dateStr, n) {
  const d = normalizeDateStr(dateStr); if (!d) return "";
  const [y,m,day] = d.split("-").map(Number), dt = new Date(y,m-1,day); dt.setDate(dt.getDate()+n); return todayStr(dt);
}
function normalizeDateStr(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return todayStr(value);
  const s = String(value == null ? "" : value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return "";
  const y=Number(m[1]), mo=Number(m[2]), d=Number(m[3]), dt=new Date(y,mo-1,d);
  return dt.getFullYear()===y && dt.getMonth()===mo-1 && dt.getDate()===d ? s : "";
}
function normalizeTimeStr(value) {
  const s=String(value==null?"":value).trim(), m=s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/); if(!m)return "";
  const h=Number(m[1]), min=Number(m[2]); return h>=0&&h<=23&&min>=0&&min<=59 ? `${String(h).padStart(2,"0")}:${m[2]}` : "";
}
function normalizeDateTimeLocal(value) {
  const s=String(value||"").trim(), m=s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/); if(!m)return "";
  const d=normalizeDateStr(m[1]), t=normalizeTimeStr(`${m[2]}:${m[3]}`); return d&&t ? `${d}T${t}` : "";
}
function formatDateMain(dateStr) {
  const d=normalizeDateStr(dateStr); if(!d)return "날짜 미상"; const [y,m,day]=d.split("-").map(Number); const dt=new Date(y,m-1,day);
  return `${m}월 ${day}일 ${WEEKDAY_KR[dt.getDay()]}요일`;
}
function formatShortDate(dateStr) { const d=normalizeDateStr(dateStr); if(!d)return ""; const [,m,day]=d.split("-"); return `${Number(m)}/${Number(day)}`; }
function formatDateTime(value) { const v=normalizeDateTimeLocal(value); if(!v)return ""; const [d,t]=v.split("T"); return `${formatShortDate(d)} ${t}`; }
function escapeHtml(value) { const div=document.createElement("div"); div.textContent=String(value==null?"":value); return div.innerHTML; }
function escapeAttr(value) { return String(value==null?"":value).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function toast(msg) {
  const el=$("toast"); if(!el)return; el.textContent=msg; el.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>{el.hidden=true;},2200);
}

function rawSet(key, value) { localStorage.setItem(key, value); }
function safeStorageSet(key, value, quiet=false) {
  try { rawSet(key, value); return true; }
  catch { if(!quiet){setSyncDot("error");toast("기기 저장 공간에 쓰지 못했어. 백업 후 저장 공간을 확인해줘.");} return false; }
}
function quarantineRaw(key, raw, reason) {
  if (raw == null) return true;
  const backupKey = `${key}.corrupt.${Date.now()}`;
  try {
    rawSet(backupKey, JSON.stringify({reason, raw}));
    localStorage.removeItem(key);
    return true;
  } catch {
    protectedCorruptKeys.add(key);
    return false;
  }
}
function preserveInvalidItems(key, items, reason) {
  if (!items || !items.length) return true;
  try { rawSet(`${key}.corrupt.${Date.now()}`, JSON.stringify({reason, items})); return true; } catch { protectedCorruptKeys.add(key); return false; }
}
function recoverStorageJournal() {
  const raw=localStorage.getItem(LS_TXN); if(!raw)return true;
  try {
    const j=JSON.parse(raw); if(!j||!Array.isArray(j.changes))throw new Error("invalid journal");
    for(const c of j.changes){ if(!c||typeof c.key!=="string"||typeof c.after!=="string")throw new Error("invalid journal item"); rawSet(c.key,c.after); }
    localStorage.removeItem(LS_TXN); return true;
  } catch(e) {
    quarantineRaw(LS_TXN, raw, "storage journal recovery failed");
    return false;
  }
}
function commitStorageChanges(changes) {
  for (const key of Object.keys(changes)) { if (protectedCorruptKeys.has(key)) { toast("손상된 원본을 안전하게 보관하지 못해서 이 데이터에는 새로 저장하지 않았어. 저장 공간을 확보한 뒤 앱을 다시 열어줘."); return false; } }
  const entries=Object.entries(changes).map(([key,after])=>({key,before:localStorage.getItem(key),after:String(after)}));
  const journal=JSON.stringify({id:qid(),createdAt:Date.now(),changes:entries});
  try {
    rawSet(LS_TXN,journal);
    entries.forEach(c=>rawSet(c.key,c.after));
    localStorage.removeItem(LS_TXN);
    return true;
  } catch(e) {
    try {
      for(const c of entries){ if(c.before===null)localStorage.removeItem(c.key); else rawSet(c.key,c.before); }
      localStorage.removeItem(LS_TXN);
    } catch {}
    setSyncDot("error"); toast("저장에 실패해서 변경을 적용하지 않았어. 저장 공간을 확인해줘.");
    return false;
  }
}

function getGasUrl() { return (localStorage.getItem(LS_GAS_URL)||CONFIG.GAS_URL||"").trim(); }
function getGasToken() { return (localStorage.getItem(LS_GAS_TOKEN)||"").trim(); }
function getStoreId() { return (localStorage.getItem(LS_STORE_ID)||"").trim(); }
function getServerRevision() { const n=Number(localStorage.getItem(LS_REV)); return Number.isFinite(n)&&n>=0?Math.floor(n):0; }
function isGasUrlSet() { const u=getGasUrl(); return !!u&&!u.startsWith("PUT_YOUR"); }
function getDeviceId() {
  let id=(localStorage.getItem(LS_DEVICE_ID)||"").trim();
  if(!id){ id="dev-"+uid(); safeStorageSet(LS_DEVICE_ID,id,true); }
  return id;
}

function mutationTimestamp(previous=0) {
  const now=Date.now(); const next=Math.max(now,lastMutationAt+1,Number(previous||0)+1); lastMutationAt=next; return next;
}
function versionCompare(a,b) {
  const at=Number((a&&a.updatedAt)||0), bt=Number((b&&b.updatedAt)||0); if(at!==bt)return at>bt?1:-1;
  const ad=String((a&&a.deviceId)||""), bd=String((b&&b.deviceId)||""); if(ad===bd)return 0; return ad>bd?1:-1;
}
function boolValue(v) { return v===true||v===1||v==="1"||v==="Y"||String(v).toLowerCase()==="true"; }
function normalizeLog(raw) {
  if(!raw||typeof raw!=="object")return null;
  const id=String(raw.id||"").trim(), date=normalizeDateStr(raw.date); if(!id||!date)return null;
  const cat=String(raw.cat||"업무");
  const hasSolved=raw.solved!==undefined&&raw.solved!==null&&raw.solved!=="";
  const hasMeeting=raw.meeting!==undefined&&raw.meeting!==null&&raw.meeting!=="";
  const hasSupport=raw.support!==undefined&&raw.support!==null&&raw.support!=="";
  const origin=raw.origin==="request"||raw.origin==="self"?raw.origin:"";
  let status=raw.status==="pending"?"pending":"logged"; if(status==="pending"&&origin!=="request")status="logged";
  const updated=Number(raw.updatedAt);
  return {...raw,id,date,time:normalizeTimeStr(raw.time)||"00:00",cat,content:String(raw.content||""),
    updatedAt:Number.isFinite(updated)&&updated>=0?updated:0,deleted:boolValue(raw.deleted),origin,requester:String(raw.requester||""),
    requestedAt:normalizeDateTimeLocal(raw.requestedAt),dueDate:normalizeDateStr(raw.dueDate),project:String(raw.project||""),memo:String(raw.memo||""),
    solved:hasSolved?boolValue(raw.solved):cat==="해결",
    meeting:hasMeeting?boolValue(raw.meeting):cat==="회의",
    support:hasSupport?boolValue(raw.support):false,
    highlight:boolValue(raw.highlight),status,
    actualStartedAt:normalizeDateTimeLocal(raw.actualStartedAt),deviceId:String(raw.deviceId||""),rev:Number(raw.rev)||0};
}
function normalizeReflection(raw,key) {
  if(!raw||typeof raw!=="object")return null; const date=normalizeDateStr(raw.date||key); if(!date)return null; const updated=Number(raw.updatedAt);
  return {date,summary:String(raw.summary||""),difficulty:String(raw.difficulty||""),achievement:String(raw.achievement||""),tomorrow:String(raw.tomorrow||""),
    updatedAt:Number.isFinite(updated)&&updated>=0?updated:0,deviceId:String(raw.deviceId||""),rev:Number(raw.rev)||0};
}
function readJsonRaw(key, fallback) {
  const raw=localStorage.getItem(key); if(raw==null)return fallback;
  try{return JSON.parse(raw);}catch{ if(!quarantineRaw(key,raw,"JSON parse failed"))toast("손상된 로컬 데이터를 별도 보관하지 못했어. 저장 공간을 확보해줘."); return fallback; }
}
function readLogsStorage() {
  const parsed=readJsonRaw(LS_LOGS,[]); if(!Array.isArray(parsed)){quarantineRaw(LS_LOGS,JSON.stringify(parsed),"logs is not array");return [];}
  const valid=[], bad=[]; for(const x of parsed){const n=normalizeLog(x); if(n)valid.push(n); else bad.push(x);} if(bad.length&&preserveInvalidItems(LS_LOGS,bad,"invalid log rows")) safeStorageSet(LS_LOGS,JSON.stringify(valid),true); return valid;
}
function readReflectionsStorage() {
  const parsed=readJsonRaw(LS_REFL,{}); if(!parsed||Array.isArray(parsed)||typeof parsed!=="object"){quarantineRaw(LS_REFL,JSON.stringify(parsed),"reflections is not object");return {};}
  const out={},bad=[]; for(const [k,v] of Object.entries(parsed)){const r=normalizeReflection(v,k); if(r&&(!out[r.date]||versionCompare(r,out[r.date])>=0))out[r.date]=r; else if(!r)bad.push([k,v]);}
  if(bad.length&&preserveInvalidItems(LS_REFL,bad,"invalid reflection rows")) safeStorageSet(LS_REFL,JSON.stringify(out),true); return out;
}
function validOutboxItem(item) { return !!(item&&typeof item==="object"&&ALLOWED_ACTIONS.has(item.action)&&item.payload&&typeof item.payload==="object"&&typeof item.qid==="string"&&item.qid); }
function getOutbox() {
  const parsed=readJsonRaw(LS_OUTBOX,[]); if(!Array.isArray(parsed)){quarantineRaw(LS_OUTBOX,JSON.stringify(parsed),"outbox is not array");return [];}
  const valid=[],bad=[]; for(const item of parsed){ if(validOutboxItem(item))valid.push({...item,queuedAt:Number(item.queuedAt)||Date.now()}); else bad.push(item); }
  if(bad.length){if(preserveInvalidItems(LS_OUTBOX,bad,"invalid outbox items")) safeStorageSet(LS_OUTBOX,JSON.stringify(valid),true);} return valid;
}
function setOutbox(v) { return safeStorageSet(LS_OUTBOX,JSON.stringify(v)); }
function loadLocal() { recoverStorageJournal(); state.logs=readLogsStorage(); state.reflections=readReflectionsStorage(); getOutbox(); }
function reloadSharedState() { state.logs=readLogsStorage(); state.reflections=readReflectionsStorage(); renderCurrentView(); refreshSyncState(); }
function getOutboxKey(action,payload) { if(!payload)return null; if(action==="UPSERT_REFLECTION")return "REFL:"+payload.date; if(payload.id!==undefined)return "LOG:"+payload.id; return null; }
function enqueueInBox(source,action,payload) {
  const box=source.map(x=>({...x})), key=getOutboxKey(action,payload);
  if(key){ const idx=box.findIndex(x=>getOutboxKey(x.action,x.payload)===key); if(idx!==-1){ const prev=box[idx];
      if(action==="DELETE_LOG"&&prev.action==="ADD_LOG"&&!inFlightQids.has(prev.qid)){box.splice(idx,1);return box;}
      let mergedAction=action; if(prev.action==="ADD_LOG"&&action==="UPDATE_LOG")mergedAction="ADD_LOG";
      box[idx]={action:mergedAction,payload,queuedAt:Date.now(),qid:qid()}; return box; }}
  box.push({action,payload,queuedAt:Date.now(),qid:qid()}); return box;
}
function notifySharedChange() { try{sharedChannel&&sharedChannel.postMessage({type:"data-changed",from:TAB_ID});}catch{} }
function persistLogAndQueue(nextLogs,action,payload) {
  const nextBox=enqueueInBox(getOutbox(),action,payload);
  if(!commitStorageChanges({[LS_LOGS]:JSON.stringify(nextLogs),[LS_OUTBOX]:JSON.stringify(nextBox)}))return false;
  state.logs=nextLogs; scheduleSync(); notifySharedChange(); return true;
}
function persistReflectionAndQueue(nextRefl,payload) {
  const nextBox=enqueueInBox(getOutbox(),"UPSERT_REFLECTION",payload);
  if(!commitStorageChanges({[LS_REFL]:JSON.stringify(nextRefl),[LS_OUTBOX]:JSON.stringify(nextBox)}))return false;
  state.reflections=nextRefl; scheduleSync(); notifySharedChange(); return true;
}
function addRecovery(kind,key,loser,winner) {
  if(!loser)return; let arr=readJsonRaw(LS_RECOVERY,[]); if(!Array.isArray(arr))arr=[]; const now=Date.now();
  arr=arr.filter(x=>x&&now-Number(x.savedAt||0)<RECOVERY_KEEP_MS); arr.push({kind,key,loser,winnerVersion:{updatedAt:winner&&winner.updatedAt,deviceId:winner&&winner.deviceId},savedAt:now});
  if(arr.length>RECOVERY_MAX)arr=arr.slice(-RECOVERY_MAX); safeStorageSet(LS_RECOVERY,JSON.stringify(arr),true);
}

function scheduleSync() { setSyncDot(navigator.onLine?"pending":"offline"); clearTimeout(syncTimer); syncTimer=setTimeout(()=>{if(flushing){resyncRequested=true;return;}syncNow(true);},800); }
function setSyncDot(status) {
  const el=$("syncDot"); if(el)el.className="sync-dot"+(status?" "+status:"");
  const labels={"":"동기화 미설정",ok:"동기화 완료",pending:"전송 대기 중",syncing:"동기화 중",offline:"오프라인 · 전송 대기",error:"동기화 오류"};
  const label=labels[status]||"동기화 상태", text=$("syncStatusText"); if(text)text.textContent=label;
  const btn=$("syncBtn"); if(btn){btn.setAttribute("aria-label",`지금 동기화. 현재 ${label}`);btn.title=`지금 동기화 · ${label}`;}
}
function refreshSyncState() { if(!isGasUrlSet())setSyncDot(""); else if(!navigator.onLine)setSyncDot("offline"); else setSyncDot(getOutbox().length?"pending":"ok"); }
function acquireSyncLease() {
  const now=Date.now(); try{const cur=JSON.parse(localStorage.getItem(LS_SYNC_LEASE)||"null"); if(cur&&cur.owner!==TAB_ID&&Number(cur.expiresAt)>now)return false;}catch{}
  const mine={owner:TAB_ID,expiresAt:now+SYNC_LEASE_MS}; if(!safeStorageSet(LS_SYNC_LEASE,JSON.stringify(mine),true))return false;
  try{const check=JSON.parse(localStorage.getItem(LS_SYNC_LEASE)||"null");return !!check&&check.owner===TAB_ID;}catch{return false;}
}
function renewSyncLease() { try{const cur=JSON.parse(localStorage.getItem(LS_SYNC_LEASE)||"null"); if(cur&&cur.owner===TAB_ID)rawSet(LS_SYNC_LEASE,JSON.stringify({owner:TAB_ID,expiresAt:Date.now()+SYNC_LEASE_MS}));}catch{} }
function releaseSyncLease() { try{const cur=JSON.parse(localStorage.getItem(LS_SYNC_LEASE)||"null"); if(cur&&cur.owner===TAB_ID)localStorage.removeItem(LS_SYNC_LEASE);}catch{} }

class SyncError extends Error { constructor(message,code,transient=false){super(message);this.code=code||"SYNC";this.transient=transient;} }
function validateEnvelope(data,expectedStoreId) {
  if(!data||typeof data!=="object")throw new SyncError("서버 응답 형식이 올바르지 않아","BAD_RESPONSE");
  if(data.appId!==APP_ID)throw new SyncError("업무일지용 Apps Script가 아니야","WRONG_APP");
  if(Number(data.schemaVersion)!==API_SCHEMA_VERSION)throw new SyncError("앱과 Apps Script 버전이 맞지 않아","SCHEMA_MISMATCH");
  if(!Array.isArray(data.capabilities)||!data.capabilities.includes(REQUIRED_SERVER_CAPABILITY))throw new SyncError("Apps Script를 v8.4 버전으로 먼저 업데이트해줘","SERVER_UPDATE_REQUIRED");
  if(!data.storeId)throw new SyncError("시트 식별값이 없어","BAD_RESPONSE");
  if(expectedStoreId&&data.storeId!==expectedStoreId)throw new SyncError("현재 연결된 시트와 다른 시트야","WRONG_STORE");
  const serverTime=Number(data.serverTime); if(Number.isFinite(serverTime))state.clockSkewMs=Date.now()-serverTime;
  state.serverStoreId=String(data.storeId); state.serverRevision=Number(data.revision)||0;
  if(data.ok===false)throw new SyncError(data.error||"동기화 오류",data.code||"SERVER_ERROR",false);
  return data;
}
function buildGasUrl(action,payload,params={},baseUrl=getGasUrl(),token=getGasToken()) {
  const p=new URLSearchParams(); p.set("action",action); p.set("token",token||""); if(payload!==undefined)p.set("payload",JSON.stringify(payload));
  Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=="")p.set(k,String(v));}); const url=baseUrl+"?"+p.toString();
  if(url.length>MAX_GAS_URL_LENGTH)throw new SyncError("기록이 너무 길어서 시트에 전송할 수 없어. 내용을 조금 줄여줘.","URL_TOO_LONG"); return url;
}
async function fetchOnce(url) {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);
  try{
    const res=await fetch(url,{cache:"no-store",signal:controller.signal});
    if(!res.ok)throw new SyncError(`서버 HTTP 오류 ${res.status}`,`HTTP_${res.status}`,res.status===429||res.status>=500);
    return await res.text();
  }catch(e){ if(e&&e.name==="AbortError")throw new SyncError("서버 응답 시간이 너무 길어","TIMEOUT",true); if(e instanceof SyncError)throw e; throw new SyncError("네트워크 연결에 실패했어","NETWORK",true); }
  finally{clearTimeout(timer);}
}
async function gasCall(action,payload,params={},options={}) {
  const baseUrl=options.url!==undefined?options.url:getGasUrl(), token=options.token!==undefined?options.token:getGasToken();
  const expectedStore=options.expectedStoreId===null?"":(options.expectedStoreId!==undefined?options.expectedStoreId:getStoreId());
  const url=buildGasUrl(action,payload,params,baseUrl,token); let last;
  for(let attempt=0;attempt<3;attempt++){
    try{const txt=await fetchOnce(url);let data;try{data=JSON.parse(txt);}catch{throw new SyncError("서버 응답을 읽지 못했어","BAD_JSON");}return validateEnvelope(data,expectedStore);}
    catch(e){last=e;if(!(e instanceof SyncError)||!e.transient||attempt===2)throw e; await new Promise(r=>setTimeout(r,[350,900,1800][attempt]+Math.floor(Math.random()*250)));}
  }
  throw last;
}
async function verifyServerCompatibility() {
  if(serverCapabilityVerified)return true;
  await gasCall("meta");
  serverCapabilityVerified=true;
  return true;
}
async function flushOutbox() {
  const snapshot=getOutbox(); if(!snapshot.length)return true; flushing=true; let failed=false; lastSyncError="";
  try{
    for(const item of snapshot){ renewSyncLease(); inFlightQids.add(item.qid); try{
        await gasCall(item.action,item.payload); const current=getOutbox(), next=current.filter(x=>x.qid!==item.qid);
        if(next.length!==current.length&&!commitStorageChanges({[LS_OUTBOX]:JSON.stringify(next)}))throw new Error("outbox remove failed");
      }catch(e){failed=true;lastSyncError=e&&e.message||"동기화 오류";}finally{inFlightQids.delete(item.qid);} }
  }finally{flushing=false;}
  const pending=getOutbox().length, needs=resyncRequested||(pending>0&&!failed);resyncRequested=false;if(needs)scheduleSync();return !failed;
}
function recordsDifferent(a,b) { try{return JSON.stringify(a)!==JSON.stringify(b);}catch{return true;} }
function mergeServerData(data) {
  const byId={}; state.logs.forEach(l=>{byId[l.id]=l;});
  for(const raw of (data.logs||[])){const s=normalizeLog(raw);if(!s)continue;const l=byId[s.id];if(!l){byId[s.id]=s;continue;}const cmp=versionCompare(s,l);
    if(cmp>0){if(recordsDifferent(l,s))addRecovery("log",s.id,l,s);byId[s.id]=s;}else if(cmp<0&&recordsDifferent(l,s)){addRecovery("log",s.id,s,l);} }
  const nextLogs=Object.values(byId);
  const nextRefl={...state.reflections}; for(const [k,raw] of Object.entries(data.reflections||{})){const s=normalizeReflection(raw,k);if(!s)continue;const l=nextRefl[s.date];if(!l){nextRefl[s.date]=s;continue;}const cmp=versionCompare(s,l);
    if(cmp>0){if(recordsDifferent(l,s))addRecovery("reflection",s.date,l,s);nextRefl[s.date]=s;}else if(cmp<0&&recordsDifferent(l,s)){addRecovery("reflection",s.date,s,l);} }
  const rev=Number(data.revision)||0;
  if(!commitStorageChanges({[LS_LOGS]:JSON.stringify(nextLogs),[LS_REFL]:JSON.stringify(nextRefl),[LS_REV]:String(rev)}))throw new SyncError("서버 데이터를 기기에 저장하지 못했어","LOCAL_WRITE");
  state.logs=nextLogs;state.reflections=nextRefl;state.serverRevision=rev;renderCurrentView();notifySharedChange();
}
async function fetchAndMergeAll(forceFull=false) {
  const rev=forceFull?0:getServerRevision(); const params=forceFull?{}:(rev>0?{sinceRev:rev}:{}); const data=await gasCall("getAll",undefined,params); mergeServerData(data); return true;
}
async function syncNow(quiet=false,options={}) {
  if(syncRunning){resyncRequested=true;return false;}
  if(!isGasUrlSet()){setSyncDot("");if(!quiet)toast("설정에서 구글 시트 연동을 먼저 해줘");return false;}
  if(!navigator.onLine){setSyncDot("offline");if(!quiet)toast("오프라인이야. 기록은 기기에 저장되고 온라인이 되면 올라가.");return false;}
  if(flushing){resyncRequested=true;return false;}
  if(!acquireSyncLease()){setSyncDot(getOutbox().length?"pending":"ok");if(!quiet)toast("다른 창에서 동기화 중이야");return false;}
  setSyncDot("syncing"); syncRunning=true; let flushed=false,pulled=false;
  try{
    try{await verifyServerCompatibility();}catch(e){lastSyncError=e&&e.message||"Apps Script 호환성 확인 실패";setSyncDot("error");if(!quiet)toast(lastSyncError);return false;}
    flushed=await flushOutbox(); renewSyncLease();
    try{pulled=await fetchAndMergeAll(!!options.forceFull);}catch(e){lastSyncError=e&&e.message||"동기화 실패";pulled=false;}
    const ok=flushed&&pulled&&!getOutbox().length;
    if(ok){safeStorageSet(LS_LAST_SYNC,String(Date.now()),true);setSyncDot("ok");}
    else setSyncDot(navigator.onLine?"error":"offline");
    if(!quiet)toast(ok?"동기화 완료":lastSyncError||"일부 기록을 동기화하지 못했어");
    return ok;
  }finally{syncRunning=false;releaseSyncLease();if(resyncRequested){resyncRequested=false;scheduleSync();}}
}
async function connectGas(url,token) {
  const u=String(url||"").trim(),t=String(token||"").trim(); if(!u)return {ok:false,message:"웹 앱 URL을 입력해줘."};
  serverCapabilityVerified=false;
  try{
    const meta=await gasCall("meta",undefined,{}, {url:u,token:t,expectedStoreId:null});
    await gasCall("probe",undefined,{}, {url:u,token:t,expectedStoreId:meta.storeId});
    const oldStore=getStoreId(); let switchStore=false;
    if(oldStore&&oldStore!==meta.storeId){switchStore=confirm("기존에 연결했던 시트와 다른 시트야. 이 시트로 연결을 바꾸고 현재 기기 기록을 다시 올릴까?");if(!switchStore)return {ok:false,message:"기존 시트 연결을 유지했어."};}
    const changes={[LS_GAS_URL]:u,[LS_GAS_TOKEN]:t,[LS_STORE_ID]:meta.storeId,[LS_REV]:"0"};
    if(switchStore){let box=[];for(const l of state.logs){box=enqueueInBox(box,l.deleted?"DELETE_LOG":"UPDATE_LOG",l.deleted?{id:l.id,updatedAt:l.updatedAt,deviceId:l.deviceId||DEVICE_ID}:logPayload(l));}
      for(const r of Object.values(state.reflections))box=enqueueInBox(box,"UPSERT_REFLECTION",reflectionPayload(r));changes[LS_OUTBOX]=JSON.stringify(box);}
    if(!commitStorageChanges(changes))return {ok:false,message:"연결 정보를 기기에 저장하지 못했어."};
    state.serverStoreId=meta.storeId; serverCapabilityVerified=true; const synced=await syncNow(true,{forceFull:true}); return {ok:synced,message:synced?"연결됨":"연결은 확인했지만 데이터 동기화에 실패했어."};
  }catch(e){return {ok:false,message:e&&e.message||"연결 실패"};}
}
function logPayload(item) {
  const x=normalizeLog(item); if(!x)throw new Error("잘못된 기록이야");
  return {id:x.id,date:x.date,time:x.time,cat:x.cat,content:x.content,updatedAt:x.updatedAt,deleted:!!x.deleted,origin:x.origin,requester:x.requester,
    requestedAt:x.requestedAt,dueDate:x.dueDate,project:x.project,memo:x.memo,solved:!!x.solved,meeting:!!x.meeting,support:!!x.support,
    highlight:!!x.highlight,status:x.status,actualStartedAt:x.actualStartedAt,deviceId:x.deviceId||DEVICE_ID};
}
function reflectionPayload(r) { const x=normalizeReflection(r,r&&r.date); if(!x)throw new Error("잘못된 회고야"); return {...x,deviceId:x.deviceId||DEVICE_ID}; }

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
  $("quickMeeting").checked = false;
  $("quickSolved").checked = false;
  $("quickSupport").checked = false;
  $("quickProject").value = "";
  $("quickMemo").value = "";
  const d = document.querySelector(".extra-details"); if (d) d.open = false;
}
function addQuickLog() {
  const content=$("quickContent").value.trim(); if(!content){toast("업무명을 입력해줘");return;}
  const now=new Date(), requestedAt=state.activeOrigin==="request"?nowLocalDateTime(now):"", dueDate=state.activeOrigin==="request"?requestDueDate():"";
  const pending=state.activeOrigin==="request"&&state.requestWhen!=="now";
  const item=normalizeLog({id:uid(),date:pending?dueDate:state.currentDate,time:nowTimeStr(now),cat:"업무",content,origin:state.activeOrigin,
    requester:state.activeOrigin==="request"?$("requesterInput").value.trim():"",requestedAt,dueDate,project:$("quickProject").value.trim(),memo:$("quickMemo").value.trim(),
    meeting:$("quickMeeting").checked,solved:$("quickSolved").checked,support:$("quickSupport").checked,
    highlight:false,status:pending?"pending":"logged",actualStartedAt:pending?"":`${state.currentDate}T${nowTimeStr(now)}`,
    updatedAt:mutationTimestamp(),deleted:false,deviceId:DEVICE_ID});
  if(!item){toast("기록 값이 올바르지 않아");return;}
  const next=[...state.logs,item]; if(!persistLogAndQueue(next,"ADD_LOG",logPayload(item)))return;
  $("quickContent").value="";resetQuickMeta();renderToday();toast(pending?"요청을 할 일로 남겼어":"기록했어");
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
  const idx=state.logs.findIndex(x=>x.id===id); if(idx<0)return; const item={...state.logs[idx],deleted:true,updatedAt:mutationTimestamp(state.logs[idx].updatedAt),deviceId:DEVICE_ID};
  const next=state.logs.slice();next[idx]=item;
  if(!persistLogAndQueue(next,"DELETE_LOG",{id,updatedAt:item.updatedAt,deviceId:DEVICE_ID}))return false;
  renderCurrentView();return true;
}
function updateLog(id,fields) {
  const idx=state.logs.findIndex(x=>x.id===id); if(idx<0)return false; const item={...state.logs[idx],...fields};
  item.date=normalizeDateStr(item.date);item.time=normalizeTimeStr(item.time);if(!item.date||!item.time){toast("날짜나 시간이 올바르지 않아");return false;}
  item.requestedAt=normalizeDateTimeLocal(item.requestedAt);item.dueDate=normalizeDateStr(item.dueDate);
  if(item.origin!=="request"&&item.status==="pending"){item.status="logged";item.requester="";item.requestedAt="";item.dueDate="";item.actualStartedAt=`${item.date}T${item.time}`;}
  if(item.origin==="request"&&item.status==="pending"&&!item.dueDate){toast("대기 중인 요청에는 예정일이 필요해");return false;}
  if(item.status!=="pending"&&(fields.date!==undefined||fields.time!==undefined))item.actualStartedAt=`${item.date}T${item.time}`;else item.actualStartedAt=normalizeDateTimeLocal(item.actualStartedAt);
  item.updatedAt=mutationTimestamp(state.logs[idx].updatedAt);item.deviceId=DEVICE_ID;const normalized=normalizeLog(item);if(!normalized){toast("기록 값이 올바르지 않아");return false;}
  const next=state.logs.slice();next[idx]=normalized;return persistLogAndQueue(next,"UPDATE_LOG",logPayload(normalized));
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
  return state.reflections[date]||{date,summary:"",difficulty:"",achievement:"",tomorrow:"",updatedAt:0,deviceId:""};
}
function saveReflectionField(date,field,value) {
  const d=normalizeDateStr(date);if(!d)return;const next={...state.reflections};const prev=getReflection(d);const r={...prev,[field]:value,updatedAt:mutationTimestamp(prev.updatedAt),deviceId:DEVICE_ID};next[d]=r;
  if(!persistReflectionAndQueue(next,reflectionPayload(r)))return;
  const h=$("saveHint");if(h){h.textContent="기기에 저장됨";clearTimeout(reflTimers[d]);reflTimers[d]=setTimeout(()=>{if(h)h.textContent=" ";},1300);}updateReflectionHint();
}
function updateReflectionHint() {
  const r = getReflection(state.currentDate);
  const vals = [r.summary,r.difficulty,r.achievement,r.tomorrow].filter(Boolean);
  $("reflectionHint").textContent = vals.length ? (r.summary || "작성됨").slice(0,18) : "비어있음";
}

function requesterOptions() {
  const names=[...new Set(state.logs.filter(x=>!x.deleted).map(x=>x.requester).filter(Boolean))].sort();
  $("requesterList").innerHTML=names.map(x=>`<option value="${escapeAttr(x)}"></option>`).join("");
}
function logMetaHtml(item) {
  const tags = [];
  if (item.meeting) tags.push(`<span class="mini-tag meeting">회의</span>`);
  if (item.solved) tags.push(`<span class="mini-tag solved">문제해결</span>`);
  if (item.support) tags.push(`<span class="mini-tag support">협업·지원</span>`);
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
  const legacyRepresentedByFlag = (item.cat === "해결" && item.solved) || (item.cat === "회의" && item.meeting);
  const legacyLabel = item.cat && item.cat !== "업무" && !legacyRepresentedByFlag
    ? `<strong>${escapeHtml(CAT_LABEL[item.cat] || item.cat)}</strong> `
    : "";
  return `<div class="log-item" data-cat="${escapeAttr(item.cat)}" data-solved="${item.solved ? "true" : "false"}" data-meeting="${item.meeting ? "true" : "false"}" data-support="${item.support ? "true" : "false"}" data-id="${escapeAttr(item.id)}">
    <div class="log-time">${escapeHtml(item.time)}</div><div class="log-bar"></div>
    <div class="log-main"><div class="log-title">${legacyLabel}${escapeHtml(item.content)}</div>
      ${logMetaHtml(item) ? `<div class="log-tags">${logMetaHtml(item)}</div>` : ""}
      ${item.memo ? `<div class="log-note">${escapeHtml(item.memo)}</div>` : ""}
    </div>
    <div class="log-actions"><button class="star-btn${item.highlight ? " on" : ""}" data-star="${escapeAttr(item.id)}" aria-label="${item.highlight ? "대표 업무 해제" : "대표 업무로 표시"}" aria-pressed="${item.highlight ? "true" : "false"}">${item.highlight ? "★" : "☆"}</button><button class="more-btn" data-edit="${escapeAttr(item.id)}" aria-label="수정">⋯</button></div>
  </div>`;
}

function renderToday() {
  const current = normalizeDateStr(state.currentDate);
  const [cy, cm, cd] = current.split("-").map(Number);
  const cdt = new Date(cy, cm - 1, cd);
  $("todayDateMain").textContent = `${cm}월 ${cd}일`;
  $("todayDateSub").textContent = `${cy}년 · ${WEEKDAY_KR[cdt.getDay()]}요일`;
  $("reflectionTitle").textContent = state.currentDate === todayStr() ? "오늘 회고" : "이 날 회고";
  const rh=$("recordingDateHint"); if(rh){const past=state.currentDate!==todayStr();rh.hidden=!past;rh.textContent=past?`${formatShortDate(state.currentDate)}에 기록 중`:"";}
  requesterOptions();

  const pending = pendingLogs();
  $("pendingSection").hidden = pending.length === 0;
  $("pendingCount").textContent = pending.length ? String(pending.length) : "";
  $("pendingList").innerHTML = pending.map(x => {
    const due = x.dueDate || x.date;
    const overdue = due && due < todayStr();
    const when = due === todayStr() ? "오늘" : due === addDays(todayStr(),1) ? "내일" : formatShortDate(due);
    return `<article class="pending-card" data-id="${escapeAttr(x.id)}">
      <div class="pending-main"><div class="pending-title">${escapeHtml(x.content)}</div>
      <div class="pending-meta">${x.requester ? escapeHtml(x.requester) + " · " : ""}${x.requestedAt ? formatDateTime(x.requestedAt) + " 요청 · " : ""}<span class="pending-due${overdue ? " overdue" : ""}">${overdue ? "기한 지남 · " : ""}${escapeHtml(when)}</span>${x.meeting ? " · 회의" : ""}${x.solved ? " · 문제해결" : ""}${x.support ? " · 협업·지원" : ""}${x.project ? " · " + escapeHtml(x.project) : ""}</div></div>
      <button class="start-btn" data-start="${escapeAttr(x.id)}">시작</button>
      <div class="pending-actions"><button class="text-btn" data-tomorrow="${escapeAttr(x.id)}">+1일</button><button class="text-btn" data-edit="${escapeAttr(x.id)}">수정</button></div>
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
  const meetings = rows.filter(x => x.meeting);
  const solved = rows.filter(x => x.solved);
  const supports = rows.filter(x => x.support);
  const projects = {};
  rows.forEach(x => { if (x.project) projects[x.project] = (projects[x.project] || 0) + 1; });
  const projectEntries = Object.entries(projects).sort((a,b) => b[1]-a[1]);
  const refl = Object.values(state.reflections).filter(r => r.date.startsWith(key)).sort((a,b) => b.date.localeCompare(a.date));

  const list = arr => arr.length ? `<div class="summary-list">${arr.map(x => {
    const meta = [formatShortDate(x.date)];
    const legacyRepresentedByFlag = (x.cat === "해결" && x.solved) || (x.cat === "회의" && x.meeting);
    if (x.cat && x.cat !== "업무" && !legacyRepresentedByFlag) meta.push(CAT_LABEL[x.cat] || x.cat);
    if (x.meeting) meta.push("회의");
    if (x.solved) meta.push("문제해결");
    if (x.support) meta.push("협업·지원");
    if (x.requester) meta.push(x.requester);
    if (x.project) meta.push(x.project);
    return `<div class="summary-item"><div class="title">${escapeHtml(x.content)}</div><div class="meta">${meta.map(escapeHtml).join(" · ")}</div></div>`;
  }).join("")}</div>` : `<div class="summary-empty">기록 없음</div>`;
  const reflEntries = refl.filter(r => r.achievement || r.difficulty);

  $("monthSummary").innerHTML = `
    <section class="summary-card"><h2>대표 업무</h2>${list(highlights)}</section>
    <section class="summary-card"><h2>업무 흐름</h2><div class="metric-grid">
      <div class="metric"><strong>${rows.length}</strong><span>전체 기록</span></div>
      <div class="metric"><strong>${requestsReceived.length}</strong><span>요청받음</span></div>
      <div class="metric"><strong>${requestsProcessed.length}</strong><span>요청 처리</span></div>
      <div class="metric"><strong>${self.length}</strong><span>내가 먼저 함</span></div>
      <div class="metric"><strong>${meetings.length}</strong><span>회의</span></div>
      <div class="metric"><strong>${solved.length}</strong><span>문제해결</span></div>
      <div class="metric"><strong>${supports.length}</strong><span>협업·지원</span></div>
      <div class="metric"><strong>${pendingCreated.length}</strong><span>요청 중 대기</span></div>
    </div></section>
    <section class="summary-card"><h2>내가 먼저 챙긴 일</h2>${list(self)}</section>
    <section class="summary-card"><h2>해결한 문제</h2>${list(solved)}</section>
    <section class="summary-card"><h2>협업·지원</h2>${list(supports)}</section>
    <section class="summary-card"><h2>회의 기록</h2>${list(meetings)}</section>
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
    return [...items.map(x => [x.content,x.requester,x.project,x.memo,CAT_LABEL[x.cat]||x.cat,
      x.meeting ? "회의 미팅" : "",x.solved ? "문제해결 해결한 문제" : "",x.support ? "협업·지원 협업 지원 도움" : ""].join(" ")),
      r.summary,r.difficulty,r.achievement,r.tomorrow].join(" ").toLowerCase().includes(q);
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
  $("gasUrlInput").value=isGasUrlSet()?getGasUrl():"";
  $("gasTokenInput").value=getGasToken();
  const recovery=readJsonRaw(LS_RECOVERY,[]);const last=Number(localStorage.getItem(LS_LAST_SYNC)||0);const skew=Math.abs(state.clockSkewMs);
  $("dataStatusText").textContent=`기록 ${state.logs.filter(x=>!x.deleted).length}건 · 회고 ${Object.keys(state.reflections).length}일 · 전송 대기 ${getOutbox().length}건 · 복구본 ${Array.isArray(recovery)?recovery.length:0}건`;
  const sd=$("syncDetailText");if(sd){const parts=[];parts.push(`앱 v${APP_VERSION}`);if(last)parts.push(`마지막 성공 ${new Date(last).toLocaleString("ko-KR")}`);if(getServerRevision())parts.push(`서버 revision ${getServerRevision()}`);if(skew>5*60*1000)parts.push(`기기 시계 차이 약 ${Math.round(skew/60000)}분`);sd.textContent=parts.join(" · ");}
}
function renderCurrentView() {
  if (state.currentView === "today") renderToday();
  else if (state.currentView === "summary") renderSummary();
  else if (state.currentView === "history") renderHistory();
  else if (state.currentView === "settings") renderSettings();
}
function switchView(view,push=true) {
  if(!["today","summary","history","settings"].includes(view))view="today";
  state.currentView=view;
  document.querySelectorAll(".view").forEach(v=>{v.hidden=v.id!==`view-${view}`;});
  document.querySelectorAll(".tab-btn").forEach(b=>{const active=b.dataset.view===view;b.classList.toggle("active",active);if(active)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current");});
  if(push){const u=new URL(location.href);u.searchParams.set("view",view);history.pushState({view},"",u);}
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
  $("editMeeting").checked = !!item.meeting;
  $("editSolved").checked = !!item.solved;
  $("editSupport").checked = !!item.support;
  $("editHighlight").checked = !!item.highlight;
  $("editRequestFields").hidden = item.origin !== "request";
  $("editReturnPendingBtn").hidden = !(item.origin === "request" && item.status !== "pending");
  history.pushState({view:state.currentView,modal:id},"",location.href);
  $("editModal").hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => $("editContent").focus());
}
function closeEdit(fromHistory=false) {
  const hadModal=!$("editModal").hidden;
  state.editId=null;$("editModal").hidden=true;document.body.classList.remove("modal-open");
  const target=modalReturnFocus;modalReturnFocus=null;if(target&&document.contains(target))requestAnimationFrame(()=>target.focus());
  if(hadModal&&!fromHistory&&history.state&&history.state.modal)history.back();
}
function saveEdit() {
  const id=state.editId;if(!id)return;const item=state.logs.find(x=>x.id===id);if(!item)return;const content=$("editContent").value.trim();if(!content){toast("업무명을 입력해줘");return;}
  const origin=$("editOrigin").value,date=normalizeDateStr($("editDate").value),time=normalizeTimeStr($("editTime").value);if(!date||!time){toast("날짜나 시간이 올바르지 않아");return;}
  let status=item.status; if(origin!=="request"&&status==="pending")status="logged";
  const fields={date,time,content,origin,status,requester:origin==="request"?$("editRequester").value.trim():"",requestedAt:origin==="request"?$("editRequestedAt").value:"",
    dueDate:origin==="request"?$("editDueDate").value:"",project:$("editProject").value.trim(),memo:$("editMemo").value.trim(),
    meeting:$("editMeeting").checked,solved:$("editSolved").checked,support:$("editSupport").checked,
    highlight:$("editHighlight").checked,actualStartedAt:status==="pending"?"":`${date}T${time}`};
  if(!updateLog(id,fields))return;closeEdit();renderCurrentView();toast("수정했어");
}

function downloadText(name,text,mime,bom=false){const blob=new Blob([bom?"\ufeff":"",text],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function downloadBackup() {
  const data={appId:APP_ID,schemaVersion:API_SCHEMA_VERSION,appVersion:APP_VERSION,exportedAt:new Date().toISOString(),logs:state.logs,reflections:state.reflections};
  downloadText(`업무일지_백업_${todayStr()}.json`,JSON.stringify(data,null,2),"application/json;charset=utf-8");
}
function downloadCsv(){
  const head=["날짜","시간","업무명","발생경로","요청자","예정일","프로젝트","메모","회의","문제해결","협업·지원","대표업무","기존종류","상태","삭제"];
  const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
  const rows=state.logs.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)).map(x=>[x.date,x.time,x.content,x.origin,x.requester,x.dueDate,x.project,x.memo,x.meeting?"Y":"",x.solved?"Y":"",x.support?"Y":"",x.highlight?"Y":"",x.cat,x.status,x.deleted?"Y":""].map(q).join(","));
  downloadText(`업무일지_${todayStr()}.csv`,[head.map(q).join(","),...rows].join("\r\n"),"text/csv;charset=utf-8",true);
}
function previewAndRestoreBackup(data){
  if(!data||typeof data!=="object"||!Array.isArray(data.logs)||!data.reflections||typeof data.reflections!=="object")throw new Error("업무일지 백업 형식이 아니야");
  const byId={};state.logs.forEach(x=>{byId[x.id]=x;});let add=0,update=0,errors=0;const changed=[];
  for(const raw of data.logs){const x=normalizeLog(raw);if(!x){errors++;continue;}const cur=byId[x.id];if(!cur){byId[x.id]=x;add++;changed.push({kind:"log",old:null,value:x});}else if(versionCompare(x,cur)>0){byId[x.id]=x;update++;changed.push({kind:"log",old:cur,value:x});}}
  const refl={...state.reflections};for(const [k,raw] of Object.entries(data.reflections)){const x=normalizeReflection(raw,k);if(!x){errors++;continue;}const cur=refl[x.date];if(!cur||versionCompare(x,cur)>0){refl[x.date]=x;changed.push({kind:"reflection",old:cur||null,value:x});}}
  if(!changed.length){toast(errors?`적용할 최신 데이터가 없어. 오류 ${errors}건`:"적용할 최신 데이터가 없어");return;}
  if(!confirm(`백업을 병합할까?\n새 기록 ${add}건 · 갱신 ${update}건 · 기타 변경 ${changed.length-add-update}건 · 오류 ${errors}건`))return;
  let box=getOutbox();for(const c of changed){if(c.kind==="log"){const x=c.value;box=enqueueInBox(box,x.deleted?"DELETE_LOG":(c.old?"UPDATE_LOG":"ADD_LOG"),x.deleted?{id:x.id,updatedAt:x.updatedAt,deviceId:x.deviceId||DEVICE_ID}:logPayload(x));}else box=enqueueInBox(box,"UPSERT_REFLECTION",reflectionPayload(c.value));}
  const nextLogs=Object.values(byId);if(!commitStorageChanges({[LS_LOGS]:JSON.stringify(nextLogs),[LS_REFL]:JSON.stringify(refl),[LS_OUTBOX]:JSON.stringify(box)}))return;
  state.logs=nextLogs;state.reflections=refl;renderCurrentView();scheduleSync();notifySharedChange();toast("백업을 병합했어");
}
async function importBackupFile(file){const text=await file.text();let data;try{data=JSON.parse(text.replace(/^\ufeff/,""));}catch{throw new Error("JSON 파일을 읽지 못했어");}previewAndRestoreBackup(data);}
function bindEvents() {
  document.querySelectorAll(".origin-chip").forEach(b=>b.addEventListener("click",()=>{
    state.activeOrigin=b.dataset.origin;document.querySelectorAll(".origin-chip").forEach(x=>{const on=x===b;x.classList.toggle("active",on);x.setAttribute("aria-pressed",String(on));});
    $("requestFields").hidden=state.activeOrigin!=="request";
  }));
  document.querySelectorAll(".when-chip").forEach(b=>b.addEventListener("click",()=>{
    state.requestWhen=b.dataset.when;document.querySelectorAll(".when-chip").forEach(x=>{const on=x===b;x.classList.toggle("active",on);x.setAttribute("aria-pressed",String(on));});
    $("requestDueDate").hidden=state.requestWhen!=="date";if(state.requestWhen==="date"&&!$("requestDueDate").value)$("requestDueDate").value=addDays(todayStr(),1);
  }));
  $("quickAddBtn").addEventListener("click",addQuickLog);
  $("quickContent").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.isComposing){e.preventDefault();addQuickLog();}});

  $("prevDay").addEventListener("click",()=>{state.currentDate=addDays(state.currentDate,-1);state.followToday=false;renderToday();});
  $("nextDay").addEventListener("click",()=>{state.currentDate=addDays(state.currentDate,1);state.followToday=false;renderToday();});
  $("todayBtn").addEventListener("click",()=>{state.currentDate=todayStr();state.followToday=true;renderToday();});
  const recHint=$("recordingDateHint");if(recHint)recHint.addEventListener("click",()=>{state.currentDate=todayStr();state.followToday=true;renderToday();});

  ["fSummary","fDifficulty","fAchievement","fTomorrow"].forEach(id=>{const map={fSummary:"summary",fDifficulty:"difficulty",fAchievement:"achievement",fTomorrow:"tomorrow"};$(id).addEventListener("input",e=>saveReflectionField(state.currentDate,map[id],e.target.value));});

  document.addEventListener("click",e=>{
    const start=e.target.closest("[data-start]");if(start){startPending(start.dataset.start);return;}
    const tomorrow=e.target.closest("[data-tomorrow]");if(tomorrow){postponePending(tomorrow.dataset.tomorrow,1);return;}
    const star=e.target.closest("[data-star]");if(star){toggleHighlight(star.dataset.star);return;}
    const edit=e.target.closest("[data-edit]");if(edit){openEdit(edit.dataset.edit);return;}
    if(e.target.closest("[data-close-modal]"))closeEdit();
  });

  $("editOrigin").addEventListener("change",e=>{$("editRequestFields").hidden=e.target.value!=="request";});
  $("editSaveBtn").addEventListener("click",saveEdit);
  $("editReturnPendingBtn").addEventListener("click",()=>{const id=state.editId;if(!id||!returnToPending(id))return;closeEdit();renderCurrentView();toast("해야 할 요청으로 되돌렸어");});
  $("editDeleteBtn").addEventListener("click",()=>{if(!state.editId||!confirm("이 기록을 삭제할까?"))return;const id=state.editId;closeEdit();if(deleteLogItem(id))toast("삭제했어");});

  document.querySelectorAll(".tab-btn").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.view)));
  $("prevMonth").addEventListener("click",()=>{state.summaryMonth--;if(state.summaryMonth<0){state.summaryMonth=11;state.summaryYear--;}renderSummary();});
  $("nextMonth").addEventListener("click",()=>{state.summaryMonth++;if(state.summaryMonth>11){state.summaryMonth=0;state.summaryYear++;}renderSummary();});
  $("searchInput").addEventListener("input",e=>renderHistory(e.target.value));

  $("syncBtn").addEventListener("click",()=>syncNow(false));
  $("syncNowBtn").addEventListener("click",()=>syncNow(false));
  $("fullResyncBtn").addEventListener("click",async()=>{if(!confirm("서버와 전체 데이터를 다시 맞출까? 로컬에만 있는 기록은 지우지 않아."))return;commitStorageChanges({[LS_REV]:"0"});await syncNow(false,{forceFull:true});renderSettings();});
  $("gasUrlSave").addEventListener("click",async()=>{
    $("gasStatusText").textContent="연결 확인 중";const result=await connectGas($("gasUrlInput").value,$("gasTokenInput").value);$("gasStatusText").textContent=result.message;renderSettings();
  });
  $("tokenToggle").addEventListener("click",()=>{const input=$("gasTokenInput"),show=input.type==="password";input.type=show?"text":"password";$("tokenToggle").textContent=show?"숨기기":"보기";});

  $("exportBackupBtn").addEventListener("click",downloadBackup);
  $("exportCsvBtn").addEventListener("click",downloadCsv);
  $("importBackupBtn").addEventListener("click",()=>$("importBackupFile").click());
  $("importBackupFile").addEventListener("change",async e=>{const f=e.target.files&&e.target.files[0];if(!f)return;try{await importBackupFile(f);}catch(err){toast(err&&err.message||"백업을 불러오지 못했어");}finally{e.target.value="";}});

  document.addEventListener("keydown",e=>{
    if($("editModal").hidden)return;if(e.key==="Escape"){e.preventDefault();closeEdit();return;}if(e.key!=="Tab")return;
    const focusables=modalFocusable();if(!focusables.length)return;const first=focusables[0],last=focusables[focusables.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  });

  window.addEventListener("online",()=>syncNow(true));
  window.addEventListener("offline",()=>setSyncDot(isGasUrlSet()?"offline":""));
  window.addEventListener("storage",e=>{
    if([LS_LOGS,LS_REFL,LS_OUTBOX].includes(e.key))reloadSharedState();
    if([LS_GAS_URL,LS_GAS_TOKEN,LS_STORE_ID].includes(e.key)){serverCapabilityVerified=false;refreshSyncState();}
  });
  window.addEventListener("popstate",e=>{if(!$("editModal").hidden)closeEdit(true);const v=e.state&&e.state.view;if(v)switchView(v,false);});
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){if(state.currentView==="today"&&state.followToday)state.currentDate=todayStr();reloadSharedState();syncNow(true);}});
}

function initSharedChannel(){
  if("BroadcastChannel" in window){try{sharedChannel=new BroadcastChannel("dayeon-worklog");sharedChannel.addEventListener("message",e=>{if(e.data&&e.data.type==="data-changed"&&e.data.from!==TAB_ID)reloadSharedState();});}catch{}}
}
function initialViewFromUrl(){const v=new URLSearchParams(location.search).get("view");return ["today","summary","history","settings"].includes(v)?v:"today";}
function init() {
  recoverStorageJournal();DEVICE_ID=getDeviceId();loadLocal();initSharedChannel();
  document.querySelectorAll(".origin-chip,.when-chip").forEach(b=>b.setAttribute("aria-pressed",String(b.classList.contains("active"))));
  bindEvents();renderToday();const iv=initialViewFromUrl();history.replaceState({view:iv},"",location.href);if(iv!=="today")switchView(iv,false);refreshSyncState();if(isGasUrlSet())syncNow(true);
  if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
}

init();
