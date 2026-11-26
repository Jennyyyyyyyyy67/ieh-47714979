/**
 * 📮 郵差（Google Apps Script）
 * 幫「踏查文案小幫手」保管 LINE 和 FB 的鑰匙，老師按「確認」後，時間到就自動發送。
 *
 * 安裝方法請看同一個資料夾的 README.md。鑰匙放在「專案設定 → 指令碼屬性」，不要寫在這個檔案裡。
 *
 * 指令碼屬性（Script Properties）：
 *   SECRET            郵差密碼（自己想一串長長的英文數字，網站設定頁也要貼一樣的）
 *   LINE_TOKEN        LINE Messaging API 的「頻道存取權杖（長期）」
 *   LINE_TEST_USER_ID （選填）填了就只發給這個人（老師自己）測試，不會發給全部好友
 *   FB_PAGE_ID        FB 粉專的編號（數字）
 *   FB_PAGE_TOKEN     FB 粉專存取權杖
 *   DRY_RUN           （選填）填 1 就只是「假裝發送」，什麼都不會真的發出去
 */

var MAX_LATE_MS = 6 * 60 * 60 * 1000; // 超過發送時間 6 小時還沒發（例如郵差壞掉），就不發了，避免半夜突然發出去
var CHUNK = 2000;                     // 每格最多存 2000 字（Google 每格限制約 9KB）

// ---------- 網站呼叫的入口 ----------

/** 網站送來「排程」「取消」「重試」（POST，內容是 JSON 文字） */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = handle(req);
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** 網站查狀態（GET，用 JSONP 讀回結果） */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try { out = handle({ action: p.action || 'status', secret: p.secret }); }
  catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  var json = JSON.stringify(out);
  var cb = String(p.callback || '');
  if (/^[A-Za-z_$][\w$]{0,60}$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SECRET');
  if (!secret) return { ok: false, error: '郵差還沒設定 SECRET（郵差密碼）。' };
  if (!req.secret || req.secret !== secret) return { ok: false, error: '郵差密碼不對。請到網站「設定」重新貼上。' };
  var action = req.action || 'status';
  if (action === 'status') return status_();
  if (action === 'check') return check_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (action === 'schedule') return schedule_(req.job);
    if (action === 'cancel') return cancel_();
    if (action === 'retry') return retry_();
  } finally { lock.releaseLock(); }
  return { ok: false, error: '看不懂的動作：' + action };
}

// ---------- 排程 ----------

function schedule_(job) {
  if (!job || !job.sendAt) return { ok: false, error: '沒有發送時間。' };
  var line = (job.line || []).map(String).filter(function (t) { return t.trim(); }).slice(0, 5);
  var fb = String(job.fb || '').trim();
  if (!line.length && !fb) return { ok: false, error: '沒有要發送的內容。' };
  for (var i = 0; i < line.length; i++) if (line[i].length > 5000) return { ok: false, error: 'LINE 每則最多 5000 字，第 ' + (i + 1) + ' 則太長了。' };
  var old = loadJob_();
  if (old && (old.status === 'sending')) return { ok: false, error: '上一次的發送正在進行中，請等一下再試。' };
  var now = Date.now();
  var saved = {
    id: String(job.id || now),
    label: String(job.label || ''),
    sendAt: Number(job.sendAt),
    line: line,
    fb: fb,
    status: 'scheduled',
    createdAt: now,
    results: {},
  };
  saveJob_(saved);
  ensureTrigger_();
  return { ok: true, job: summary_(saved) };
}

function cancel_() {
  var job = loadJob_();
  if (!job || job.status !== 'scheduled') return { ok: false, error: '現在沒有排好的發送可以取消。' };
  job.status = 'cancelled';
  saveJob_(job);
  return { ok: true, job: summary_(job) };
}

/** 只重送失敗的部分（成功的不會再發一次） */
function retry_() {
  var job = loadJob_();
  if (!job || (job.status !== 'partial' && job.status !== 'failed')) return { ok: false, error: '沒有失敗的發送需要重試。' };
  sendJob_(job);
  return { ok: true, job: summary_(job) };
}

// ---------- 每 5 分鐘看一次（時間觸發） ----------

function tick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var job = loadJob_();
    if (!job || job.status !== 'scheduled') return;
    var now = Date.now();
    if (now < job.sendAt) return;
    if (now - job.sendAt > MAX_LATE_MS) {
      job.status = 'expired';
      job.results = { note: '超過發送時間太久（6 小時以上）才被郵差看到，為了安全沒有發送。' };
      saveJob_(job);
      return;
    }
    sendJob_(job);
  } finally { lock.releaseLock(); }
}

