// 自動測試：用假的 Gemini 回覆，測整個流程（本機試用模式）
// 執行方式：先在專案資料夾開伺服器 `python3 -m http.server 8765`，再 `node tests/e2e.mjs`
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8765/?local=1';
const SHOTS = process.env.SHOTS || '';
const XLSX_LIB = process.env.XLSX_LIB || '';
const FAKE_ROSTER = process.env.FAKE_ROSTER || '';
import { readFileSync } from 'node:fs';
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['✅', name]); }
  catch (e) { results.push(['❌', name, e.message.split('\n')[0]]); }
};

const geminiCalls = [];
async function mockGemini(page) {
  if (XLSX_LIB) await page.route('https://cdnjs.cloudflare.com/ajax/libs/xlsx/**', r => r.fulfill({ body: readFileSync(XLSX_LIB), contentType: 'application/javascript' }));
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    const req = route.request();
    const url = req.url();
    if (url.includes('/models?')) {
      return route.fulfill({ json: { models: ['gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-pro'].map(n => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) } });
    }
    if (url.includes('/models/gemini-2.5-flash:')) {
      return route.fulfill({ status: 404, json: { error: { code: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.' } } });
    }
    const body = JSON.parse(req.postData());
    const text = body.contents[0].parts.find(p => p.text)?.text || '';
    const images = body.contents[0].parts.filter(p => p.inline_data).length;
    geminiCalls.push({ text, images, key: req.headers()['x-goog-api-key'] });
    let out;
    if (text.includes('自己出題、自己回答')) {
      const lines = [...text.matchAll(/^(S\d+)：(.*)$/gm)];
      out = { results: lines.map(([, id, ans]) => ({ id, verdict: /不知道/.test(ans) ? '錯' : '對', reason: '自出題判斷' })) };
    } else if (text.includes('請判斷每位學生這一題')) {
      const lines = [...text.matchAll(/^(S\d+)：(.*)$/gm)];
      out = { results: lines.map(([, id, ans]) => ({
        id,
        verdict: /分類/.test(ans) ? '對' : /顏色/.test(ans) ? '錯' : '部分對',
        reason: /分類/.test(ans) ? '說出分類方法' : '方向對但不完整',
      })) };
    } else if (text.includes('逐張看照片')) {
      out = { photos: [
        { index: 1, seen: '孩子們在書架前找書', highlights: ['用分類號找書'], uncertain: ['看不出是哪一區'], privacy: [] },
        { index: 2, seen: '大家在館外合照', highlights: [], uncertain: ['無'], privacy: ['可看見清楚正臉'] },
      ] };
    } else if (text.includes('週會逐字稿')) {
      // 第一次（上限 300）故意回太長；精簡那次（上限 < 300）回正常長度
      out = { letter: /一定要在 300 字以內/.test(text)
        ?'親愛的家長您好：\n\n' + '長'.repeat(320)
        : '親愛的家長您好：\n\n本週週會蓓禎老師帶領領袖們學習尊重：\n\n【成熟領袖的選擇：尊重每個人】\n小標一\n內容一\n\n小標二\n內容二\n\n讓我們一起成為祝福！\n\n【領袖挑戰：讚美行動】\n本週每天讚美一位同學。' };
    } else {
      out = {
        line_title: '城市裡的知識座標：走進高雄市總圖 🏙️📖',
        line_body: '爸爸媽媽，你知道圖書館藏著多少看世界的方式嗎？今天我們帶孩子造訪總圖！\n孩子們練習用分類號找書，也和3年2班的同學交換閱讀✨',
        home_questions: ['你今天用什麼方法找到想看的書？', '圖書館的書是怎麼分類的？'],
        fb_post: 'FB 貼文內容', ig_caption: 'IG 內容', ig_hashtags: ['戶外踏查', '#高雄市圖'],
        teaching_process: '・主題書區導覽\n・用分類號找書', class_connection: '連結到圖書分類概念',
        fact_check: [{ claim: '用分類號找書', source: '行程表' }],
      };
    }
    return route.fulfill({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] } });
  });
}

async function makeJpeg(page, w, h, color) {
  const b64 = await page.evaluate(([w, h, color]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = '200px sans-serif'; g.fillText('TEST', 100, 300);
    return c.toDataURL('image/jpeg', 0.95).split(',')[1];
  }, [w, h, color]);
  return Buffer.from(b64, 'base64');
}

