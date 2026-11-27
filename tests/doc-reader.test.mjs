// 測試「送給 AI 之前遮掉個資」和「AI 找到的地名，原文裡有沒有」的規則。只用假名字。
// 執行：node tests/doc-reader.test.mjs
import assert from 'node:assert/strict';
const { redactText, looksLikeNameList, makeBatches, isTemplateBook } = await import('../js/doc-reader.js');
const { nameInText, placeKey } = await import('../js/places-logic.js');

const results = [];
const step = (name, fn) => { try { fn(); results.push(['✅', name]); } catch (e) { results.push(['❌', name, e.message.split('\n')[0]]); } };

step('遮掉：名單裡的名字、手機、市話、Email、身分證、班級、○○老師', () => {
  const { text, counts } = redactText([
    '帶隊同學：測試甲乙',
    '聯絡：王老師 0912-345-678、(07)380-0089、test.teacher@school.edu.tw',
    '證件 A123456789 三年甲班',
    '車 林老 師 已預約',
  ].join('\n'), ['測試甲乙']);
  for (const bad of ['測試甲乙', '0912-345-678', '380-0089', 'test.teacher@', 'A123456789', '三年甲班', '王老師', '林老 師']) assert.ok(!text.includes(bad), `還看得到：${bad}\n${text}`);
  // 「帶隊同學」的「帶隊」也會被當成名字遮掉：寧可多遮一點
  assert.deepEqual([counts.names, counts.phones, counts.emails, counts.ids, counts.people], [1, 2, 1, 2, 3]);
});

step('整行拿掉：禁足、座號、生日、過敏……還有一串像名單的名字', () => {
  const { text, counts } = redactText(['禁足名單：測試丙丁、測試戊己', '座號 12', '生日 5/3', '過敏：花生', '林小一 陳小二 張小三 李小四', '9/28 測試科學館'].join('\n'));
  assert.equal(text, '9/28 測試科學館');
  assert.equal(counts.lines, 5);
});

step('不會誤刪：地點、日期時間、表格標題、地點清單、「科工館導覽老師」', () => {
  const keep = ['週次 | 日期 | 地點 | 聯絡人', '總圖 左新 美術館 科工館', '13:30 從青埔出發 16:00 回到青埔', '2021-09-28 0930-1130 參觀', '科工館導覽老師帶隊', '日期 地點 交通 備註'];
  assert.equal(redactText(keep.join('\n')).text, keep.join('\n'));
  assert.equal(looksLikeNameList('王小明、李小華、陳大同、林美玲'), true);
  assert.equal(looksLikeNameList('總圖、左新、美術館、科工館'), false);
  assert.equal(looksLikeNameList('王小明、李小華'), false, '少於 4 個不算');
});

step('只遮 2 個字以上的名字（一個字的不遮，免得把地名遮壞）', () => {
  assert.equal(redactText('王功漁港', ['王']).text, '王功漁港');
});

step('原文找得到嗎：台／臺、空白、括號裡的別名都算；AI 自己編的找不到', () => {
  const src = placeKey('11/17 臺灣滷味 博物館\n12/1 美術館/兒童美術館');
  assert.equal(nameInText('台灣滷味博物館', src), true);
  assert.equal(nameInText('美術館（兒童美術館）', src), true);
  assert.equal(nameInText('AI亂編的地方', src), false);
  assert.equal(nameInText('', src), false);
});

step('分批：文字合在一起、太長的切段；照片一個一批', () => {
  const b = makeBatches([{ kind: 'text', source: 'a.pdf', text: 'x'.repeat(15000) }, { kind: 'text', source: 'b.docx', text: 'y'.repeat(8000) }, { kind: 'binary', source: 'c.jpg' }], 20000);
  assert.deepEqual(b.map(x => (x.docs ? x.docs.map(d => d.source) : ['📷' + x.binary.source])), [['a.pdf'], ['b.docx'], ['📷c.jpg']]);
});

step('範本 Excel 才直接匯入：有「地點名稱」欄，或「地點」＋「去過」欄', () => {
  assert.equal(isTemplateBook({ 地點: [['地點名稱', '室內外']] }), true);
  assert.equal(isTemplateBook({ 工作表1: [['地點', '去過的日期']] }), true);
  assert.equal(isTemplateBook({ 工作表1: [['日期', '地點', '備註']] }), false, '一般的行程表交給 AI 讀');
});

for (const r of results) console.log(r.join(' '));
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n讀檔與遮個資：${results.length - bad} 通過，${bad} 失敗`);
process.exit(bad ? 1 : 0);
