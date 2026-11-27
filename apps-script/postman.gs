/**
 * 📮 郵差（Google Apps Script）
 * 幫「踏查文案小幫手」保管 LINE、FB、IG 的鑰匙，老師按「確認」後，時間到就自動發送。
 *
 * 安裝方法請看同一個資料夾的 README.md。鑰匙放在「專案設定 → 指令碼屬性」，不要寫在這個檔案裡。
 *
 * 指令碼屬性（Script Properties）：
 *   SECRET            郵差密碼（自己想一串長長的英文數字，網站設定頁也要貼一樣的）
 *   LINE_TOKEN        LINE Messaging API 的「頻道存取權杖（長期）」
 *   LINE_TEST_USER_ID （選填）填了就只發給這個人（老師自己）測試，不會發給全部好友
 *   FB_PAGE_ID        FB 粉專的編號（數字）
 *   FB_PAGE_TOKEN     FB 粉專存取權杖（IG 也用這一把）
 *   IG_TOKEN          （選填，通常不用）IG 想用另一把鑰匙時才填
 *   DRY_RUN           （選填）填 1 就只是「假裝發送」，什麼都不會真的發出去
 *
 * 照片：老師按確認後，照片會「暫時」放在這個 Google 帳號的雲端硬碟資料夾
 * 「踏查郵差暫存照片（發完會自動刪除）」，發完就刪掉。沒發成功的，3 天後也會自動刪掉。
 */

var MAX_LATE_MS = 6 * 60 * 60 * 1000;          // 超過發送時間 6 小時還沒發（例如郵差壞掉），就不發了
var STUCK_MS = 15 * 60 * 1000;                  // 「發送中」超過 15 分鐘＝郵差中途停掉了
var CLEANUP_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 沒發成功的照片，3 天後自動刪掉
var CHUNK = 2000;                               // 每格最多存 2000 字（Google 每格限制約 9KB）
var MAX_PHOTOS = 10;                            // IG 一篇最多 10 張
var PHOTO_FOLDER = '踏查郵差暫存照片（發完會自動刪除）';
var GRAPH = 'https://graph.facebook.com/';
var SEND_BUDGET_MS = 5 * 60 * 1000;             // 一次發送最多 5 分鐘（Google 每次最多跑 6 分鐘，留 1 分鐘收尾）
var igDeadline = 0;

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
  lock.waitLock(30000);
  try {
    if (action === 'schedule') return schedule_(req.job);
    if (action === 'cancel') return cancel_();
    if (action === 'retry') return retry_(req.retryId);
  } finally { lock.releaseLock(); }
  return { ok: false, error: '看不懂的動作：' + action };
}

// ---------- 排程 ----------

