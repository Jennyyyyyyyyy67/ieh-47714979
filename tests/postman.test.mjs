// 測試「郵差」（apps-script/postman.gs）。用假的 Google 服務和假的 LINE／FB／IG，不會真的發送任何東西。
// 執行：node tests/postman.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const code = readFileSync(new URL('../apps-script/postman.gs', import.meta.url), 'utf8');

function makeWorld(props = {}) {
  const store = { ...props };
  const triggers = [];
  const calls = [];
  const drive = { files: {}, folders: {}, next: 1, trashed: [], shared: [], deleteFails: false };
  let responder = () => ({ code: 200, body: '{}' });
  const fileObj = (id) => {
    if (!drive.files[id]) throw new Error('找不到檔案 ' + id);
    return {
      getId: () => id,
      getBlob: () => drive.files[id],
      setTrashed: () => { drive.trashed.push(id); delete drive.files[id]; },
      setSharing: (a, p) => { drive.shared.push([id, a, p]); },
    };
  };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperties: o => { for (const [k, v] of Object.entries(o)) { assert.ok(Buffer.byteLength(String(v)) < 9000, `每格要小於 9KB：${k}`); store[k] = String(v); } },
      deleteProperty: k => { delete store[k]; },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
      createTextOutput: s => ({ text: s, setMimeType(m) { this.mime = m; return this; } }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.map(h => ({ getHandlerFunction: () => h })),
      newTrigger: h => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => triggers.push(h) }) }) }),
      getOAuthToken: () => 'oauth-tok',
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' },
      getFoldersByName: name => { let used = false; const f = drive.folders[name]; return { hasNext: () => !!f && !used, next: () => { used = true; return f; } }; },
      createFolder: name => (drive.folders[name] = { name, createFile: blob => { const id = `d${drive.next++}`; drive.files[id] = blob; return fileObj(id); } }),
      getFileById: fileObj,
      getRootFolder: () => ({ getId: () => 'root' }),
    },
    UrlFetchApp: { fetch: (url, opt = {}) => {
      calls.push({ url, opt });
      const m = url.match(/googleapis\.com\/drive\/v3\/files\/([^?]+)/);
      if (m && opt.method === 'delete') {
        if (drive.deleteFails) return { getResponseCode: () => 403, getContentText: () => '{}' };
        delete drive.files[decodeURIComponent(m[1])];
        return { getResponseCode: () => 204, getContentText: () => '' };
      }
      const r = responder(url, opt);
      return { getResponseCode: () => r.code, getContentText: () => r.body };
    } },
    Utilities: {
      DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_a, s) => [...crypto.createHash('md5').update(s).digest()].map(b => (b > 127 ? b - 256 : b)),
      formatDate: () => '20261124',
      base64Decode: s => [...Buffer.from(s, 'base64')],
      newBlob: (bytes, mime, name) => ({ bytes, mime, name, getName: () => name }),
      sleep: () => {},
    },
    Logger: { log() {} },
    Date, JSON, Math, String, Number, Array, Object, Error,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, store, triggers, calls, drive, respond: f => { responder = f; } };
}
const post = (w, body) => JSON.parse(w.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const get = (w, params) => w.ctx.doGet({ parameter: params }).text;
const status = (w) => post(w, { action: 'status', secret: BASE.SECRET }).job;

const results = [];
const step = (name, fn) => { try { fn(); results.push(['✅', name]); } catch (e) { results.push(['❌', name, e.message.split('\n')[0]]); } };
const BASE = { SECRET: 's3cret-long', LINE_TOKEN: 'line-tok', FB_PAGE_ID: '123', FB_PAGE_TOKEN: 'fb-tok' };
const okLineFb = (url) => (url.includes('graph.facebook.com') ? { code: 200, body: '{"id":"123_456"}' } : { code: 200, body: '{}' });
const PHOTO = (n) => ({ name: `p${n}.jpg`, mime: 'image/jpeg', data: Buffer.from(`假的照片${n}`.repeat(50)).toString('base64') });
const ok = (o) => ({ code: 200, body: JSON.stringify(o) });
const metaErr = (c, m) => ({ code: 400, body: JSON.stringify({ error: { code: c, message: m } }) });

/** 假的 FB 粉專＋IG：記住上傳的照片、貼文、IG 容器 */
function fakeMeta(w, o = {}) {
  const st = { photo: 0, container: 0, uploads: [], deletedFb: [], feed: [], containers: {}, published: [] };
  w.respond((url, opt) => {
    if (url.includes('api.line.me')) return { code: 200, body: '{}' };
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.slice(1));
    const method = (opt.method || 'get').toLowerCase();
    if (method === 'post' && path === '123/photos') {
      if (o.uploadFail) return metaErr(200, '沒有權限');
      assert.equal(opt.payload.published, 'false', 'FB 照片要先不公開');
      assert.ok(opt.payload.source && opt.payload.source.bytes, '照片要用檔案上傳');
      st.uploads.push(opt.payload.source.name);
      return ok({ id: `p${++st.photo}` });
    }
    if (method === 'post' && path === '123/feed') { if (o.feedFail) return metaErr(190, 'expired'); st.feed.push(opt.payload); return ok({ id: '123_999' }); }
    if (method === 'get' && path === '123') {
      return String(u.searchParams.get('fields')).startsWith('instagram_business_account')
        ? ok(o.noIg ? { id: '123' } : { instagram_business_account: { id: 'ig1', username: 'test_ig' }, id: '123' })
        : ok({ name: '測試粉專', id: '123' });
    }
    if (method === 'get' && /^p\d+$/.test(path)) return ok({ images: [{ width: 320, source: `https://cdn.fb/${path}-small.jpg` }, { width: 1440, source: `https://cdn.fb/${path}.jpg` }] });
    if (method === 'delete' && /^p\d+$/.test(path)) { st.deletedFb.push(path); return ok({ success: true }); }
    if (method === 'post' && path === 'ig1/media') {
      const p = opt.payload;
      if (o.igFail) return metaErr(9004, 'cannot fetch');
      if (o.cdnFails && String(p.image_url || '').startsWith('https://cdn.fb/')) return metaErr(9004, 'cannot fetch');
      const id = `c${++st.container}`; st.containers[id] = p; return ok({ id });
    }
    if (method === 'get' && /^c\d+$/.test(path)) return ok({ status_code: 'FINISHED' });
    if (method === 'post' && path === 'ig1/media_publish') { if (o.publishFail) return metaErr(9007, 'not ready'); st.published.push(opt.payload.creation_id); return ok({ id: 'm1' }); }
    if (method === 'get' && path === 'm1') return ok({ permalink: 'https://www.instagram.com/p/abc/' });
    return { code: 404, body: JSON.stringify({ error: { message: `unknown ${method} ${path}` } }) };
  });
  return { st, set: (k, v) => { o[k] = v; } };
}