async function pickRole(p, label) {
  await p.waitForSelector('text=今天要做什麼工作？');
  await p.click(`.role-card:has-text("${label}")`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('dialog', d => d.accept());
await mockGemini(page);
await page.goto(BASE);

await step('註冊老師 A 並登入', async () => {
  await page.fill('input[autocomplete=username]', 'teacherA@example.com');
  await page.fill('input[type=password]', 'secret123');
  await page.click('summary:has-text(\"第一次使用\")'); await page.click('button:has-text(\"建立這個帳號\")');
  await pickRole(page, '踏查、週會、發送');
  await page.waitForSelector('text=⚙️ 設定');
  assert.ok(await page.isVisible('text=本機試用模式'));
});

await step('密碼太短會被擋下', async () => {
  const p2 = await context.newPage();
  await p2.goto(BASE);
  // 同一個瀏覽器已登入，先登出
  if (await p2.isVisible('text=登出')) { await p2.click('text=登出'); }
  await p2.fill('input[autocomplete=username]', 'x@example.com');
  await p2.fill('input[type=password]', '123');
  await p2.click('summary:has-text(\"第一次使用\")'); await p2.click('button:has-text(\"建立這個帳號\")');
  await p2.waitForSelector('text=密碼太短');
  await p2.close();
  await page.reload();
  // 被另一頁登出了，重新登入
  if (await page.isVisible('text=老師登入')) {
    await page.fill('input[autocomplete=username]', 'teacherA@example.com');
    await page.fill('input[type=password]', 'secret123');
    await page.click('button:has-text("登入")');
  }
  await page.waitForSelector('text=⚙️ 設定');
});

await step('設定 Gemini 鑰匙並檢查', async () => {
  await page.click('.tabs >> text=⚙️ 設定');
  await page.fill('input[placeholder*="AI Studio"]', 'FAKE-KEY-123');
  await page.click('text=🔑 檢查鑰匙');
  await page.waitForSelector('text=鑰匙可以用');
  // 讓「今天」剛好是學季第 2 週（雙週：1-3 / 4-6），測試才不會因為跑的日期不同而變
  const d = new Date(); d.setDate(d.getDate() - 7);
  const startISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.fill('.card:has-text("發送時間") input[type=date]', startISO);
  await page.click('text=💾 儲存設定');
  await page.waitForSelector('text=設定已儲存');
});

await step('踏查：沒勾肖像同意前不能選照片', async () => {
  await page.click('.tabs >> text=🚌 踏查');
  assert.ok(await page.isDisabled('text=📷 選擇照片'));
});

let resized;
await step('踏查：照片上傳前自動縮小（4000x3000 → 長邊 1280）', async () => {
  await page.fill('input[placeholder*="高雄市立圖書館"]', '高雄市立圖書館總館');
  await page.fill('textarea[placeholder*="行程表、學習單的文字"]', '09:30 主題書區導覽\n10:30 用分類號找書、交換閱讀');
  await page.check('text=我確認：要上傳的照片裡');
  const big = await makeJpeg(page, 4000, 3000, '#2a6');
  const small = await makeJpeg(page, 800, 600, '#a62');
  await page.setInputFiles('input[type=file][accept="image/*"]', [
    { name: 'a.jpg', mimeType: 'image/jpeg', buffer: big },
    { name: 'b.jpg', mimeType: 'image/jpeg', buffer: small },
  ]);
  await page.waitForSelector('.photo >> nth=1');
  resized = await page.$$eval('.photo img', imgs => imgs.map(i => [i.naturalWidth, i.naturalHeight]));
  assert.deepEqual(resized[0], [1280, 960]);
  assert.deepEqual(resized[1], [800, 600]);
});

await step('踏查：照片沒核對前不能產生文案', async () => {
  assert.ok(await page.isDisabled('text=✨ 產生文案'));
});

await step('踏查：AI 列出每張照片看到什麼／不確定的地方／個資提醒', async () => {
  await page.click('text=🔍 請 AI 看照片');
  await page.waitForSelector('text=照片 2', { state: 'visible' });
  await page.waitForSelector('text=個資提醒：可看見清楚正臉');
  const vals = await page.locator('.review textarea').evaluateAll(els => els.map(e => e.value));
  assert.ok(vals.includes('孩子們在書架前找書'), '看到了什麼');
  assert.ok(vals.includes('看不出是哪一區'), '不確定的地方');
  const last = geminiCalls.at(-1);
  assert.equal(last.images, 2, '應該送出 2 張照片');
  assert.equal(last.key, 'FAKE-KEY-123');
  assert.ok(last.text.includes('不可以辨認'), '提示詞要包含不可認人');
});

await step('踏查：老師核對後打勾才解鎖', async () => {
  await page.locator('.review textarea').first().fill('孩子們在書架前用分類號找書');
  await page.check('text=我已經核對過每張照片的描述');
  assert.ok(!(await page.isDisabled('text=✨ 產生文案')));
});

await step('踏查：問卷連結＋自動問卷標題', async () => {
  await page.fill('input[type=url] >> nth=0', 'https://forms.gle/AAA');
  await page.fill('input[type=url] >> nth=1', 'https://forms.gle/BBB');
  const titles = await page.textContent('.bubble');
  assert.ok(/戶外踏查小小孩問卷_高雄市立圖書館總館/.test(titles));
  assert.ok(/^\d{3}\/\d{1,2}\/\d{1,2}戶外踏查小小孩問卷_/.test(titles), titles);
});

await step('踏查：產生四種版本＋問卷題目', async () => {
  await page.click('text=✨ 產生文案');
  await page.waitForSelector('text=📝 教學紀錄', { timeout: 10000 });
  const last = geminiCalls.at(-1);
  assert.ok(!last.text.includes('學習主題庫'), '不再使用學習主題庫');
  assert.ok(last.text.includes('孩子們在書架前用分類號找書'), '提示詞用老師核對過的描述');
});

const outText = async (title) => page.locator('.output-block', { hasText: title }).locator('textarea').inputValue();

await step('LINE 版：照範本格式、附問卷連結和 12 點提醒', async () => {
  const t = await outText('家長群組溫馨回顧');
  assert.ok(t.startsWith('【戶外踏查】\n城市裡的知識座標'), t);
  assert.ok(t.includes('小小孩問卷（1-3年級）：\nhttps://forms.gle/AAA'), t);
  assert.ok(t.includes('大孩子問卷（4-6年級）：\nhttps://forms.gle/BBB'), t);
  assert.ok(t.trim().endsWith('✨✨請提醒孩子們今天晚上12點前要送出問卷喔！'));
  assert.ok(!t.includes('回家可以問問孩子'), '預設回家問題不放 LINE');
});

await step('問卷區塊：有標題和回家可以問孩子的問題', async () => {
  const t = await outText('問卷標題＋題目');
  assert.ok(t.includes('戶外踏查大孩子問卷_高雄市立圖書館總館'));
  assert.ok(t.includes('1. 你今天用什麼方法找到想看的書？'));
});

await step('IG：hashtag 有 # 而且不重複 #', async () => {
  const t = await outText('Instagram 貼文');
  assert.ok(t.includes('#戶外踏查 #高雄市圖'));
});

await step('教學紀錄：有日期地點、學習重點、活動過程，教學省思留空', async () => {
  const t = await outText('📝 教學紀錄');
  assert.ok(t.includes('地點：高雄市立圖書館總館'));
  assert.ok(t.includes('學習重點：連結到圖書分類概念'));
  assert.ok(t.includes('・用分類號找書'));
  assert.ok(/教學省思：\s*$/.test(t), '教學省思後面要是空的');
});

await step('個資檢查：抓到「3年2班」', async () => {
  const blk = page.locator('.output-block', { hasText: '家長群組溫馨回顧' });
  await blk.locator('text=像是班級').waitFor();
});

await step('個資檢查：輸入學生名字（不儲存）也會抓', async () => {
  const blk = page.locator('.output-block', { hasText: 'Facebook 貼文' });
  await blk.locator('textarea').fill('今天王小明表現很好');
  await page.fill('input[placeholder*="王小明"]', '王小明');
  await blk.locator('text=出現了你輸入的學生名字').waitFor();
  await blk.locator('textarea').fill('FB 貼文內容');
});

await step('檢查清單：沒全勾前 LINE/FB/IG 不能複製，教學紀錄可以', async () => {
  const lineBtn = page.locator('.output-block', { hasText: '家長群組溫馨回顧' }).locator('button:has-text("一鍵複製")');
  const recBtn = page.locator('.output-block', { hasText: '📝 教學紀錄' }).locator('button:has-text("一鍵複製")');
  assert.ok(await lineBtn.isDisabled());
  assert.ok(!(await recBtn.isDisabled()));
  const boxes = page.locator('.checklist input[type=checkbox]');
  for (let i = 0; i < 3; i++) await boxes.nth(i).check();
  assert.ok(await lineBtn.isDisabled(), '只勾 3 項還不能複製');
  await boxes.nth(3).check();
  assert.ok(!(await lineBtn.isDisabled()));
});

await step('一鍵複製：剪貼簿真的拿到文字', async () => {
  await page.locator('.output-block', { hasText: '家長群組溫馨回顧' }).locator('button:has-text("一鍵複製")').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(clip.startsWith('【戶外踏查】'));
});

await step('照片不會被存進資料庫', async () => {
  const dump = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))));
  assert.ok(dump.includes('高雄市立圖書館總館'), '踏查文字有存');
  assert.ok(!dump.includes('data:image'), '不能有照片');
  assert.ok(!dump.includes('base64'), '不能有照片 base64');
  assert.ok(!dump.includes('王小明'), '檢查用的學生名字不能存');
});