function schedule_(job) {
  if (!job || !job.sendAt) return { ok: false, error: '沒有發送時間。' };
  var line = (job.line || []).map(String).filter(function (t) { return t.trim(); }).slice(0, 5);
  var fb = String(job.fb || '').trim();
  var ig = String(job.ig || '').trim();
  var photos = job.photos || [];
  if (!line.length && !fb && !ig) return { ok: false, error: '沒有要發送的內容。' };
  for (var i = 0; i < line.length; i++) if (line[i].length > 5000) return { ok: false, error: 'LINE 每則最多 5000 字，第 ' + (i + 1) + ' 則太長了。' };
  if (photos.length > MAX_PHOTOS) return { ok: false, error: '照片最多 ' + MAX_PHOTOS + ' 張。' };
  if (ig && !photos.length) return { ok: false, error: 'IG 一定要有照片，請至少選 1 張。' };
  if (ig.length > 2200) return { ok: false, error: 'IG 文案最多 2200 字，現在有 ' + ig.length + ' 字。' };
  if ((ig.match(/#[^\s#]+/g) || []).length > 30) return { ok: false, error: 'IG 的 hashtag 最多 30 個。' };
  var old = loadJob_();
  if (old && old.status === 'sending' && !isStuck_(old)) return { ok: false, error: '上一次的發送正在進行中，請等一下再試。' };
  // 先檢查照片，再動雲端硬碟
  var blobs = [];
  for (var j = 0; j < photos.length; j++) {
    var p = photos[j] || {};
    if (!p.data) return { ok: false, error: '第 ' + (j + 1) + ' 張照片是空的。' };
    var bytes = Utilities.base64Decode(String(p.data));
    if (bytes.length > 8 * 1024 * 1024) return { ok: false, error: '第 ' + (j + 1) + ' 張照片太大了（超過 8MB）。' };
    blobs.push(Utilities.newBlob(bytes, p.mime || 'image/jpeg', 'photo' + (j + 1) + '.jpg'));
  }
  if (old) cleanupPhotos_(old); // 舊的那一次如果還留著照片，先清掉
  var folder = blobs.length ? photoFolder_() : null;
  var saved = {
    id: String(job.id || Date.now()),
    label: String(job.label || ''),
    sendAt: Number(job.sendAt),
    line: line,
    fb: fb,
    ig: ig,
    fbPhotos: !!job.fbPhotos && !!fb && blobs.length > 0,
    photos: blobs.map(function (b) { return { driveId: folder.createFile(b).getId() }; }),
    status: 'scheduled',
    createdAt: Date.now(),
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
  cleanupPhotos_(job);
  saveJob_(job);
  return { ok: true, job: summary_(job) };
}

/** 只重送失敗的部分（成功的不會再發一次） */
function retry_(retryId) {
  var job = loadJob_();
  if (job && job.status === 'sending' && isStuck_(job)) markStuck_(job);
  if (!job || (job.status !== 'partial' && job.status !== 'failed')) return { ok: false, error: '沒有失敗的發送需要重試。' };
  var r = job.results || {};
  var needPhotos = (job.ig && !(r.ig && r.ig.ok)) || (job.fbPhotos && !(r.fb && r.fb.ok));
  if (needPhotos && job.cleaned) return { ok: false, error: '這次的照片已經清掉了（超過 3 天），沒辦法重送。請到網站重新選照片、按確認。' };
  job.retryId = String(retryId || Date.now());
  sendJob_(job);
  return { ok: true, job: summary_(job) };
}

// ---------- 每 5 分鐘看一次（時間觸發） ----------

function tick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var job = loadJob_();
    if (!job) return;
    var now = Date.now();
    if (job.status === 'sending' && isStuck_(job)) { markStuck_(job); saveJob_(job); return; }
    if (job.status !== 'scheduled') {
      // 沒發成功的，3 天後把暫存的照片清掉
      if (!job.cleaned && (job.status === 'partial' || job.status === 'failed') && now - (job.sentAt || job.sendAt) > CLEANUP_AFTER_MS) {
        cleanupPhotos_(job);
        saveJob_(job);
      }
      return;
    }
    if (now < job.sendAt) return;
    if (now - job.sendAt > MAX_LATE_MS) {
      job.status = 'expired';
      job.results = { note: '超過發送時間太久（6 小時以上）才被郵差看到，為了安全沒有發送。' };
      cleanupPhotos_(job);
      saveJob_(job);
      return;
    }
    sendJob_(job);
  } finally { lock.releaseLock(); }
}

function isStuck_(job) { return job.status === 'sending' && Date.now() - (job.sendingAt || 0) > STUCK_MS; }
function markStuck_(job) {
  job.status = 'failed';
  job.sentAt = Date.now();
  (job.results || (job.results = {})).note = '郵差發送到一半停掉了。請看哪些沒有 ✅，按「重送失敗的部分」。';
}

function sendJob_(job) {
  var props = PropertiesService.getScriptProperties();
  var dry = props.getProperty('DRY_RUN') === '1';
  var r = job.results || {};
  job.results = r;
  delete r.note;
  job.status = 'sending';
  job.sendingAt = Date.now();
  saveJob_(job);
  if (job.line.length && !(r.line && r.line.ok)) { r.line = safe_(function () { return sendLine_(job, dry); }); saveJob_(job); }
  // 照片先放到 FB 粉專（不公開），FB 貼文和 IG 都用這幾張
  var uploadErr = '';
  var needFbPhotos = !dry && job.photos.length && ((job.fbPhotos && !(r.fb && r.fb.ok)) || (job.ig && !(r.ig && r.ig.ok)));
  if (needFbPhotos && !(job.fbPhotoIds && job.fbPhotoIds.length === job.photos.length)) {
    var up = safe_(function () { return uploadFbPhotos_(job); });
    if (!up.ok) uploadErr = up.msg;
    saveJob_(job);
  }
  if (job.fb && !(r.fb && r.fb.ok)) { r.fb = safe_(function () { return sendFb_(job, dry, uploadErr); }); saveJob_(job); }
  if (job.ig && !(r.ig && r.ig.ok)) { r.ig = safe_(function () { return sendIg_(job, dry); }); saveJob_(job); }
  var parts = [r.line, r.fb, r.ig].filter(function (x) { return x; });
  var good = parts.filter(function (x) { return x.ok; }).length;
  job.status = good === parts.length ? 'sent' : good ? 'partial' : 'failed';
  job.sentAt = Date.now();
  job.dryRun = dry;
  if (job.status === 'sent') cleanupPhotos_(job);
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

// ---------- Facebook／Instagram 共用 ----------

function metaKeys_() {
  var props = PropertiesService.getScriptProperties();
  var page = props.getProperty('FB_PAGE_ID'), token = props.getProperty('FB_PAGE_TOKEN');
  return { page: page, token: token, igToken: props.getProperty('IG_TOKEN') || token };
}

function metaError_(data, code) {
  var e = (data && data.error) || {};
  var m = e.error_user_msg || e.message || ('回覆錯誤（' + code + '）');
  if (e.code === 190) return '鑰匙（粉專存取權杖）過期或不對，請重新拿一把。（' + m + '）';
  if (e.code === 10 || (e.code >= 200 && e.code < 300)) return '鑰匙的權限不夠，請照安裝說明 C 段把權限都勾上，再拿一次鑰匙。（' + m + '）';
  if (e.code === 36003) return '照片的長寬比例 IG 不收。（' + m + '）';
  if (e.code === 9004) return 'IG 抓不到照片。（' + m + '）';
  return m;
}

function graph_(method, path, params) {
  var opt = { method: method, muteHttpExceptions: true };
  var url = GRAPH + path;
  if (method === 'get' || method === 'delete') {
    var q = Object.keys(params || {}).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    if (q) url += (path.indexOf('?') >= 0 ? '&' : '?') + q;
  } else opt.payload = params;
  var res = UrlFetchApp.fetch(url, opt);
  var code = res.getResponseCode();
  var data = {};
  try { data = JSON.parse(res.getContentText() || '{}'); } catch (e) { data = {}; }
  if (code !== 200 || data.error) throw new Error(metaError_(data, code));
  return data;
}

// ---------- Facebook 粉專 ----------

/** 把照片上傳到粉專，但先不公開（published=false）。記下編號，FB 貼文和 IG 都用它 */
function uploadFbPhotos_(job) {
  var k = metaKeys_();
  if (!k.page || !k.token) return { ok: false, msg: '郵差還沒設定 FB_PAGE_ID 或 FB_PAGE_TOKEN。' };
  var ids = [];
  try {
    for (var i = 0; i < job.photos.length; i++) {
      var blob = DriveApp.getFileById(job.photos[i].driveId).getBlob();
      ids.push(graph_('post', encodeURIComponent(k.page) + '/photos', { source: blob, published: 'false', access_token: k.token }).id);
    }
  } catch (err) {
    ids.forEach(function (id) { deleteFbPhoto_(id, k.token); });
    return { ok: false, msg: '照片上傳到 FB 失敗：' + (err && err.message || err) };
  }
  job.fbPhotoIds = ids;
  return { ok: true };
}

function sendFb_(job, dry, uploadErr) {
  var k = metaKeys_();
  if (!k.page || !k.token) return { ok: false, msg: '郵差還沒設定 FB_PAGE_ID 或 FB_PAGE_TOKEN。' };
  var n = job.fbPhotos ? job.photos.length : 0;
  var withText = n ? '（' + n + ' 張照片）' : '';
  if (dry) return { ok: true, msg: '（假裝發送）FB 粉專貼文' + withText };
  if (n && !(job.fbPhotoIds && job.fbPhotoIds.length === n)) return { ok: false, msg: uploadErr || '照片還沒上傳到 FB。' };
  var params = { message: job.fb, access_token: k.token };
  if (n) job.fbPhotoIds.forEach(function (id, i) { params['attached_media[' + i + ']'] = JSON.stringify({ media_fbid: id }); });
  try {
    var d = graph_('post', encodeURIComponent(k.page) + '/feed', params);
    return { ok: true, msg: 'FB 粉專已發文' + withText, postId: d.id, url: 'https://www.facebook.com/' + d.id };
  } catch (err) {
    return { ok: false, msg: 'FB：' + (err && err.message || err) };
  }
}

function deleteFbPhoto_(id, token) {
  try { graph_('delete', encodeURIComponent(id), { access_token: token }); return true; } catch (e) { return false; }
}

/** 不公開的 FB 照片，在 FB 主機上的網址（IG 會自己來抓） */
function fbPhotoUrl_(id, token) {
  var d = graph_('get', encodeURIComponent(id), { fields: 'images', access_token: token });
  var best = (d.images || []).sort(function (a, b) { return (b.width || 0) - (a.width || 0); })[0];
  if (!best || !best.source) throw new Error('拿不到 FB 照片的網址');
  return best.source;
}

// ---------- Instagram ----------

function sendIg_(job, dry) {
  var n = job.photos.length;
  if (!n) return { ok: false, msg: 'IG 一定要有照片。' };
  if (dry) return { ok: true, msg: '（假裝發送）IG 貼文，' + n + ' 張照片' };
  var k = metaKeys_();
  if (!k.page || !k.igToken) return { ok: false, msg: '郵差還沒設定 FB_PAGE_ID 或 FB_PAGE_TOKEN（IG 也要用這兩個）。' };
  igDeadline = (job.sendingAt || Date.now()) + SEND_BUDGET_MS;
  try {
    var igId = igUserId_(k.page, k.igToken);
    var carousel = n > 1;
    var children = [];
    for (var i = 0; i < n; i++) children.push(igContainerFor_(job, i, igId, k, carousel ? null : job.ig));
    var creation = children[0];
    if (carousel) {
      creation = graph_('post', igId + '/media', { media_type: 'CAROUSEL', children: children.join(','), caption: job.ig, access_token: k.igToken }).id;
      waitIg_(creation, k.igToken);
    }
    var media = publishIg_(igId, creation, k.igToken);
    var link = '';
    try { link = graph_('get', encodeURIComponent(media.id), { fields: 'permalink', access_token: k.igToken }).permalink || ''; } catch (e) { link = ''; }
    return { ok: true, msg: 'IG 已發文（' + n + ' 張照片）', mediaId: media.id, url: link };
  } catch (err) {
    return { ok: false, msg: 'IG：' + (err && err.message || err) };
  }
}

function igUserId_(page, token) {
  var d = graph_('get', encodeURIComponent(page), { fields: 'instagram_business_account', access_token: token });
  if (!d.instagram_business_account || !d.instagram_business_account.id) throw new Error('粉專還沒有連結 IG 專業帳號，或鑰匙少了 instagram_basic 權限。');
  return d.instagram_business_account.id;
}

/**
 * 做一張 IG 照片。IG 只收「網路上抓得到」的照片：
 * 先用剛剛放到 FB 粉專（不公開）的照片網址；IG 抓不到的話，改用雲端硬碟「知道連結的人可以看」的網址。
 */
function igContainerFor_(job, i, igId, k, caption) {
  var sources = [];
  var fbId = job.fbPhotoIds && job.fbPhotoIds[i];
  if (fbId) sources.push(function () { return fbPhotoUrl_(fbId, k.token); });
  sources.push(function () { return drivePublicUrl_(job.photos[i].driveId); });
  var lastErr = '';
  for (var s = 0; s < sources.length; s++) {
    try {
      var params = { image_url: sources[s](), access_token: k.igToken };
      if (caption != null) params.caption = caption; else params.is_carousel_item = 'true';
      var id = graph_('post', igId + '/media', params).id;
      waitIg_(id, k.igToken);
      return id;
    } catch (err) { lastErr = String(err && err.message || err); }
  }
  throw new Error('第 ' + (i + 1) + ' 張照片處理失敗：' + lastErr);
}

/** 等 IG 把照片處理好（通常幾秒鐘） */
function waitIg_(id, token) {
  for (var t = 0; t < 15; t++) {
    if (igDeadline && Date.now() > igDeadline) break;
    var d = graph_('get', encodeURIComponent(id), { fields: 'status_code,status', access_token: token });
    if (d.status_code === 'FINISHED') return;
    if (d.status_code === 'ERROR' || d.status_code === 'EXPIRED') throw new Error('IG 處理照片失敗（' + (d.status || d.status_code) + '）');
    Utilities.sleep(2000);
  }
  throw new Error('IG 處理照片太久了，請等一下按「重送失敗的部分」。');
}

function publishIg_(igId, creation, token) {
  var last;
  for (var t = 0; t < 3; t++) {
    try { return graph_('post', igId + '/media_publish', { creation_id: creation, access_token: token }); }
    catch (err) { last = err; Utilities.sleep(3000); }
  }
  throw last;
}

// ---------- 雲端硬碟（暫存照片） ----------

function photoFolder_() {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
}

function drivePublicUrl_(id) {
  DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id);
}

/** 永久刪除（不進垃圾桶）；不行的話才丟進垃圾桶（30 天後 Google 自動清掉） */
function deleteDriveFile_(id) {
  try {
    var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id), {
      method: 'delete', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code === 204 || code === 200 || code === 404) return 'deleted';
  } catch (e) { /* 改丟垃圾桶 */ }
  try { DriveApp.getFileById(id).setTrashed(true); return 'trash'; } catch (e) { return 'fail'; }
}

/**
 * 發完（或取消、過期、失敗超過 3 天）就把暫存的照片刪掉：
 * 1. 雲端硬碟裡的照片
 * 2. FB 粉專上「不公開」的照片——但如果 FB 貼文已經用了這些照片，就不能刪（刪了貼文的照片會不見）
 */
function cleanupPhotos_(job) {
  if (!job || job.cleaned) return;
  var photos = job.photos || [];
  var how = photos.map(function (p) { return deleteDriveFile_(p.driveId); });
  var r = job.results || {};
  var attached = job.fbPhotos && r.fb && r.fb.ok;
  if (!attached && job.fbPhotoIds && job.fbPhotoIds.length) {
    var token = metaKeys_().token;
    job.fbPhotoIds.forEach(function (id) { deleteFbPhoto_(id, token); });
  }
  job.cleaned = true;
  if (!photos.length) job.photosNote = '';
  else if (how.indexOf('fail') >= 0) job.photosNote = '⚠️ 有照片刪不掉，請到雲端硬碟「' + PHOTO_FOLDER + '」資料夾手動刪除。';
  else if (how.indexOf('trash') >= 0) job.photosNote = '暫存的照片已經丟進雲端硬碟的垃圾桶（30 天後 Google 會自動清掉）。';
  else job.photosNote = '暫存的照片已經刪掉了。';
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

/** 不發文，只確認鑰匙能不能用，順便看 LINE 這個月還剩幾則 */
function check_() {
  var props = PropertiesService.getScriptProperties();
  var out = { ok: true, line: null, fb: null, ig: null, drive: null, triggerOn: hasTrigger_(), dryRun: props.getProperty('DRY_RUN') === '1', lineTest: !!props.getProperty('LINE_TEST_USER_ID') };
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
  var k = metaKeys_();
  if (!k.page || !k.token) {
    out.fb = { ok: false, msg: '還沒設定 FB_PAGE_ID 或 FB_PAGE_TOKEN' };
    out.ig = { ok: false, msg: '還沒設定 FB_PAGE_ID 或 FB_PAGE_TOKEN（IG 也要用）' };
  } else {
    out.fb = safe_(function () { return { ok: true, name: graph_('get', encodeURIComponent(k.page), { fields: 'name', access_token: k.token }).name }; });
    out.ig = safe_(function () {
      var d = graph_('get', encodeURIComponent(k.page), { fields: 'instagram_business_account{username}', access_token: k.igToken });
      var a = d.instagram_business_account;
      if (!a) return { ok: false, msg: '粉專還沒有連結 IG 專業帳號，或鑰匙少了 instagram_basic 權限。' };
      return { ok: true, name: a.username ? '@' + a.username : a.id };
    });
  }
  out.drive = safe_(function () { DriveApp.getRootFolder().getId(); return { ok: true }; });
  return out;
}

function summary_(job) {
  var photos = job.photos || [];
  return {
    id: job.id, label: job.label, sendAt: job.sendAt, status: job.status, createdAt: job.createdAt, sentAt: job.sentAt || null,
    lineCount: job.line.length, hasFb: !!job.fb, hasIg: !!job.ig, photoCount: photos.length, fbPhotos: !!job.fbPhotos,
    results: job.results || {}, dryRun: !!job.dryRun, retryId: job.retryId || null, cleaned: !!job.cleaned, photosNote: job.photosNote || '',
    preview: { line: job.line.map(function (t) { return t.slice(0, 40); }), fb: job.fb.slice(0, 40), ig: (job.ig || '').slice(0, 40) },
  };
}

// ---------- 存放（指令碼屬性每格約 9KB，所以切成好幾格；照片不放這裡） ----------

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
  try {
    var job = JSON.parse(s);
    job.photos = job.photos || [];
    job.fb = job.fb || '';
    job.ig = job.ig || '';
    return job;
  } catch (e) { return null; }
}

// ---------- 鬧鐘（時間觸發） ----------

function hasTrigger_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tick'; });
}

function ensureTrigger_() {
  if (!hasTrigger_()) ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
}

/** 安裝時（和每次更新程式後）按一次：設定好鬧鐘，並請 Google 給權限（連外部網站、雲端硬碟） */
function 安裝() {
  ensureTrigger_();
  UrlFetchApp.fetch('https://api.line.me/', { muteHttpExceptions: true }); // 讓 Google 先問「可以連外部網站嗎」
  photoFolder_();                                                          // 讓 Google 先問「可以用雲端硬碟嗎」，並建好暫存資料夾
  ScriptApp.getOAuthToken();
  Logger.log('✅ 鬧鐘設定好了：每 5 分鐘檢查一次要不要發送。');
  Logger.log('✅ 雲端硬碟暫存資料夾：' + PHOTO_FOLDER);
  Logger.log('SECRET 有設定嗎？' + (PropertiesService.getScriptProperties().getProperty('SECRET') ? '有' : '❌ 還沒有'));
}