// ================= LINE／FB 文字（原本的） =================

step('密碼不對就拒絕；沒設定密碼也拒絕', () => {
  const w = makeWorld(BASE);
  assert.equal(post(w, { action: 'status', secret: 'wrong' }).ok, false);
  assert.match(post(w, { action: 'status', secret: 'wrong' }).error, /郵差密碼不對/);
  const w2 = makeWorld({});
  assert.match(post(w2, { action: 'status', secret: 'x' }).error, /還沒設定 SECRET/);
});

step('排程：存起來、自動裝好鬧鐘；時間還沒到不會發', () => {
  const w = makeWorld(BASE);
  w.respond(okLineFb);
  const r = post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'w1', sendAt: Date.now() + 3600e3, line: ['週會信', '踏查回顧'], fb: 'FB 貼文' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.job.status, 'scheduled');
  assert.deepEqual(w.triggers, ['tick']);
  w.ctx.tick();
  assert.equal(w.calls.length, 0, '時間還沒到');
});

step('時間到：LINE 群發（兩個泡泡一次送）＋FB 發文，只發一次', () => {
  const w = makeWorld(BASE);
  w.respond(okLineFb);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'w2', sendAt: Date.now() - 1000, line: ['週會信', '踏查回顧'], fb: 'FB 貼文' } });
  w.ctx.tick();
  const line = w.calls.find(c => c.url.includes('api.line.me'));
  assert.ok(line.url.endsWith('/broadcast'));
  assert.equal(line.opt.headers.Authorization, 'Bearer line-tok');
  assert.match(line.opt.headers['X-Line-Retry-Key'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(JSON.parse(line.opt.payload).messages.map(m => m.text), ['週會信', '踏查回顧']);
  const fb = w.calls.find(c => c.url.includes('graph.facebook.com'));
  assert.equal(fb.url, 'https://graph.facebook.com/123/feed');
  assert.equal(fb.opt.payload.message, 'FB 貼文');
  assert.ok(!Object.keys(fb.opt.payload).some(k => k.startsWith('attached_media')), '沒有照片就不附');
  const s = status(w);
  assert.equal(s.status, 'sent');
  assert.equal(s.results.fb.postId, '123_456');
  assert.equal(s.results.fb.url, 'https://www.facebook.com/123_456');
  const n = w.calls.length;
  w.ctx.tick(); w.ctx.tick();
  assert.equal(w.calls.length, n, '不可以重複發送');
});