if (SHOTS) {
  await page.screenshot({ path: `${SHOTS}/desktop-trip.png`, fullPage: true });
}

await step('週會：超過 300 字會自動再精簡一次', async () => {
  await page.click('.tabs >> text=⛪ 週會');
  await page.fill('textarea[placeholder*="逐字稿"]', '今天我們要談尊重。'.repeat(20));
  const before = geminiCalls.length;
  await page.click('text=✨ 整理成家長信');
  await page.waitForSelector('text=💌 週會家長信');
  const t = await outText('週會家長信');
  assert.ok(t.startsWith('親愛的家長您好'));
  assert.ok(t.includes('【領袖挑戰'));
  assert.equal(geminiCalls.length - before, 2, '應該呼叫兩次（第二次精簡）');
  const counter = await page.locator('.output-block .counter').textContent();
  assert.ok(/\/ 300 字/.test(counter));
  assert.ok(!(await page.locator('.output-block .counter').getAttribute('class')).includes('over'));
});

await step('本週發送：順序是 週會 → 踏查 → 照片，有後台連結', async () => {
  await page.click('.tabs >> text=📤 本週發送');
  const titles = await page.locator('.output-block h3').allTextContents();
  assert.ok(titles[0].includes('週會'));
  assert.ok(titles[1].includes('踏查'));
  assert.ok(titles[2].includes('照片'));
  assert.ok(await page.isVisible('a[href="https://manager.line.biz/"]'));
  assert.ok(await page.isVisible('a[href="https://business.facebook.com/latest/home"]'));
  assert.ok(await page.isDisabled('text=📋 依順序全部複製'));
});

await step('紀錄：可以重新打開舊的踏查', async () => {
  await page.click('.tabs >> text=🗂️ 紀錄');
  await page.locator('.list-item', { hasText: '高雄市立圖書館總館' }).locator('text=打開').click();
  await page.waitForSelector('text=正在編輯');
  assert.equal(await page.inputValue('input[placeholder*="高雄市立圖書館"]'), '高雄市立圖書館總館');
});

await step('本週發送：顯示每週二 17:00 發送時間', async () => {
  await page.click('.tabs >> text=📤 本週發送');
  const t = await page.textContent('.schedule');
  assert.ok(/本週發送時間：\d+\/\d+（二）17:00/.test(t), t);
});