function sendJob_(job) {
  var props = PropertiesService.getScriptProperties();
  var dry = props.getProperty('DRY_RUN') === '1';
  job.status = 'sending';
  saveJob_(job);
  var r = job.results || {};
  if (job.line.length && !(r.line && r.line.ok)) r.line = safe_(function () { return sendLine_(job, dry); });
  if (job.fb && !(r.fb && r.fb.ok)) r.fb = safe_(function () { return sendFb_(job.fb, dry); });
  var parts = [r.line, r.fb].filter(function (x) { return x; });
  var good = parts.filter(function (x) { return x.ok; }).length;
  job.results = r;
  job.status = good === parts.length ? 'sent' : good ? 'partial' : 'failed';
  job.sentAt = Date.now();
  job.dryRun = dry;
  saveJob_(job);
}

function safe_(fn) {
  try { return fn(); } catch (err) { return { ok: false, msg: String(err && err.message || err) }; }
}

// ---------- LINE ----------

function sendLine_(job, dry) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('LINE_TOKEN');
  if (!token) return { ok: false, msg: '郵差還沒設定 LINE_TOKEN。' };
  var testUser = props.getProperty('LINE_TEST_USER_ID');
  var messages = job.line.map(function (t) { return { type: 'text', text: t }; });
  var url = testUser ? 'https://api.line.me/v2/bot/message/push' : 'https://api.line.me/v2/bot/message/broadcast';
  var body = testUser ? { to: testUser, messages: messages } : { messages: messages };
  var who = testUser ? '只發給測試的老師' : '發給所有好友';
  if (dry) return { ok: true, msg: '（假裝發送）' + who + '，' + messages.length + ' 個泡泡' };
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'X-Line-Retry-Key': uuidFor_(job.id + ':line') },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  // 409＝同一個重試鑰匙已經送過了（代表上一次其實成功了）
  if (code === 200 || code === 409) return { ok: true, msg: who + '，' + messages.length + ' 個泡泡' };
  return { ok: false, msg: lineError_(code, res.getContentText()) };
}

function lineError_(code, text) {
  var m = '';
  try { m = JSON.parse(text).message || ''; } catch (e) { m = String(text).slice(0, 200); }
  if (code === 401) return 'LINE 鑰匙（頻道存取權杖）不對或過期了。（' + m + '）';
  if (code === 429) return 'LINE 這個月的訊息額度用完了，或一下子送太多次。（' + m + '）';
  return 'LINE 回覆錯誤（' + code + '）：' + m;
}

/** 用工作編號做出固定的 UUID，同一次發送重試時 LINE 才知道是同一則，不會重複發 */
function uuidFor_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  var hex = bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

// ---------- Facebook 粉專 ----------

function sendFb_(text, dry) {
  var props = PropertiesService.getScriptProperties();
  var page = props.getProperty('FB_PAGE_ID');
  var token = props.getProperty('FB_PAGE_TOKEN');
  if (!page || !token) return { ok: false, msg: '郵差還沒設定 FB_PAGE_ID 或 FB_PAGE_TOKEN。' };
  if (dry) return { ok: true, msg: '（假裝發送）FB 粉專貼文' };
  var res = UrlFetchApp.fetch('https://graph.facebook.com/' + encodeURIComponent(page) + '/feed', {
    method: 'post',
    payload: { message: text, access_token: token },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) { data = {}; }
  if (code === 200 && data.id) return { ok: true, msg: 'FB 粉專已發文', postId: data.id };
  var msg = (data.error && data.error.message) || res.getContentText().slice(0, 200);
  if (data.error && data.error.code === 190) return { ok: false, msg: 'FB 鑰匙（粉專存取權杖）過期或不對，請重新拿一把。（' + msg + '）' };
  return { ok: false, msg: 'FB 回覆錯誤（' + code + '）：' + msg };
}

// ---------- 狀態、連線檢查 ----------

function status_() {
  var job = loadJob_();
  var props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    now: Date.now(),
    job: job ? summary_(job) : null,
    triggerOn: hasTrigger_(),
    dryRun: props.getProperty('DRY_RUN') === '1',
    lineTest: !!props.getProperty('LINE_TEST_USER_ID'),
  };
}