step('FB 失敗、LINE 成功 → 狀態「部分成功」；按重試只重送 FB', () => {
  const w = makeWorld(BASE);
  let fbFail = true;
  w.respond(url => (url.includes('graph.facebook.com') ? (fbFail ? { code: 400, body: '{"error":{"code":190,"message":"expired"}}' } : { code: 200, body: '{"id":"1_2"}' }) : { code: 200, body: '{}' }));
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'w3', sendAt: Date.now() - 1000, line: ['A'], fb: 'B' } });
  w.ctx.tick();
  let s = status(w);
  assert.equal(s.status, 'partial');
  assert.match(s.results.fb.msg, /過期/);
  fbFail = false;
  const before = w.calls.filter(c => c.url.includes('api.line.me')).length;
  s = post(w, { action: 'retry', secret: BASE.SECRET, retryId: 'r1' }).job;
  assert.equal(s.status, 'sent');
  assert.equal(s.retryId, 'r1', '網站用 retryId 確認郵差收到了');
  assert.equal(w.calls.filter(c => c.url.includes('api.line.me')).length, before, 'LINE 已經成功，不能再發一次');
});

step('可以取消；取消後時間到也不會發', () => {
  const w = makeWorld(BASE);
  w.respond(okLineFb);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'w4', sendAt: Date.now() + 1000, line: ['A'], fb: '' } });
  assert.equal(post(w, { action: 'cancel', secret: BASE.SECRET }).job.status, 'cancelled');
  w.ctx.tick();
  assert.equal(w.calls.length, 0);
});

step('超過發送時間 6 小時才看到（郵差壞掉）→ 為了安全不發', () => {
  const w = makeWorld(BASE);
  w.respond(okLineFb);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'w5', sendAt: Date.now() - 7 * 3600e3, line: ['A'] } });
  w.ctx.tick();
  assert.equal(w.calls.length, 0);
  assert.equal(status(w).status, 'expired');
});

step('測試模式：填了 LINE_TEST_USER_ID 只發給老師自己；DRY_RUN 完全不發', () => {
  const w = makeWorld({ ...BASE, LINE_TEST_USER_ID: 'Uteacher' });
  w.respond(okLineFb);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'w6', sendAt: Date.now() - 1000, line: ['A'] } });
  w.ctx.tick();
  const c = w.calls.find(x => x.url.includes('api.line.me'));
  assert.ok(c.url.endsWith('/push'));
  assert.equal(JSON.parse(c.opt.payload).to, 'Uteacher');
  const d = makeWorld({ ...BASE, DRY_RUN: '1' });
  post(d, { action: 'schedule', secret: BASE.SECRET, job: { id: 'w7', sendAt: Date.now() - 1000, line: ['A'], fb: 'B' } });
  d.ctx.tick();
  assert.equal(d.calls.length, 0);
  const s = status(d);
  assert.equal(s.status, 'sent'); assert.equal(s.dryRun, true);
});

step('長文章（3 篇各 4000 字）切成很多格存，讀回來一字不差', () => {
  const w = makeWorld(BASE);
  const long = '踏'.repeat(4000);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'w8', sendAt: Date.now() + 1e6, line: [long, long], fb: long } });
  assert.ok(Number(w.store.JOB_N) > 3);
  const job = w.ctx.loadJob_();
  assert.equal(job.line[1], long); assert.equal(job.fb, long);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'w9', sendAt: Date.now() + 1e6, line: ['短'] } });
  assert.equal(w.store.JOB_N, '1');
  assert.ok(!('JOB_3' in w.store), '舊的格子要清掉');
});