await step('問卷檢查：找出未交、遲交、重複、打錯字，並批改答案', async () => {
  await page.click('.tabs >> text=📊 問卷檢查');
  await page.fill('input[type=date]', '2026-11-17');
  await page.fill('textarea', '3年級,王小明\n3年級,陳小華\n4年級,林大同');
  const csv = '時間戳記,分數,你的名字,圖書館的書用什麼分類？,你最喜歡哪一區？\n'
    + '2026/11/17 下午 8:05:12,1 / 1,王小明,中國圖書分類法,兒童區\n'
    + '2026/11/18 上午 12:30:00,0 / 1,陳 小華,依顏色,漫畫區\n'
    + '2026/11/17 下午 9:00:00,1 / 1,王小明,中國圖書分類法,兒童區\n'
    + '2026/11/17 下午 9:10:00,1 / 1,林大童,中國圖書分類法,期刊區\n';
  await page.setInputFiles('input[type=file][accept*=csv]', { name: '3-8年級.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + csv) });
  await page.waitForSelector('text=共 4 筆回覆');
  const sum = await page.textContent('.bubble');
  assert.ok(sum.includes('未交（1）') && sum.includes('・4年級：林大同'), sum);
  assert.ok(sum.includes('遲交（1）：陳 小華'), sum);
  assert.ok(await page.isVisible('text=交了 2 次'));
  assert.ok(await page.isVisible('text=林大童'));
  assert.ok(await page.isVisible('text=名字對不到名單'));
  assert.ok(await page.isVisible('td:has-text("表單：1/1")'));
  // 自己設定正確答案
  await page.click('text=設定正確答案');
  await page.fill('input[placeholder*="正確答案"] >> nth=0', '中國圖書分類法');
  await page.press('input[placeholder*="正確答案"] >> nth=0', 'Tab');
  await page.waitForSelector('td:has-text("批改：0/1")');
  await page.waitForSelector('text=2/3（67%）');
  const dump = await page.evaluate(() => JSON.stringify(localStorage));
  assert.ok(!dump.includes('林大同') && !dump.includes('陳小華'), '名單不能被儲存');
});

await step('名單：上傳 Excel（姓名／年級／班別、有空白列、班別前有空格）', async () => {
  if (!FAKE_ROSTER) throw new Error('沒有提供測試用名單檔');
  await page.setInputFiles('input[type=file][accept*=xlsx][accept*=txt]', FAKE_ROSTER);
  await page.waitForSelector('text=讀到 4 位學生');
  const info = await page.textContent('text=讀到 4 位學生');
  assert.ok(info.includes('快樂兔 2 人') && info.includes('智慧鹿 1 人') && info.includes('勇氣虎 1 人'), info);
  assert.ok(info.includes('還沒記住'));
  const sum = await page.textContent('.bubble');
  assert.ok(sum.includes('未交（4）'), sum);
  assert.ok(sum.includes('・1年級 快樂兔：測試甲、測試乙'), sum);
  assert.ok(sum.includes('・3年級 智慧鹿：測試丙'), sum);
});

await step('名單：貼上「姓名 年級 班別」格式也讀得對（名字不會變成班別）', async () => {
  await page.fill('textarea', '姓名\t年級\t班別\n測試戊\t2\t恩典鷹');
  const info = await page.textContent('text=讀到 1 位學生');
  assert.ok(info.includes('恩典鷹 1 人'), info);
  const sum = await page.textContent('.bubble');
  assert.ok(sum.includes('・2年級 恩典鷹：測試戊'), sum);
});

await step('名單：按「記住」後重新整理會自動載入；按「清除」就不見', async () => {
  await page.setInputFiles('input[type=file][accept*=xlsx][accept*=txt]', FAKE_ROSTER);
  await page.waitForSelector('text=讀到 4 位學生');
  await page.click('text=💾 記住這份名單');
  await page.waitForSelector('text=✅ 已記住');
  await page.reload();
  await page.click('.tabs >> text=📊 問卷檢查');
  await page.waitForSelector('text=讀到 4 位學生');
  assert.ok(await page.isVisible('text=✅ 已記住'));
  await page.click('text=🗑️ 清除記住的名單');
  await page.waitForSelector('text=已清除記住的名單');
  await page.reload();
  await page.click('.tabs >> text=📊 問卷檢查');
  assert.equal(await page.inputValue('textarea'), '');
  const dump = await page.evaluate(() => JSON.stringify(localStorage));
  assert.ok(!dump.includes('測試甲'), '清除後不能還留著名單');
});

await step('設定：可以改保留天數和發送時間', async () => {
  await page.click('.tabs >> text=⚙️ 設定');
  assert.equal(await page.inputValue('input[type=time]'), '17:00');
  await page.selectOption('select >> nth=1', '14');
  await page.click('text=💾 儲存設定');
  await page.waitForSelector('text=設定已儲存');
  await page.selectOption('select >> nth=1', '7');
  await page.click('text=💾 儲存設定');
});

await step('清容量：超過 7 天的紀錄登入時自動刪除，新的保留', async () => {
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('tripapp:v1:session'));
    const k = `tripapp:v1:data:${s.uid}:trips`;
    const items = JSON.parse(localStorage.getItem(k) || '[]');
    items.push({ id: 'old1', date: '2026-11-01', place: '很久以前的美術館', createdAt: Date.now() - 8 * 86400000, updatedAt: Date.now() - 8 * 86400000 });
    localStorage.setItem(k, JSON.stringify(items));
  });
  await page.reload();
  await page.waitForSelector('text=已自動清除 1 筆');
  await page.click('.tabs >> text=🗂️ 紀錄');
  assert.ok(!(await page.isVisible('text=很久以前的美術館')));
  assert.ok(await page.isVisible('text=高雄市立圖書館總館'));
  assert.ok(await page.isVisible('text=自動刪除）'));
});

await step('模型下架：檢查鑰匙時自動換成最新的 flash', async () => {
  await page.click('.tabs >> text=⚙️ 設定');
  await page.fill('input[list=modelList]', 'gemini-2.5-flash');
  await page.click('text=🔑 檢查鑰匙');
  await page.waitForSelector('text=已自動換成「gemini-3.8-flash」');
  assert.equal(await page.inputValue('input[list=modelList]'), 'gemini-3.8-flash');
});

await step('模型下架：產生文案時自動改用 Google 建議的新模型並存起來', async () => {
  await page.fill('input[list=modelList]', 'gemini-2.5-flash');
  await page.click('text=💾 儲存設定');
  await page.waitForSelector('text=設定已儲存');
  await page.click('.tabs >> text=⛪ 週會');
  await page.fill('textarea[placeholder*="逐字稿"]', '今天我們要談尊重。'.repeat(20));
  await page.click('text=✨ 整理成家長信');
  await page.waitForSelector('text=💌 週會家長信');
  await page.click('.tabs >> text=⚙️ 設定');
  assert.equal(await page.inputValue('input[list=modelList]'), 'gemini-3.8-flash');
});