/** 不發文，只確認兩把鑰匙能不能用，順便看 LINE 這個月還剩幾則 */
function check_() {
  var props = PropertiesService.getScriptProperties();
  var out = { ok: true, line: null, fb: null, triggerOn: hasTrigger_(), dryRun: props.getProperty('DRY_RUN') === '1', lineTest: !!props.getProperty('LINE_TEST_USER_ID') };
  var lt = props.getProperty('LINE_TOKEN');
  if (!lt) out.line = { ok: false, msg: '還沒設定 LINE_TOKEN' };
  else out.line = safe_(function () {
    var h = { headers: { Authorization: 'Bearer ' + lt }, muteHttpExceptions: true };
    var info = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', h);
    if (info.getResponseCode() !== 200) return { ok: false, msg: lineError_(info.getResponseCode(), info.getContentText()) };
    var name = JSON.parse(info.getContentText()).displayName || '';
    var r = { ok: true, name: name };
    var q = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota', h);
    var c = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota/consumption', h);
    if (q.getResponseCode() === 200) { var qd = JSON.parse(q.getContentText()); r.quotaType = qd.type; r.quota = qd.value; }
    if (c.getResponseCode() === 200) r.used = JSON.parse(c.getContentText()).totalUsage;
    var f = UrlFetchApp.fetch('https://api.line.me/v2/bot/insight/followers?date=' + Utilities.formatDate(new Date(Date.now() - 86400000), 'Asia/Tokyo', 'yyyyMMdd'), h);
    if (f.getResponseCode() === 200) { var fd = JSON.parse(f.getContentText()); if (fd.status === 'ready') r.friends = fd.targetedReaches; }
    return r;
  });
  var page = props.getProperty('FB_PAGE_ID'), ft = props.getProperty('FB_PAGE_TOKEN');
  if (!page || !ft) out.fb = { ok: false, msg: '還沒設定 FB_PAGE_ID 或 FB_PAGE_TOKEN' };
  else out.fb = safe_(function () {
    var res = UrlFetchApp.fetch('https://graph.facebook.com/' + encodeURIComponent(page) + '?fields=name&access_token=' + encodeURIComponent(ft), { muteHttpExceptions: true });
    var d = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() === 200 && d.name) return { ok: true, name: d.name };
    return { ok: false, msg: (d.error && d.error.message) || ('FB 回覆錯誤（' + res.getResponseCode() + '）') };
  });
  return out;
}

function summary_(job) {
  return {
    id: job.id, label: job.label, sendAt: job.sendAt, status: job.status, createdAt: job.createdAt, sentAt: job.sentAt || null,
    lineCount: job.line.length, hasFb: !!job.fb, results: job.results || {}, dryRun: !!job.dryRun,
    preview: { line: job.line.map(function (t) { return t.slice(0, 40); }), fb: job.fb.slice(0, 40) },
  };
}

// ---------- 存放（指令碼屬性每格約 9KB，所以切成好幾格） ----------

function saveJob_(job) {
  var props = PropertiesService.getScriptProperties();
  var s = JSON.stringify(job);
  var n = Math.ceil(s.length / CHUNK) || 1;
  var data = { JOB_N: String(n) };
  for (var i = 0; i < n; i++) data['JOB_' + i] = s.slice(i * CHUNK, (i + 1) * CHUNK);
  var oldN = Number(props.getProperty('JOB_N') || 0);
  props.setProperties(data);
  for (var j = n; j < oldN; j++) props.deleteProperty('JOB_' + j);
}

function loadJob_() {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('JOB_N') || 0);
  if (!n) return null;
  var s = '';
  for (var i = 0; i < n; i++) s += props.getProperty('JOB_' + i) || '';
  try { return JSON.parse(s); } catch (e) { return null; }
}

// ---------- 鬧鐘（時間觸發） ----------

function hasTrigger_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tick'; });
}

function ensureTrigger_() {
  if (!hasTrigger_()) ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
}

/** 安裝時按一次：設定好「每 5 分鐘看一次」的鬧鐘，並請 Google 給權限 */
function 安裝() {
  ensureTrigger_();
  UrlFetchApp.fetch('https://api.line.me/', { muteHttpExceptions: true }); // 讓 Google 先問「可以連外部網站嗎」
  Logger.log('✅ 鬧鐘設定好了：每 5 分鐘檢查一次要不要發送。');
  Logger.log('SECRET 有設定嗎？' + (PropertiesService.getScriptProperties().getProperty('SECRET') ? '有' : '❌ 還沒有'));
}