step('擋下：沒內容、LINE 超過 5000 字', () => {
  const w = makeWorld(BASE);
  assert.match(post(w, { action: 'schedule', secret: BASE.SECRET, job: { sendAt: 1, line: [' '], fb: '' } }).error, /沒有要發送的內容/);
  assert.match(post(w, { action: 'schedule', secret: BASE.SECRET, job: { sendAt: 1, line: ['a'.repeat(5001)] } }).error, /5000/);
});

step('查狀態用 JSONP：回傳 callback(...)；怪怪的 callback 名稱不接受', () => {
  const w = makeWorld(BASE);
  const t = get(w, { action: 'status', secret: BASE.SECRET, callback: 'cb_1' });
  assert.match(t, /^cb_1\(\{"ok":true/);
  assert.ok(!get(w, { secret: BASE.SECRET, callback: 'alert(1);x' }).startsWith('alert'));
});

step('檢查連線：LINE 帳號名稱、本月額度、FB 粉專、IG 帳號、雲端硬碟（不發文）', () => {
  const w = makeWorld(BASE);
  fakeMeta(w);
  w.respond((url, opt) => {
    if (url.endsWith('/bot/info')) return { code: 200, body: '{"displayName":"測試官方帳號"}' };
    if (url.endsWith('/quota')) return { code: 200, body: '{"type":"limited","value":3000}' };
    if (url.endsWith('/consumption')) return { code: 200, body: '{"totalUsage":120}' };
    if (url.includes('followers')) return { code: 200, body: '{"status":"ready","targetedReaches":108}' };
    if (url.includes('instagram_business_account')) return ok({ instagram_business_account: { id: 'ig1', username: 'test_ig' } });
    if (url.includes('graph.facebook.com')) return ok({ name: '測試粉專', id: '123' });
    return { code: 404, body: '{}' };
  });
  const r = post(w, { action: 'check', secret: BASE.SECRET });
  assert.deepEqual([r.line.name, r.line.quota, r.line.used, r.line.friends, r.fb.name, r.ig.name, r.drive.ok], ['測試官方帳號', 3000, 120, 108, '測試粉專', '@test_ig', true]);
  assert.ok(!w.calls.some(c => /broadcast|push|feed|media|photos/.test(c.url)), '檢查時不可以發文');
});

step('檢查連線：粉專沒有連結 IG 時，白話說明', () => {
  const w = makeWorld(BASE);
  fakeMeta(w, { noIg: true });
  const r = post(w, { action: 'check', secret: BASE.SECRET });
  assert.equal(r.ig.ok, false);
  assert.match(r.ig.msg, /還沒有連結 IG 專業帳號/);
});

// ================= 照片、IG =================

step('照片：排程時暫存到雲端硬碟（不放在指令碼屬性）；IG 沒照片、超過 10 張、文案太長、hashtag 太多都會擋', () => {
  const w = makeWorld(BASE);
  const S = BASE.SECRET;
  assert.match(post(w, { action: 'schedule', secret: S, job: { sendAt: 1, ig: 'IG 文案' } }).error, /IG 一定要有照片/);
  assert.match(post(w, { action: 'schedule', secret: S, job: { sendAt: 1, ig: 'x', photos: Array.from({ length: 11 }, (_, i) => PHOTO(i)) } }).error, /最多 10 張/);
  assert.match(post(w, { action: 'schedule', secret: S, job: { sendAt: 1, ig: 'x'.repeat(2201), photos: [PHOTO(1)] } }).error, /2200/);
  assert.match(post(w, { action: 'schedule', secret: S, job: { sendAt: 1, ig: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '), photos: [PHOTO(1)] } }).error, /hashtag/);
  assert.equal(Object.keys(w.drive.files).length, 0, '被擋下的不能存照片');
  const r = post(w, { action: 'schedule', secret: S, job: { id: 'ph', sendAt: Date.now() + 1e6, fb: 'FB', fbPhotos: true, ig: 'IG #踏查', photos: [PHOTO(1), PHOTO(2)] } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.job.photoCount, 2);
  assert.equal(r.job.hasIg, true);
  assert.equal(Object.keys(w.drive.files).length, 2);
  assert.ok(w.drive.folders['踏查郵差暫存照片（發完會自動刪除）']);
  assert.ok(!Object.values(w.store).some(v => v.includes(PHOTO(1).data.slice(0, 40))), '照片內容不能存在指令碼屬性');
});

step('FB＋IG 都附 2 張照片：先放到 FB（不公開）→ FB 貼文附 2 張 → IG 輪播貼文 → 雲端硬碟照片刪掉；FB 照片在貼文裡，不能刪', () => {
  const w = makeWorld(BASE);
  const m = fakeMeta(w);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'both', sendAt: Date.now() - 1000, line: ['週會'], fb: 'FB 文', fbPhotos: true, ig: 'IG 文 #踏查', photos: [PHOTO(1), PHOTO(2)] } });
  w.ctx.tick();
  const s = status(w);
  assert.equal(s.status, 'sent', JSON.stringify(s.results));
  assert.equal(m.st.uploads.length, 2, '照片只上傳一次');
  assert.equal(m.st.feed[0]['attached_media[0]'], '{"media_fbid":"p1"}');
  assert.equal(m.st.feed[0]['attached_media[1]'], '{"media_fbid":"p2"}');
  const c = m.st.containers;
  assert.deepEqual([c.c1.image_url, c.c1.is_carousel_item, c.c1.caption], ['https://cdn.fb/p1.jpg', 'true', undefined], '用最大張的 FB 照片網址');
  assert.equal(c.c2.image_url, 'https://cdn.fb/p2.jpg');
  assert.deepEqual([c.c3.media_type, c.c3.children, c.c3.caption], ['CAROUSEL', 'c1,c2', 'IG 文 #踏查']);
  assert.deepEqual(m.st.published, ['c3']);
  assert.equal(s.results.ig.url, 'https://www.instagram.com/p/abc/');
  assert.match(s.results.ig.msg, /2 張/);
  assert.match(s.results.fb.msg, /2 張照片/);
  assert.equal(Object.keys(w.drive.files).length, 0, '雲端硬碟的照片要刪掉');
  assert.equal(w.drive.trashed.length, 0, '是永久刪除，不是丟垃圾桶');
  assert.deepEqual(m.st.deletedFb, [], 'FB 貼文在用的照片不能刪');
  assert.match(s.photosNote, /已經刪掉/);
});

step('只發 IG、1 張照片：不用輪播；發完把 FB 上不公開的照片刪掉', () => {
  const w = makeWorld(BASE);
  const m = fakeMeta(w);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'ig1', sendAt: Date.now() - 1000, ig: 'IG 文', photos: [PHOTO(1)] } });
  w.ctx.tick();
  assert.equal(status(w).status, 'sent');
  assert.deepEqual([m.st.containers.c1.caption, m.st.containers.c1.is_carousel_item], ['IG 文', undefined]);
  assert.deepEqual(m.st.published, ['c1']);
  assert.equal(m.st.feed.length, 0, '沒勾 FB 就不發 FB');
  assert.deepEqual(m.st.deletedFb, ['p1'], '不公開的 FB 照片用完要刪');
  assert.equal(Object.keys(w.drive.files).length, 0);
});

step('IG 抓不到 FB 的照片網址 → 改用雲端硬碟「知道連結的人可以看」→ 成功，發完照片刪掉', () => {
  const w = makeWorld(BASE);
  const m = fakeMeta(w, { cdnFails: true });
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'fallback', sendAt: Date.now() - 1000, ig: 'IG 文', photos: [PHOTO(1)] } });
  const driveId = Object.keys(w.drive.files)[0];
  w.ctx.tick();
  assert.equal(status(w).status, 'sent', JSON.stringify(status(w).results));
  assert.equal(m.st.containers.c1.image_url, `https://drive.google.com/uc?export=download&id=${driveId}`);
  assert.deepEqual(w.drive.shared[0], [driveId, 'ANYONE_WITH_LINK', 'VIEW']);
  assert.equal(Object.keys(w.drive.files).length, 0, '公開過的照片也要刪掉');
});