await step('共用帳號：按「切換工作」改成批改 1-2 年級，只看到答案批改', async () => {
  await page.click('text=🔄 切換工作');
  await pickRole(page, '批改小小孩問卷');
  await page.waitForSelector('h1:has-text("📝 小小孩問卷答案批改")');
  assert.deepEqual(await page.locator('.tabs button').allTextContents(), ['📝 答案批改', '📋 本週名單']);
  assert.ok(await page.isVisible('#who >> text=批改小小孩問卷'));
  assert.ok(!(await page.isVisible('text=還沒設定 AI 鑰匙')), '同一個帳號，鑰匙已經有了');
});

await step('共用帳號：同一台電腦開新分頁，不用再登入，但要重新選工作', async () => {
  const p3 = await context.newPage();
  await p3.goto(BASE);
  await p3.waitForSelector('text=今天要做什麼工作？');
  assert.ok(!(await p3.isVisible('text=老師登入')), '不用再登入');
  await p3.close();
});

await step('批改老師：AI 批改簡答題（不送學生名字）、可略過感想題、可點符號改判', async () => {
  await page.waitForSelector('h1:has-text("📝 小小孩問卷答案批改")');
  assert.ok(!(await page.isVisible('text=學生名單（用來找出誰沒交）')), '批改老師不用貼名單');
  assert.ok(!(await page.textContent('main')).includes('null'), '畫面不能出現 null');
  const csv = '時間戳記,你的名字,圖書館的書是怎麼排的？,今天最喜歡什麼？\n'
    + '2026/11/17 下午 5:05:00,小美同學,用分類號排,看繪本\n'
    + '2026/11/17 下午 5:06:00,小明同學,依顏色排,交換書\n'
    + '2026/11/17 下午 5:07:00,小華同學,照大小,看繪本\n';
  await page.setInputFiles('input[type=file][accept*=csv]', { name: '小小孩問卷（1-3年級）.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForSelector('text=共 3 筆回覆');
  // 沒有表單分數時，「設定正確答案」本來就是打開的
  assert.ok(await page.isVisible('label:has-text("這題不批改") >> nth=1'));
  await page.click('label:has-text("這題不批改") >> nth=1');
  assert.ok(await page.isChecked('label:has-text("這題不批改") >> nth=1 >> input'));
  const before = geminiCalls.length;
  await page.click('button:has-text("🤖 用 AI 批改")');
  await page.waitForSelector('text=AI 批改完成');
  const calls = geminiCalls.slice(before);
  assert.equal(calls.length, 1, '只批改沒被略過的那一題');
  assert.ok(calls[0].text.includes('S1：用分類號排'));
  assert.ok(!/小美|小明|小華/.test(calls[0].text), 'AI 不能看到學生名字');
  assert.ok(calls[0].text.includes('小小孩（低年級）'));
  assert.equal(calls[0].key, 'FAKE-KEY-123', '用的是共用帳號的鑰匙');
  const row = name => page.locator('tr', { hasText: name });
  assert.ok((await row('小美同學').textContent()).includes('①✅'));
  assert.ok((await row('小明同學').textContent()).includes('①❌'));
  assert.ok((await row('小華同學').textContent()).includes('①🟡'));
  assert.ok(!(await row('小美同學').textContent()).includes('②'), '感想題不批改');
  const sum = await page.textContent('.bubble');
  assert.ok(sum.includes('1/3 答對'), sum);
  assert.ok(sum.includes('答對不到六成的學生（2）'), sum);
  // 老師覺得小華其實答對了：點一下 🟡 → ❌，再點 → ✅
  await row('小華同學').locator('button.mark').click();
  await row('小華同學').locator('button.mark').click();
  assert.ok((await row('小華同學').textContent()).includes('①✅'));
  assert.ok((await page.textContent('.bubble')).includes('2/3 答對'));
});

await step('本週名單：1-2年級老師存全對名單', async () => {
  await page.waitForSelector('text=⭐ 全對的學生（2 人）');
  assert.equal(await page.inputValue('select >> nth=-1'), '小小孩', '從檔名自動判斷是小小孩');
  await page.click('text=💾 把全對名單存進本週名單');
  await page.waitForSelector('text=已存進本週名單：小小孩全對 2 人');
});

await step('本週名單：切換成 3-8年級老師，上一位的檔案不見了；批改後存全對名單', async () => {
  await page.click('text=🔄 切換工作');
  await pickRole(page, '批改大孩子問卷');
  await page.waitForSelector('h1:has-text("📝 大孩子問卷答案批改")');
  assert.ok(!(await page.isVisible('text=小美同學')), '切換工作後不能看到上一位老師的回覆');
  const csv = '時間戳記,請問你的班級是?,請問你的姓名是?,書怎麼排？,8. 自行編題(問+答)\n2026/11/17 下午 6:00:00,勇氣虎,大明同學,用分類號,不知道\n2026/11/17 下午 6:01:00,恩典鷹,大華同學,依顏色,問：書用什麼排？答：分類號\n';
  await page.setInputFiles('input[type=file][accept*=csv]', { name: '大孩子問卷（4-6年級）.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  // 「請自己出一題並回答」會自動被判斷成「學生自出題」
  assert.equal(await page.inputValue('select:has(option[value=self]) >> nth=1'), 'self');
  const before = geminiCalls.length;
  await page.click('button:has-text("🤖 用 AI 批改")');
  await page.waitForSelector('text=⭐ 老師出題全對（1 人）');
  assert.ok(geminiCalls.slice(before).some(c => c.text.includes('自己出題、自己回答')), '自出題用專用的批改規則');
  assert.ok(await page.isVisible('text=⭐ 自出題全對（1 人）'));
  await page.click('text=💾 把全對名單存進本週名單');
  await page.waitForSelector('text=已存進本週名單：老師出題全對 1 人、自出題全對 1 人');
});

await step('本週名單：主要老師存未填名單，三份自動合併成一份', async () => {
  await page.click('text=🔄 切換工作');
  await pickRole(page, '踏查、週會、發送');
  await page.click('.tabs >> text=📊 問卷檢查');
  await page.fill('textarea', '姓名\t年級\t班別\n小美同學\t1\t快樂兔\n小明同學\t2\t智慧鹿\n小華同學\t1\t快樂兔\n大明同學\t5\t勇氣虎\n大華同學\t7\t恩典鷹\n沒交甲\t1\t快樂兔\n沒交乙\t6\t忠心象');
  const csv12 = '時間戳記,你的名字,題\n2026/11/17 下午 5:05:00,小美同學,a\n2026/11/17 下午 5:06:00,小明同學,a\n2026/11/17 下午 5:07:00,小華同學,a\n';
  const csv38 = '時間戳記,你的名字,題\n2026/11/17 下午 6:00:00,大明同學,a\n2026/11/17 下午 6:01:00,大華同學,a\n';
  await page.setInputFiles('input[type=file][accept*=csv]', [
    { name: '1-2年級問卷.csv', mimeType: 'text/csv', buffer: Buffer.from(csv12) },
    { name: '3-8年級問卷.csv', mimeType: 'text/csv', buffer: Buffer.from(csv38) },
  ]);
  await page.waitForSelector('text=未交（2）');
  await page.click('text=💾 把未填名單存進本週名單');
  await page.waitForSelector('text=已存進本週名單：未填問卷 2 人');
  await page.click('.tabs >> text=📋 本週名單');
  await page.waitForSelector('text=🎉 全部都完成了');
  const text = await page.textContent('.bubble');
  const want = [
    '未填問卷：（補填問卷、抄未完成作業箴言3次/一年級1次）\n1年級 快樂兔：沒交甲\n6年級 忠心象：沒交乙',
    '大孩子老師出題全對：（5元心幣）\n大明同學',
    '大孩子自出題全對：（5元心幣）\n大華同學',
    '小小孩全對：（10元心幣）\n小美同學、小華同學',
  ];
  let at = -1;
  for (const w of want) { const i = text.indexOf(w); assert.ok(i > at, `順序或內容不對：${w}\n---\n${text}`); at = i; }
});

await step('名單格式：可以在設定改獎勵文字', async () => {
  await page.click('.tabs >> text=⚙️ 設定');
  const note = page.locator('.card:has-text("本週名單的格式") input >> nth=7');
  assert.equal(await note.inputValue(), '10元心幣');
  await note.fill('20元心幣');
  await page.click('text=💾 儲存設定');
  await page.waitForSelector('text=設定已儲存');
  await page.click('.tabs >> text=📋 本週名單');
  assert.ok((await page.textContent('.bubble')).includes('小小孩全對：（20元心幣）'));
});

await step('學季週次：設定第一週日期後，踏查自動填年級範圍；手動改過的不被蓋掉', async () => {
  await page.click('.tabs >> text=⚙️ 設定');
  await page.fill('.card:has-text("發送時間") input[type=date]', '2026-09-28');
  await page.click('text=💾 儲存設定');
  await page.waitForSelector('text=設定已儲存');
  await page.click('.tabs >> text=🚌 踏查');
  await page.click('text=🆕 開始新的一次');
  const setDate = async d => { await page.fill('input[type=date] >> nth=0', d); await page.dispatchEvent('input[type=date] >> nth=0', 'change'); };
  const ranges = async () => [await page.inputValue('input[placeholder="例如：1-3"]'), await page.inputValue('input[placeholder="例如：4-6"]')];
  const cases = [['2026-09-29', 1, ['1-2', '3-8']], ['2026-10-06', 2, ['1-3', '4-6']], ['2026-10-13', 3, ['1-3', '4-8']], ['2026-10-27', 5, ['1-2', '3-8']], ['2026-11-24', 9, ['1-2', '3-8']], ['2026-12-01', 10, ['1-3', '4-6']]];
  for (const [d, n, want] of cases) {
    await setDate(d);
    assert.deepEqual(await ranges(), want, `${d} 第${n}週`);
    assert.ok((await page.textContent('text=這是學季第')).includes(`第 ${n} 週`));
  }
  await page.fill('input[placeholder="例如：1-3"]', '1-4');
  await page.fill('input[placeholder="例如：4-6"]', '5-8');
  await page.click('label:has-text("小小孩問卷連結")');
  assert.deepEqual(await ranges(), ['1-4', '5-8'], '手動改的要保留');
  await setDate('2026-12-08');
  assert.ok((await page.textContent('main')).includes('不在這個學季的 1～10 週內'));
});

await step('踏查地點：新增、一次貼上、搜尋（打名字知道什麼時候去過）', async () => {
  // 開學日是 11/16：先把學季第一週設成它（這樣第 1 週就是 11/17）
  await page.click('.tabs >> text=⚙️ 設定');
  await page.fill('.card:has-text("發送時間") input[type=date]', '2026-11-16');
  await page.click('text=💾 儲存設定');
  await page.waitForSelector('text=設定已儲存');
  await page.click('.tabs >> text=📍 踏查地點');
  await page.waitForSelector('h1:has-text("📍 踏查地點")');
  assert.ok((await page.textContent('main')).includes('每週二 13:30 出發、16:00 回到青埔'));
  await page.fill('input[placeholder*="台灣滷味博物館"]', '台灣滷味博物館');
  await page.fill('input[placeholder*="去過的日期"]', '115/9/29');
  await page.click('button:has-text("儲存")');
  await page.waitForSelector('.topic >> text=台灣滷味博物館');
  await page.fill('textarea[placeholder*="一行一個，用逗號分開"]', [
    '地點,室內或室外,日期', '高雄市立總圖,室內,115/8/4;115/3/10', '愛河河堤,室外,115/7/7', '植物園,室內外', '消防局,室內', '美術館,室內,115/5/5',
    '城市公園,室外', '海邊步道,室外,114/11/4', '科學工藝博物館,室內', '警察局,室內,115/6/2', '亂寫的,不知道',
  ].join('\n'));
  await page.click('text=加入這些地點');
  await page.waitForSelector('text=新增 9 個');
  assert.ok(await page.isVisible('text=請寫「室內」「室外」或「室內外」'), '看不懂的那行要提醒');
  assert.ok(await page.isVisible('text=共 11 個地點'));
  await page.fill('input[placeholder*="打地點名稱"]', '總圖');
  const card = await page.textContent('.topic');
  assert.ok(card.includes('高雄市立總圖') && card.includes('去過 2 次，最近一次 115/08/04'), card);
  assert.equal(await page.locator('.topic').count(), 1);
  assert.ok(!(await page.textContent('main')).includes('地點庫裡沒有「總圖」'), '找得到相近的，就不能說「沒有」');
  await page.fill('input[placeholder*="打地點名稱"]', '臺灣滷味　博物館');
  assert.ok((await page.textContent('.topic')).includes('台灣滷味博物館'), '台／臺、空白都要能找到');
  await page.fill('input[placeholder*="打地點名稱"]', '沒這個地方');
  await page.waitForSelector('text=地點庫裡沒有「沒這個地方」');
  await page.fill('input[placeholder*="打地點名稱"]', '');
});

await step('踏查地點：自動排 10 週，晴天不重複、雨天一定是室內', async () => {
  await page.click('text=🗓️ 自動排 10 週');
  await page.waitForSelector('text=第 10 週');
  assert.equal(await page.locator('.plan-row select').count(), 30);
  const rows = await page.$$eval('.plan-row', els => els.map(e => [...e.querySelectorAll('select')].slice(0, 2).map(s => s.selectedOptions[0].textContent)));
  assert.equal(rows.length, 10);
  const sunny = rows.map(r => r[0]);
  assert.equal(new Set(sunny).size, 10, '晴天地點不重複：' + sunny);
  for (const r of rows) assert.ok(!r[1].startsWith('🌳') && !r[1].includes('（空）'), '雨天備案不能是室外或空的：' + r[1]);
  assert.ok((await page.textContent('main')).includes('115/11/17（二）'), '第 1 週是 11/17');
  assert.ok((await page.textContent('main')).includes('116/01/19（二）'), '第 10 週是 1/19');
});

await step('踏查地點：每週的地點可以自己改，重新整理還在', async () => {
  const sel = page.locator('.plan-row').first().locator('select').first();
  await sel.selectOption({ label: '🏠 警察局' });
  await page.reload();
  await page.click('.tabs >> text=📍 踏查地點');
  await page.waitForSelector('text=第 10 週');
  assert.equal(await page.locator('.plan-row').first().locator('select').first().evaluate(s => s.selectedOptions[0].textContent), '🏠 警察局');
});

await step('踏查：行程表自動帶入 13:30 出發／16:00 回青埔；打地點顯示去過；產生後自動記一次', async () => {
  await page.click('.tabs >> text=🚌 踏查');
  await page.click('text=🆕 開始新的一次');
  assert.equal(await page.inputValue('textarea[placeholder*="行程表、學習單的文字"]'), '13:30 從青埔出發\n16:00 回到青埔');
  await page.fill('input[placeholder*="高雄市立圖書館"]', '高雄市立總圖');
  await page.waitForSelector('text=去過 2 次，最近一次 115/08/04');
  assert.ok((await page.textContent('main')).includes('🏠 室內'));
  // 計畫裡有這一天的話，會出現快速填入按鈕
  await page.fill('input[type=date] >> nth=0', '2026-11-17');
  await page.dispatchEvent('input[type=date] >> nth=0', 'change');
  await page.waitForSelector('text=本週計畫：');
  assert.ok(await page.isVisible('button:has-text("☀️ 天晴")'));
  await page.click('button:has-text("☀️ 天晴")');
  assert.equal(await page.inputValue('input[placeholder*="高雄市立圖書館"]'), '警察局');
  // 一個地點庫裡沒有的新地點
  await page.fill('input[placeholder*="高雄市立圖書館"]', '全新的博物館');
  await page.waitForSelector('text=還不在地點庫裡');
  await page.fill('textarea[placeholder*="行程表、學習單的文字"]', '13:30 從青埔出發\n14:00 參觀\n16:00 回到青埔');
  await page.click('button:has-text("✨ 產生文案")');
  await page.waitForSelector('text=📝 教學紀錄');
  await page.click('.tabs >> text=📍 踏查地點');
  await page.fill('input[placeholder*="打地點名稱"]', '全新的博物館');
  await page.waitForSelector('.topic:has-text("全新的博物館")');
  const c = await page.textContent('.topic');
  assert.ok(c.includes('去過 1 次，最近一次 115/11/17'), c);
  assert.ok(c.includes('請確認室內／室外'), '自動加入的新地點要請老師確認室內外');
  // 同一個地點同一天不會重複記
  await page.fill('input[placeholder*="打地點名稱"]', '');
});

await step('前一週決定：選晴天或雨天＋勾已預約，踏查頁當天自動填好地點', async () => {
  await page.click('.tabs >> text=📍 踏查地點');
  await page.waitForSelector('.plan-row');
  // 第 2 週（11/24）：決定下雨，先不預約 → 提醒
  const row2 = page.locator('.plan-row').nth(1);
  const rainyName = await row2.locator('select').nth(1).evaluate(sel => sel.selectedOptions[0].textContent.replace(/^\S+\s/, ''));
  await row2.locator('select').nth(2).selectOption('rainy');
  await page.waitForSelector(`.plan-row >> nth=1 >> text=決定去：${rainyName}`);
  assert.ok((await page.locator('.plan-row').nth(1).textContent()).includes('還沒標記已預約'));
  await page.locator('.plan-row').nth(1).locator('input[type=checkbox]').check();
  await page.waitForSelector('.plan-row >> nth=1 >> text=✅ 已預約');
  // 踏查頁：選 11/24，地點自動填好
  await page.click('.tabs >> text=🚌 踏查');
  await page.click('text=🆕 開始新的一次');
  await page.fill('input[type=date] >> nth=0', '2026-11-24');
  await page.dispatchEvent('input[type=date] >> nth=0', 'change');
  await page.waitForSelector('text=前一週已決定：☔ 下雨去');
  assert.equal(await page.inputValue('input[placeholder*="高雄市立圖書館"]'), rainyName);
  assert.ok((await page.textContent('main')).includes('✅ 已預約'));
  // 老師自己改的地點，換日期時不會被硬蓋
  await page.fill('input[placeholder*="高雄市立圖書館"]', '老師自己打的地點');
  await page.fill('input[type=date] >> nth=0', '2026-12-01');
  await page.dispatchEvent('input[type=date] >> nth=0', 'change');
  assert.equal(await page.inputValue('input[placeholder*="高雄市立圖書館"]'), '老師自己打的地點');
});

await step('不同老師的資料分開', async () => {
  await page.click('text=登出');
  await page.fill('input[autocomplete=username]', 'teacherB@example.com');
  await page.fill('input[type=password]', 'secret456');
  await page.click('summary:has-text(\"第一次使用\")'); await page.click('button:has-text(\"建立這個帳號\")');
  await pickRole(page, '踏查、週會、發送');
  await page.waitForSelector('text=⚙️ 設定');
  await page.click('.tabs >> text=🗂️ 紀錄');
  await page.waitForSelector('text=🚌 踏查（0）');
  assert.ok(!(await page.isVisible('.tabs >> text=學習主題庫')), '學習主題庫已移除');
  await page.click('text=登出');
  await page.fill('input[autocomplete=username]', 'teacherA@example.com');
  await page.fill('input[type=password]', 'wrongpass');
  await page.click('button:has-text("登入")');
  await page.waitForSelector('text=帳號或密碼錯誤');
});

await step('帳號：只打 teacher 就能註冊與登入（不用 Email、大小寫與空白不影響）', async () => {
  const p = await context.newPage();
  await p.goto(BASE);
  if (await p.isVisible('text=登出')) { await p.click('text=登出'); }
  await p.fill('input[autocomplete=username]', 'teacher');
  await p.fill('input[type=password]', 'Fake-Pass-9876');
  await p.click('summary:has-text("第一次使用")'); await p.click('button:has-text("建立這個帳號")');
  await pickRole(p, '踏查、週會、發送');
  await p.waitForSelector('text=⚙️ 設定');
  await p.click('text=登出');
  // 大小寫、前後空白都沒關係
  await p.fill('input[autocomplete=username]', '  Teacher ');
  await p.fill('input[type=password]', 'Fake-Pass-9876');
  await p.click('button:has-text("登入")');
  await p.waitForSelector('text=今天要做什麼工作？');
  await p.click('text=登出');
  // 密碼打錯
  await p.fill('input[autocomplete=username]', 'teacher');
  await p.fill('input[type=password]', 'wrong-pass');
  await p.click('button:has-text("登入")');
  await p.waitForSelector('text=帳號或密碼錯誤');
  // 不能重複註冊
  await p.click('summary:has-text("第一次使用")'); await p.click('button:has-text("建立這個帳號")');
  await p.waitForSelector('text=已經註冊過了');
  // 沒打帳號
  await p.fill('input[autocomplete=username]', '');
  await p.click('button:has-text("登入")');
  await p.waitForSelector('text=請輸入帳號');
  assert.ok(!(await p.textContent('main')).includes('Email'), '登入畫面不能再出現 Email 這個字');
  await p.close();
});

// 手機畫面
const mobile = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mp = await mobile.newPage();
mp.on('pageerror', e => pageErrors.push(e.message));
await step('手機畫面：沒有左右捲動', async () => {
  await mp.goto(BASE);
  await mp.fill('input[autocomplete=username]', 'm@example.com');
  await mp.fill('input[type=password]', 'secret789');
  await mp.click('summary:has-text(\"第一次使用\")'); await mp.click('button:has-text(\"建立這個帳號\")');
  await pickRole(mp, '踏查、週會、發送');
  await mp.waitForSelector('text=⚙️ 設定');
  for (const tab of ['🚌 踏查', '⛪ 週會', '📤 本週發送', '📍 踏查地點', '📊 問卷檢查', '📋 本週名單', '🗂️ 紀錄', '⚙️ 設定']) {
    await mp.click(`.tabs >> text=${tab}`);
    await mp.waitForTimeout(150);
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${tab} 有左右捲動 ${overflow}px`);
    assert.ok(!/null|undefined/.test(await mp.textContent('main')), `${tab} 畫面出現 null/undefined`);
  }
  if (SHOTS) {
    await mp.click('.tabs >> text=🚌 踏查');
    await mp.screenshot({ path: `${SHOTS}/mobile-trip.png`, fullPage: false });
  }
});

await step('沒有 JavaScript 錯誤', async () => {
  assert.deepEqual(pageErrors, []);
});

await browser.close();
for (const r of results) console.log(r.join(' '));
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
