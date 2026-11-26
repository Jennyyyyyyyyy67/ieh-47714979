// 測試「郵差」（apps-script/postman.gs）。用假的 Google 服務和假的 LINE／FB，不會真的發送任何東西。
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
  let responder = () => ({ code: 200, body: '{}' });
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperties: o => { for (const [k, v] of Object.entries(o)) { assert.ok(String(v).length * 3 < 9000, `每格要小於 9KB：${k}`); store[k] = String(v); } },
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
    },
    UrlFetchApp: { fetch: (url, opt = {}) => { calls.push({ url, opt }); const r = responder(url, opt); return { getResponseCode: () => r.code, getContentText: () => r.body }; } },
    Utilities: {
      DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_a, s) => [...crypto.createHash('md5').update(s).digest()].map(b => (b > 127 ? b - 256 : b)),
      formatDate: () => '20261124',
    },
    Logger: { log() {} },
    Date, JSON, Math, String, Number, Array, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, store, triggers, calls, respond: f => { responder = f; } };
}
const post = (w, body) => JSON.parse(w.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const get = (w, params) => w.ctx.doGet({ parameter: params }).text;

const results = [];
const step = (name, fn) => { try { fn(); results.push(['✅', name]); } catch (e) { results.push(['❌', name, e.message.split('\n')[0]]); } };
const BASE = { SECRET: 's3cret-long', LINE_TOKEN: 'line-tok', FB_PAGE_ID: '123', FB_PAGE_TOKEN: 'fb-tok' };
const okLineFb = (url) => (url.includes('graph.facebook.com') ? { code: 200, body: '{"id":"123_456"}' } : { code: 200, body: '{}' });

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
  const s = post(w, { action: 'status', secret: BASE.SECRET });
  assert.equal(s.job.status, 'sent');
  assert.equal(s.job.results.fb.postId, '123_456');
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
  let s = post(w, { action: 'status', secret: BASE.SECRET }).job;
  assert.equal(s.status, 'partial');
  assert.match(s.results.fb.msg, /過期/);
  fbFail = false;
  const before = w.calls.filter(c => c.url.includes('api.line.me')).length;
  s = post(w, { action: 'retry', secret: BASE.SECRET }).job;
  assert.equal(s.status, 'sent');
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
  assert.equal(post(w, { action: 'status', secret: BASE.SECRET }).job.status, 'expired');
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
  const s = post(d, { action: 'status', secret: BASE.SECRET }).job;
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

step('檢查連線：LINE 帳號名稱、本月額度、FB 粉專名稱（不發文）', () => {
  const w = makeWorld(BASE);
  w.respond(url => {
    if (url.endsWith('/bot/info')) return { code: 200, body: '{"displayName":"測試官方帳號"}' };
    if (url.endsWith('/quota')) return { code: 200, body: '{"type":"limited","value":3000}' };
    if (url.endsWith('/consumption')) return { code: 200, body: '{"totalUsage":120}' };
    if (url.includes('followers')) return { code: 200, body: '{"status":"ready","targetedReaches":108}' };
    if (url.includes('graph.facebook.com')) return { code: 200, body: '{"name":"測試粉專","id":"123"}' };
    return { code: 404, body: '{}' };
  });
  const r = post(w, { action: 'check', secret: BASE.SECRET });
  assert.deepEqual([r.line.name, r.line.quota, r.line.used, r.line.friends, r.fb.name], ['測試官方帳號', 3000, 120, 108, '測試粉專']);
  assert.ok(!w.calls.some(c => /broadcast|push|feed/.test(c.url)), '檢查時不可以發文');
});

for (const r of results) console.log(r.join(' '));
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n郵差：${results.length - bad} 通過，${bad} 失敗`);
process.exit(bad ? 1 : 0);