step('FB 上傳照片沒權限 → IG 直接用雲端硬碟的連結；FB 附照片的貼文失敗並說明原因', () => {
  const w = makeWorld(BASE);
  const m = fakeMeta(w, { uploadFail: true });
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'noup', sendAt: Date.now() - 1000, fb: 'FB', fbPhotos: true, ig: 'IG', photos: [PHOTO(1)] } });
  w.ctx.tick();
  const s = status(w);
  assert.equal(s.status, 'partial');
  assert.equal(s.results.ig.ok, true);
  assert.match(m.st.containers.c1.image_url, /drive\.google\.com/);
  assert.equal(s.results.fb.ok, false);
  assert.match(s.results.fb.msg, /照片上傳到 FB 失敗.*權限/);
  assert.equal(m.st.feed.length, 0, '照片沒上傳成功，就不要發沒有照片的 FB 貼文');
});

step('IG 失敗、FB 成功 → 部分成功、照片先留著；按重送只重送 IG（不重傳照片、不重發 FB）', () => {
  const w = makeWorld(BASE);
  const m = fakeMeta(w, { publishFail: true });
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'part', sendAt: Date.now() - 1000, line: ['L'], fb: 'FB', fbPhotos: true, ig: 'IG', photos: [PHOTO(1), PHOTO(2)] } });
  w.ctx.tick();
  let s = status(w);
  assert.equal(s.status, 'partial');
  assert.equal(s.results.fb.ok, true);
  assert.equal(s.results.ig.ok, false);
  assert.equal(Object.keys(w.drive.files).length, 2, '還要重送，照片先留著');
  m.set('publishFail', false);
  const lineBefore = w.calls.filter(c => c.url.includes('api.line.me')).length;
  s = post(w, { action: 'retry', secret: BASE.SECRET, retryId: 'r2' }).job;
  assert.equal(s.status, 'sent', JSON.stringify(s.results));
  assert.equal(m.st.uploads.length, 2, '不重傳照片');
  assert.equal(m.st.feed.length, 1, '不重發 FB');
  assert.equal(w.calls.filter(c => c.url.includes('api.line.me')).length, lineBefore, '不重發 LINE');
  assert.equal(Object.keys(w.drive.files).length, 0, '全部成功後照片刪掉');
  assert.deepEqual(m.st.deletedFb, [], 'FB 貼文在用的照片不能刪');
});

