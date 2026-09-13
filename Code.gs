/** 업무일지 PWA v7 backend. 모든 쓰기는 GET + query string. */
var TOKEN='여기를_바꿔줘_아무도_모를_문자열';
var APP_ID='worklog', SCHEMA_VERSION=7;
var LOG_SHEET='로그', REFL_SHEET='회고';
var LOG_HEAD=['id','날짜','시간','분류','내용','수정시각','삭제','기기ID','서버리비전'];
var REFL_HEAD=['날짜','오늘 한 줄','어려웠던 점 & 이유','잘한 점','내일은?','수정시각','기기ID','서버리비전','필드버전JSON'];
var PROP_STORE='WORKLOG_STORE_ID', PROP_REV='WORKLOG_REV';

function doGet(e){
  var p=(e&&e.parameter)||{}, action=p.action||'ping';
  if(action==='ping')return json_({ok:true,appId:APP_ID,schemaVersion:SCHEMA_VERSION,serverTime:Date.now()});
  if(p.token!==TOKEN)return json_({ok:false,code:'AUTH',error:'토큰이 달라. 앱 설정과 Code.gs를 맞춰줘.'});
  try{
    if(action==='meta')return json_(meta_());
    if(action==='getAll')return json_(getAll_(p.sinceRev));
    var payload=parse_(p.payload);
    var lock=LockService.getScriptLock();lock.waitLock(25000);
    try{
      var result;
      if(action==='ADD_LOG'||action==='UPDATE_LOG')result=upsertLog_(payload);
      else if(action==='DELETE_LOG')result=deleteLog_(payload);
      else if(action==='UPSERT_REFLECTION')result=upsertReflectionCompat_(payload);
      else if(action==='UPSERT_REFLECTION_FIELD')result=upsertReflectionField_(payload);
      else if(action==='batch')result=batch_(payload.items||[]);
      else return json_({ok:false,code:'ACTION',error:'알 수 없는 action: '+action});
      var m=meta_();result.ok=true;result.appId=APP_ID;result.schemaVersion=SCHEMA_VERSION;result.storeId=m.storeId;result.serverTime=m.serverTime;result.cursor=m.cursor;return json_(result);
    }finally{try{lock.releaseLock()}catch(_){}}
  }catch(err){return json_({ok:false,code:'SERVER',error:String(err&&err.message?err.message:err)})}
}
function doPost(){return json_({ok:false,code:'POST_DISABLED',error:'POST는 지원하지 않아. 최신 앱은 GET 방식만 사용해.'})}
function parse_(s){try{return JSON.parse(s||'{}')}catch(_){throw new Error('요청 형식이 이상해')}}
function getStoreId_(){var p=PropertiesService.getScriptProperties(),id=p.getProperty(PROP_STORE);if(!id){id=Utilities.getUuid();p.setProperty(PROP_STORE,id)}return id}
function getRev_(){return Number(PropertiesService.getScriptProperties().getProperty(PROP_REV))||0}
function nextRev_(){var p=PropertiesService.getScriptProperties(),n=getRev_()+1;p.setProperty(PROP_REV,String(n));return n}
function meta_(){return{ok:true,appId:APP_ID,schemaVersion:SCHEMA_VERSION,storeId:getStoreId_(),serverTime:Date.now(),cursor:getRev_()}}
function clean_(v,max){var s=String(v==null?'':v).trim();if(s.length>max)throw new Error('입력 길이가 제한을 넘었어');return s}
function validDate_(s){var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s||''));if(!m)return false;var y=+m[1],mo=+m[2],d=+m[3],x=new Date(y,mo-1,d);return x.getFullYear()===y&&x.getMonth()===mo-1&&x.getDate()===d}
function validTime_(s){return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s||''))}
function validStamp_(n){n=Number(n);return isFinite(n)&&n>946684800000&&n<Date.now()+7*86400000}
function cmp_(au,ad,bu,bd){au=Number(au)||0;bu=Number(bu)||0;if(au!==bu)return au>bu?1:-1;ad=String(ad||'');bd=String(bd||'');return ad===bd?0:(ad>bd?1:-1)}
function validateLog_(r){if(!r||!r.id)throw new Error('로그 id가 없어');if(!validDate_(r.date))throw new Error('날짜 형식이 잘못됐어');if(!validTime_(r.time))throw new Error('시간 형식이 잘못됐어');var cat=clean_(r.cat,10);if(['업무','회의','요청','해결','기타'].indexOf(cat)<0)throw new Error('분류가 잘못됐어');if(!validStamp_(r.updatedAt))throw new Error('수정시각이 잘못됐어');var content=clean_(r.content,500);if(!content&&!r.deleted)throw new Error('내용이 비어 있어');return{id:clean_(r.id,120),date:String(r.date),time:String(r.time),cat:cat,content:content,updatedAt:Number(r.updatedAt),deleted:!!r.deleted,deviceId:clean_(r.deviceId||'',120)}}
function logSheet_(){var ss=SpreadsheetApp.getActiveSpreadsheet(),sh=findOrCreateSheet_([LOG_SHEET,'Logs','logs','업무로그'],LOG_SHEET,LOG_HEAD);ensureHead_(sh,LOG_HEAD);return sh}
function reflSheet_(){var ss=SpreadsheetApp.getActiveSpreadsheet(),sh=findOrCreateSheet_([REFL_SHEET,'Reflections','reflections','정리'],REFL_SHEET,REFL_HEAD);ensureHead_(sh,REFL_HEAD);return sh}
function findOrCreateSheet_(names,newName,head){var ss=SpreadsheetApp.getActiveSpreadsheet();for(var i=0;i<names.length;i++){var s=ss.getSheetByName(names[i]);if(s)return s}var sh=ss.insertSheet(newName);sh.getRange(1,1,1,head.length).setValues([head]);return sh}
function ensureHead_(sh,head){if(sh.getLastRow()===0)sh.getRange(1,1,1,head.length).setValues([head]);else if(sh.getLastColumn()<head.length){var c=sh.getLastColumn();sh.getRange(1,c+1,1,head.length-c).setValues([head.slice(c)])}}
function logIndex_(sh){var idx={},last=sh.getLastRow();if(last<2)return idx;var v=sh.getRange(2,1,last-1,LOG_HEAD.length).getValues();for(var i=0;i<v.length;i++)if(v[i][0])idx[String(v[i][0])]={row:i+2,updated:ms_(v[i][5]),deviceId:String(v[i][7]||''),values:v[i]};return idx}
function upsertLog_(raw){var r=validateLog_(raw),sh=logSheet_(),idx=logIndex_(sh),old=idx[r.id];if(old&&cmp_(old.updated,old.deviceId,r.updatedAt,r.deviceId)>=0)return{saved:0,skipped:1,conflicts:[{id:r.id,serverUpdated:old.updated,serverDeviceId:old.deviceId}]};var rev=nextRev_(),line=[r.id,r.date,r.time,r.cat,r.content,new Date(r.updatedAt),r.deleted?'Y':'',r.deviceId,rev];if(old)sh.getRange(old.row,1,1,LOG_HEAD.length).setValues([line]);else sh.appendRow(line);return{saved:1,skipped:0,conflicts:[]}}
function deleteLog_(p){if(!p||!p.id||!validStamp_(p.updatedAt))throw new Error('삭제 요청이 잘못됐어');var sh=logSheet_(),idx=logIndex_(sh),old=idx[String(p.id)],device=clean_(p.deviceId||'',120);if(old&&cmp_(old.updated,old.deviceId,p.updatedAt,device)>=0)return{saved:0,skipped:1,conflicts:[{id:String(p.id),serverUpdated:old.updated,serverDeviceId:old.deviceId}]};var rev=nextRev_();if(old){var v=old.values.slice();v[5]=new Date(Number(p.updatedAt));v[6]='Y';v[7]=device;v[8]=rev;sh.getRange(old.row,1,1,LOG_HEAD.length).setValues([v])}else{sh.appendRow([String(p.id),'','00:00','기타','',new Date(Number(p.updatedAt)),'Y',device,rev])}return{saved:1,skipped:0,conflicts:[]}}
function reflIndex_(sh){var idx={},last=sh.getLastRow();if(last<2)return idx;var v=sh.getRange(2,1,last-1,REFL_HEAD.length).getValues();for(var i=0;i<v.length;i++)if(v[i][0])idx[String(v[i][0])]={row:i+2,values:v[i]};return idx}
function parseVersions_(s,globalU,globalD){var o={};try{o=JSON.parse(String(s||'{}'))||{}}catch(_){};['summary','difficulty','achievement','tomorrow'].forEach(function(f){if(!o[f])o[f]={u:Number(globalU)||0,d:String(globalD||'')}});return o}
function reflCol_(f){return{summary:1,difficulty:2,achievement:3,tomorrow:4}[f]}
function upsertReflectionField_(p){if(!p||!validDate_(p.date))throw new Error('회고 날짜가 잘못됐어');var f=String(p.field||'');if(reflCol_(f)==null)throw new Error('회고 필드가 잘못됐어');if(!validStamp_(p.updatedAt))throw new Error('회고 수정시각이 잘못됐어');var val=clean_(p.value,700),dev=clean_(p.deviceId||'',120),sh=reflSheet_(),idx=reflIndex_(sh),old=idx[p.date];var row=old?old.values.slice():[p.date,'','','','',new Date(0),'',0,'{}'];var vers=parseVersions_(row[8],ms_(row[5]),row[6]),prev=vers[f]||{u:0,d:''};if(cmp_(prev.u,prev.d,p.updatedAt,dev)>=0)return{saved:0,skipped:1};row[reflCol_(f)]=val;vers[f]={u:Number(p.updatedAt),d:dev};var maxU=0,maxD='';Object.keys(vers).forEach(function(k){if(cmp_(vers[k].u,vers[k].d,maxU,maxD)>0){maxU=vers[k].u;maxD=vers[k].d}});row[0]=p.date;row[5]=new Date(maxU);row[6]=maxD;row[7]=nextRev_();row[8]=JSON.stringify(vers);if(old)sh.getRange(old.row,1,1,REFL_HEAD.length).setValues([row]);else sh.appendRow(row);return{saved:1,skipped:0}}
function upsertReflectionCompat_(p){var saved=0,skipped=0;['summary','difficulty','achievement','tomorrow'].forEach(function(f){var r=upsertReflectionField_({date:p.date,field:f,value:p[f]||'',updatedAt:Number(p.updatedAt),deviceId:p.deviceId||''});saved+=r.saved||0;skipped+=r.skipped||0});return{saved:saved,skipped:skipped}}
function batch_(items){if(!Array.isArray(items)||items.length>30)throw new Error('batch 형식이 잘못됐어');var saved=0,skipped=0,conflicts=[];for(var i=0;i<items.length;i++){var x=items[i]||{},r;if(x.action==='ADD_LOG'||x.action==='UPDATE_LOG')r=upsertLog_(x.payload);else if(x.action==='DELETE_LOG')r=deleteLog_(x.payload);else if(x.action==='UPSERT_REFLECTION_FIELD')r=upsertReflectionField_(x.payload);else throw new Error('batch action이 잘못됐어');saved+=r.saved||0;skipped+=r.skipped||0;if(r.conflicts)conflicts=conflicts.concat(r.conflicts)}return{saved:saved,skipped:skipped,conflicts:conflicts}}
function getAll_(sinceParam){var since=Number(sinceParam),inc=isFinite(since)&&since>0,logs=[],refs={},ls=logSheet_(),rs=reflSheet_(),lv=ls.getLastRow()>1?ls.getRange(2,1,ls.getLastRow()-1,LOG_HEAD.length).getValues():[],rv=rs.getLastRow()>1?rs.getRange(2,1,rs.getLastRow()-1,REFL_HEAD.length).getValues():[];for(var i=0;i<lv.length;i++){var x=lv[i],rev=Number(x[8])||0;if(!x[0]||(inc&&(!rev||rev<=since)))continue;logs.push({id:String(x[0]),date:dateStr_(x[1]),time:timeStr_(x[2]),cat:String(x[3]||''),content:String(x[4]||''),updatedAt:ms_(x[5]),deleted:x[6]==='Y'||x[6]===true,deviceId:String(x[7]||''),revision:rev})}for(var j=0;j<rv.length;j++){var y=rv[j],rr=Number(y[7])||0;if(!y[0]||(inc&&(!rr||rr<=since)))continue;var date=dateStr_(y[0]),vers=parseVersions_(y[8],ms_(y[5]),y[6]);refs[date]={date:date,summary:String(y[1]||''),difficulty:String(y[2]||''),achievement:String(y[3]||''),tomorrow:String(y[4]||''),updatedAt:ms_(y[5]),deviceId:String(y[6]||''),revision:rr,_versions:vers}}
  var m=meta_();return{ok:true,appId:APP_ID,schemaVersion:SCHEMA_VERSION,storeId:m.storeId,serverTime:m.serverTime,cursor:m.cursor,incremental:inc,logs:logs,reflections:refs}}