step('取消 → 暫存照片馬上刪掉；換成新的排程 → 舊的照片也刪掉', () => {
  const w = makeWorld(BASE);
  fakeMeta(w);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'c1', sendAt: Date.now() + 1e6, ig: 'IG', photos: [PHOTO(1), PHOTO(2)] } });
  assert.equal(Object.keys(w.drive.files).length, 2);
  const s = post(w, { action: 'cancel', secret: BASE.SECRET }).job;
  assert.equal(Object.keys(w.drive.files).length, 0);
  assert.match(s.photosNote, /已經刪掉/);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'c2', sendAt: Date.now() + 1e6, ig: 'IG', photos: [PHOTO(1)] } });
  const first = Object.keys(w.drive.files);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'c3', sendAt: Date.now() + 1e6, ig: 'IG', photos: [PHOTO(2)] } });
  assert.equal(Object.keys(w.drive.files).length, 1);
  assert.ok(!(first[0] in w.drive.files), '舊排程的照片要刪');
});

step('失敗超過 3 天 → 自動刪掉照片；之後按重送會說照片已經清掉', () => {
  const w = makeWorld(BASE);
  fakeMeta(w, { igFail: true });
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'old', sendAt: Date.now() - 1000, ig: 'IG', photos: [PHOTO(1)] } });
  w.ctx.tick();
  assert.equal(status(w).status, 'failed');
  assert.equal(Object.keys(w.drive.files).length, 1);
  w.ctx.tick();
  assert.equal(Object.keys(w.drive.files).length, 1, '還沒 3 天');
  const job = w.ctx.loadJob_();
  job.sentAt = Date.now() - 4 * 86400e3;
  w.ctx.saveJob_(job);
  w.ctx.tick();
  assert.equal(Object.keys(w.drive.files).length, 0);
  assert.match(post(w, { action: 'retry', secret: BASE.SECRET, retryId: 'x' }).error, /照片已經清掉/);
});

step('雲端硬碟不能永久刪除時 → 丟進垃圾桶，並告訴老師', () => {
  const w = makeWorld(BASE);
  fakeMeta(w);
  w.drive.deleteFails = true;
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 't', sendAt: Date.now() - 1000, ig: 'IG', photos: [PHOTO(1)] } });
  w.ctx.tick();
  const s = status(w);
  assert.equal(s.status, 'sent');
  assert.equal(w.drive.trashed.length, 1);
  assert.match(s.photosNote, /垃圾桶/);
});

step('郵差發送到一半停掉（「發送中」超過 15 分鐘）→ 標成失敗、可以重送；新的排程不會被卡住', () => {
  const w = makeWorld(BASE);
  fakeMeta(w);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'stuck', sendAt: Date.now() - 1000, line: ['L'] } });
  const job = w.ctx.loadJob_();
  job.status = 'sending'; job.sendingAt = Date.now() - 20 * 60e3;
  w.ctx.saveJob_(job);
  w.ctx.tick();
  const s = status(w);
  assert.equal(s.status, 'failed');
  assert.match(s.results.note, /停掉/);
  const job2 = w.ctx.loadJob_();
  job2.status = 'sending'; job2.sendingAt = Date.now() - 20 * 60e3;
  w.ctx.saveJob_(job2);
  assert.equal(post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'new', sendAt: Date.now() + 1e6, line: ['L'] } }).ok, true);
});

function slowWorld(finishAfter) {
  const w = makeWorld(BASE);
  const clock = { now: Date.now() };
  w.ctx.Date = class extends Date { static now() { return clock.now; } };
  w.ctx.Utilities.sleep = (ms) => { clock.now += ms; };
  const polls = {};
  let c = 0;
  w.respond((url, opt) => {
    const m = url.match(/graph\.facebook\.com\/(c\d+)\?/);
    if (m) { polls[m[1]] = (polls[m[1]] || 0) + 1; return ok({ status_code: polls[m[1]] >= finishAfter ? 'FINISHED' : 'IN_PROGRESS' }); }
    if (url.endsWith('ig1/media') && opt.method === 'post') return ok({ id: `c${++c}` });
    if (url.endsWith('ig1/media_publish')) return ok({ id: 'm1' });
    if (url.includes('instagram_business_account')) return ok({ instagram_business_account: { id: 'ig1' } });
    if (url.endsWith('/photos')) return ok({ id: `p${c}` });
    if (/\/p\d+\?/.test(url) && (opt.method || 'get') === 'get') return ok({ images: [{ width: 1, source: 'https://cdn.fb/x.jpg' }] });
    return ok({});
  });
  return { w, clock };
}

step('IG 一直處理不完 → 這張照片放棄，說明「太久」，不會卡住郵差', () => {
  const { w, clock } = slowWorld(Infinity);
  const t0 = clock.now;
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'slow', sendAt: t0 - 1000, ig: 'IG', photos: [PHOTO(1), PHOTO(2)] } });
  w.ctx.tick();
  const s = status(w);
  assert.equal(s.status, 'failed');
  assert.match(s.results.ig.msg, /太久/);
  assert.ok(clock.now - t0 < 2 * 60e3, `等了 ${Math.round((clock.now - t0) / 1000)} 秒`);
});

step('10 張照片每張都很慢（但會好）→ 整次發送不會超過 5 分鐘（Google 上限 6 分鐘）', () => {
  const { w, clock } = slowWorld(15);
  const t0 = clock.now;
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'slow10', sendAt: t0 - 1000, ig: 'IG', photos: Array.from({ length: 10 }, (_, i) => PHOTO(i)) } });
  w.ctx.tick();
  const s = status(w);
  const spent = clock.now - t0;
  assert.ok(spent <= 5 * 60e3 + 5000, `花了 ${Math.round(spent / 1000)} 秒`);
  assert.ok(s.status === 'sent' || /太久/.test(s.results.ig.msg), JSON.stringify(s.results));
});

step('DRY_RUN＋照片：完全不連 FB／IG，照片照樣刪掉', () => {
  const w = makeWorld({ ...BASE, DRY_RUN: '1' });
  const m = fakeMeta(w);
  post(w, { action: 'schedule', secret: BASE.SECRET, job: { id: 'dry', sendAt: Date.now() - 1000, fb: 'FB', fbPhotos: true, ig: 'IG', photos: [PHOTO(1)] } });
  w.ctx.tick();
  const s = status(w);
  assert.equal(s.status, 'sent');
  assert.match(s.results.ig.msg, /假裝發送/);
  assert.equal(m.st.uploads.length + m.st.feed.length + Object.keys(m.st.containers).length, 0);
  assert.ok(!w.calls.some(c => c.url.includes('graph.facebook.com')));
  assert.equal(Object.keys(w.drive.files).length, 0);
});

for (const r of results) console.log(r.join(' '));
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n郵差：${results.length - bad} 通過，${bad} 失敗`);
process.exit(bad ? 1 : 0);