function dateStr_(v){if(v instanceof Date)return Utilities.formatDate(v,SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(),'yyyy-MM-dd');return String(v||'').slice(0,10)}
function timeStr_(v){if(v instanceof Date)return Utilities.formatDate(v,SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(),'HH:mm');var s=String(v||'');var m=s.match(/(?:T|\s)?(\d{2}):(\d{2})/);return m?m[1]+':'+m[2]:'00:00'}
function ms_(v){return v instanceof Date?v.getTime():(Number(v)||0)}
function json_(o){return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON)}
function assignMissingRevisions_(sh,col){var last=sh.getLastRow();if(last<2)return;var v=sh.getRange(2,col,last-1,1).getValues(),changed=false;for(var i=0;i<v.length;i++)if(!Number(v[i][0])){v[i][0]=nextRev_();changed=true}if(changed)sh.getRange(2,col,v.length,1).setValues(v)}
function setup(){getStoreId_();var l=logSheet_(),r=reflSheet_();assignMissingRevisions_(l,9);assignMissingRevisions_(r,8);l.getRange(1,1,1,LOG_HEAD.length).setValues([LOG_HEAD]).setFontWeight('bold').setBackground('#1F3D3A').setFontColor('#fff');r.getRange(1,1,1,REFL_HEAD.length).setValues([REFL_HEAD]).setFontWeight('bold').setBackground('#1F3D3A').setFontColor('#fff');l.setFrozenRows(1);r.setFrozenRows(1);l.getRange('B:C').setNumberFormat('@');l.getRange('F:F').setNumberFormat('yyyy-mm-dd hh:mm:ss');r.getRange('A:A').setNumberFormat('@');r.getRange('F:F').setNumberFormat('yyyy-mm-dd hh:mm:ss');l.setColumnWidth(5,360);r.setColumnWidth(2,280);r.setColumnWidth(3,320);r.setColumnWidth(4,280);r.setColumnWidth(5,280);SpreadsheetApp.getUi().alert('업무일지 v7 준비 끝. 배포 관리에서 새 버전으로 다시 배포해줘.')}
