// 📊 問卷檢查：誰還沒交、誰遲交、答案對不對（可用 AI 批改簡答題）
// 回覆只在這個畫面裡處理，不會被儲存。送給 AI 批改時只送「S1、S2…」代號和答案，不送學生名字。
import { el, parseCSV, normName, parseFormTimestamp, parseScore, todayISO, copyText } from '../utils.js';
import { callGemini, DEFAULT_MODEL } from '../gemini.js';
import { GRADE_SCHEMA, gradePrompt } from '../prompts.js';
import { spinnerButton } from './common.js';

export const ROLES = {
  main: { label: '主要老師', desc: '踏查、週會、發送，並確認全校有沒有交問卷', grade: '' },
  g12: { label: '1-2年級批改老師', desc: '只批改 1-2 年級問卷的答案', grade: '1-2年級' },
  g38: { label: '3-8年級批改老師', desc: '只批改 3-8 年級問卷的答案', grade: '3-8年級' },
};
const VERDICT_ICON = { '對': '✅', '部分對': '🟡', '錯': '❌', '無法判斷': '❓', '未作答': '⬜' };
const VERDICT_CYCLE = ['對', '部分對', '錯'];
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const qLabel = (n) => CIRCLED[n] || `(${n + 1})`;

const S = { roster: '', deadlineDate: '', deadlineTime: '23:59', files: [] };

const ID_HINTS = ['姓名', '名字', '學生', 'name', '座號'];
const TS_HINTS = ['時間戳記', 'timestamp', '時間'];
const SCORE_HINTS = ['分數', 'score'];
const SKIP_HINTS = ['電子郵件', 'email', '年級', '班級'];

function guessCol(headers, hints) {
  const i = headers.findIndex(h => hints.some(k => h.toLowerCase().includes(k.toLowerCase())));
  return i;
}

const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

/** 讀 Excel（.xlsx）第一個工作表，回傳一列一列的陣列 */
export async function readXlsxRows(file) {
  if (!window.XLSX) {
    await new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = XLSX_URL; sc.onload = resolve;
      sc.onerror = () => reject(new Error('無法載入 Excel 讀取工具，請檢查網路，或把 Excel 另存成 CSV 再上傳。'));
      document.head.append(sc);
    });
  }
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })
    .map(r => r.map(c => String(c ?? '').trim()))
    .filter(r => r.some(Boolean));
}

/**
 * 學生名單：一行一位。支援
 * - 有標題列：「姓名 年級 班別」（欄位順序不限，用 Tab、逗號或空白分開）
 * - 沒有標題列：「王小明 1 快樂兔」（名字在第一欄）或「3年級,王小明」（名字在最後）
 */
export function parseRoster(text) {
  const rows = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(l => l.split(/[,，\t]|\s{1,}/).map(x => x.trim()).filter(Boolean));
  if (!rows.length) return [];
  let iName = -1, iGrade = -1, iClass = -1, start = 0;
  const head = rows[0];
  if (head.some(h => /姓名|名字/.test(h))) {
    iName = head.findIndex(h => /姓名|名字/.test(h));
    iGrade = head.findIndex(h => /年級/.test(h));
    iClass = head.findIndex(h => /班/.test(h));
    start = 1;
  }
  const out = [];
  for (const parts of rows.slice(start)) {
    let name, grade = '', cls = '';
    if (iName >= 0) {
      name = parts[iName]; grade = iGrade >= 0 ? (parts[iGrade] || '') : ''; cls = iClass >= 0 ? (parts[iClass] || '') : '';
    } else if (parts.length > 1 && /^\d|年級/.test(parts[0])) {
      name = parts[parts.length - 1]; grade = parts[0]; cls = parts.slice(1, -1).join(' ');
    } else {
      name = parts[0]; grade = parts[1] || ''; cls = parts.slice(2).join(' ');
    }
    if (!name) continue;
    grade = grade.replace(/\.0+$/, '').replace(/年級$/, '');
    out.push({ name, grade, cls, group: [grade && `${grade}年級`, cls].filter(Boolean).join(' '), key: normName(name) });
  }
  return out;
}

/** 同一個學生交很多次，只留最後一次 */
function latestByStudent(file) {
  const { rows, idCol, tsCol } = file;
  const latest = new Map();
  for (const r of rows) {
    const name = (r[idCol] || '').trim();
    if (!name) continue;
    const ts = tsCol >= 0 ? parseFormTimestamp(r[tsCol]) : null;
    const key = normName(name);
    const prev = latest.get(key);
    if (!prev) latest.set(key, { r, name, key, ts, dup: 1 });
    else {
      prev.dup++;
      if (!(prev.ts && ts && prev.ts > ts)) Object.assign(prev, { r, name, ts });
    }
  }
  return [...latest.values()];
}

const sameAnswer = (a, b) => {
  const norm = v => String(v || '').split(/[;；]/).map(normName).filter(Boolean).sort().join(';');
  return norm(a) === norm(b);
};

/** 要批改的題目：有填正確答案、或已經用 AI 批改過，而且沒有被設成「不批改」 */
export function gradedCols(file) {
  return Object.keys(file.keys).map(Number)
    .filter(i => !(file.skip || {})[i])
    .filter(i => (file.keys[i] || '').trim() || (file.ai || {})[i]);
}

/** 批改一份問卷，回傳每位學生的結果 */
export function gradeFile(file, deadline) {
  const { headers, keys, scoreCol } = file;
  const ai = file.ai || {}, overrides = file.overrides || {};
  const qCols = gradedCols(file);
  const results = latestByStudent(file).map(st => {
    const marks = {};
    let right = 0;
    const wrong = [], partial = [];
    for (const c of qCols) {
      const answer = String(st.r[c] || '').trim();
      let verdict, reason = '';
      if (!answer) verdict = '未作答';
      else if (ai[c]?.[st.key]) ({ verdict, reason } = ai[c][st.key]);
      else verdict = sameAnswer(answer, keys[c]) ? '對' : '錯';
      if (overrides[`${st.key}|${c}`]) { verdict = overrides[`${st.key}|${c}`]; reason = '老師改過'; }
      marks[c] = { verdict, reason, answer };
      if (verdict === '對') right++;
      else if (verdict === '部分對') { right += 0.5; partial.push(headers[c]); }
      else wrong.push(headers[c]);
    }
    return {
      name: st.name, key: st.key, ts: st.ts, dup: st.dup,
      late: !!(deadline && st.ts && st.ts > deadline),
      formScore: scoreCol >= 0 ? parseScore(st.r[scoreCol]) : null,
      right, total: qCols.length, wrong, partial, marks,
    };
  });
  // 每題答對比例：每位學生只算一次
  const perQ = qCols.map(c => ({
    q: headers[c], col: c,
    ok: results.filter(r => r.marks[c].verdict === '對').length,
    n: results.length,
  }));
  return { results, perQ, qCols };
}

/** 用 AI 批改：每題分批送出，只送代號和答案 */
export async function aiGradeFile(file, { apiKey, model, gradeBand, onProgress }) {
  const students = latestByStudent(file);
  const cols = Object.keys(file.keys).map(Number).filter(i => !(file.skip || {})[i]);
  file.ai = file.ai || {};
  const BATCH = 40;
  let done = 0;
  const totalCalls = cols.reduce((n, c) => n + Math.ceil(students.filter(st => String(st.r[c] || '').trim()).length / BATCH), 0);
  for (const c of cols) {
    const withAns = students.filter(st => String(st.r[c] || '').trim());
    const res = {};
    for (let i = 0; i < withAns.length; i += BATCH) {
      const chunk = withAns.slice(i, i + BATCH);
      const idOf = new Map(chunk.map((st, j) => [`S${i + j + 1}`, st.key]));
      const answers = chunk.map((st, j) => ({ id: `S${i + j + 1}`, answer: String(st.r[c]).trim().slice(0, 500) }));
      const out = await callGemini({
        apiKey, model: model || DEFAULT_MODEL, temperature: 0.1, schema: GRADE_SCHEMA,
        parts: gradePrompt({ question: file.headers[c], reference: (file.keys[c] || '').trim(), gradeBand, answers }),
      });
      for (const r of out.results || []) {
        const key = idOf.get(r.id);
        if (key) res[key] = { verdict: r.verdict, reason: r.reason || '' };
      }
      // AI 漏掉的就標「無法判斷」，請老師看
      for (const [id, key] of idOf) if (!res[key]) res[key] = { verdict: '無法判斷', reason: 'AI 沒有回答這位' };
      done++;
      if (onProgress) onProgress(done, totalCalls);
    }
    file.ai[c] = res;
  }
}

export async function renderSurvey(root, ctx) {
  const role = ctx.settings?.role || 'main';
  const isMain = role === 'main';
  const band = ROLES[role]?.grade || '';
  if (!S.deadlineDate) {
    const trips = await ctx.store.list('trips');
    S.deadlineDate = trips[0]?.date || todayISO();
  }

  // 老師按過「記住名單」的話，就自動載入（存在老師自己的帳號裡，不在公開的程式碼裡）
  if (!S.roster && ctx.settings?.roster) S.roster = ctx.settings.roster;
  const roster = el('textarea', { placeholder: '可以直接上傳 Excel，或從 Excel 複製貼上，例如：\n姓名\t年級\t班別\n王小明\t3\t快樂兔', style: 'min-height:140px' });
  roster.value = S.roster;
  const rosterInfo = el('div', { class: 'muted' });
  const drawRosterInfo = () => {
    const list = parseRoster(S.roster);
    const saved = !!ctx.settings?.roster && ctx.settings.roster === S.roster;
    const byCls = {};
    list.forEach(s => { const k = s.cls || '（沒有班別）'; byCls[k] = (byCls[k] || 0) + 1; });
    rosterInfo.textContent = list.length
      ? `讀到 ${list.length} 位學生：${Object.entries(byCls).map(([k, n]) => `${k} ${n} 人`).join('、')}${saved ? '　✅ 已記住' : '　（還沒記住）'}`
      : '';
  };
  roster.addEventListener('input', () => { S.roster = roster.value; drawRosterInfo(); draw(); });
  const rosterFile = el('input', { type: 'file', accept: '.xlsx,.xls,.csv,.txt', hidden: true });
  rosterFile.addEventListener('change', async () => {
    const f = rosterFile.files[0];
    rosterFile.value = '';
    if (!f) return;
    try {
      const rows = /\.xlsx?$/i.test(f.name) ? await readXlsxRows(f) : parseCSV(await f.text());
      S.roster = rows.map(r => r.join('\t')).join('\n');
      roster.value = S.roster;
      drawRosterInfo(); draw();
      ctx.toast(`已讀入名單：${parseRoster(S.roster).length} 位學生`);
    } catch (e) { ctx.toast(e.message); }
  });
  const rememberBtn = el('button', { class: 'btn', onclick: async () => {
    if (!parseRoster(S.roster).length) { ctx.toast('名單是空的'); return; }
    await ctx.store.saveSettings({ ...ctx.settings, roster: S.roster });
    await ctx.reloadSettings();
    drawRosterInfo();
    ctx.toast('已記住名單，下次打開會自動載入');
  } }, '💾 記住這份名單');
  const forgetBtn = el('button', { class: 'btn danger', onclick: async () => {
    if (!confirm('確定要清除記住的名單嗎？')) return;
    const { roster: _r, ...rest } = ctx.settings || {};
    await ctx.store.saveSettings(rest);
    await ctx.reloadSettings();
    drawRosterInfo();
    ctx.toast('已清除記住的名單');
  } }, '🗑️ 清除記住的名單');
  const dDate = el('input', { type: 'date', value: S.deadlineDate });
  const dTime = el('input', { type: 'text', value: S.deadlineTime, placeholder: '23:59', style: 'max-width:120px' });
  dDate.addEventListener('change', () => { S.deadlineDate = dDate.value; draw(); });
  dTime.addEventListener('input', () => { S.deadlineTime = dTime.value; draw(); });

  const fileInput = el('input', { type: 'file', accept: '.csv,text/csv,.xlsx', multiple: true, hidden: true });
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      let rows;
      try { rows = /\.xlsx?$/i.test(f.name) ? await readXlsxRows(f) : parseCSV(await f.text()); }
      catch (e) { ctx.toast(e.message); continue; }
      if (rows.length < 1) { ctx.toast(`「${f.name}」是空的`); continue; }
      const headers = rows[0].map(h => h.trim());
      const idCol = guessCol(headers, ID_HINTS);
      const tsCol = guessCol(headers, TS_HINTS);
      const scoreCol = headers.findIndex(h => SCORE_HINTS.some(k => h.trim().toLowerCase() === k));
      const keys = {};
      headers.forEach((h, i) => {
        if (i === idCol || i === tsCol || i === scoreCol) return;
        if (SKIP_HINTS.some(k => h.toLowerCase().includes(k))) return;
        keys[i] = '';
      });
      S.files.push({ name: f.name, headers, rows: rows.slice(1), idCol: idCol < 0 ? 1 : idCol, tsCol, scoreCol, keys });
    }
    fileInput.value = '';
    draw();
  });

  const body = el('div');

  function deadline() {
    if (!S.deadlineDate) return null;
    const [h, m] = (S.deadlineTime || '23:59').split(':').map(Number);
    const [y, mo, d] = S.deadlineDate.split('-').map(Number);
    return new Date(y, mo - 1, d, h || 0, m || 0, 59);
  }

  function draw() {
    const list = parseRoster(S.roster);
    const dl = deadline();
    const graded = S.files.map(f => ({ f, ...gradeFile(f, dl) }));
    const submitted = new Map();
    graded.forEach(g => g.results.forEach(r => submitted.set(r.key, r)));
    const missing = list.filter(s => !submitted.has(s.key));
    const late = [...submitted.values()].filter(r => r.late);
    const unknown = list.length ? [...submitted.values()].filter(r => !list.some(s => s.key === r.key)) : [];

    // 未交名單依班別分組，方便各班提醒
    const missByCls = {};
    missing.forEach(s => { const k = s.group || '其他'; (missByCls[k] = missByCls[k] || []).push(s.name); });
    const summaryText = [
      `未交（${missing.length}）：${missing.length ? '' : '無'}`,
      ...Object.entries(missByCls).map(([k, names]) => `・${k}：${names.join('、')}`),
      `遲交（${late.length}）：${late.map(r => r.name).join('、') || '無'}`,
    ].join('\n');

    const fileCards = graded.map(({ f, results, perQ }, fi) => {
      const sel = (val, onChange, allowNone) => {
        const s = el('select', {},
          allowNone ? el('option', { value: '-1' }, '（沒有）') : null,
          ...f.headers.map((h, i) => el('option', { value: String(i), selected: i === val }, h || `第 ${i + 1} 欄`)));
        if (allowNone && val < 0) s.value = '-1';
        s.addEventListener('change', () => { onChange(Number(s.value)); draw(); });
        return s;
      };
      const keyInputs = Object.keys(f.keys).map(Number).map((i, n) => {
        const answers = [...new Set(f.rows.map(r => (r[i] || '').trim()).filter(Boolean))].slice(0, 30);
        const listId = `ans-${fi}-${i}`;
        const inp = el('input', { type: 'text', value: f.keys[i], list: listId, placeholder: '正確答案（簡答題可以留空，讓 AI 判斷）' });
        inp.addEventListener('change', () => { f.keys[i] = inp.value; draw(); });
        const skip = el('input', { type: 'checkbox', checked: !!(f.skip || {})[i] });
        skip.addEventListener('change', () => { f.skip = { ...(f.skip || {}), [i]: skip.checked }; draw(); });
        return el('div', {}, el('label', {}, `${qLabel(n)} ${f.headers[i]}`), inp,
          el('label', { class: 'inline' }, skip, el('span', { class: 'muted' }, '這題不批改（例如：感想、心得）')),
          el('datalist', { id: listId }, ...answers.map(a => el('option', { value: a }))));
      });
      const qIndex = new Map(Object.keys(f.keys).map(Number).map((c, n) => [c, n]));
      const anyKey = Object.values(f.keys).some(v => (v || '').trim()) || Object.keys(f.ai || {}).length;
      const aiBtn = el('button', { class: 'btn primary' }, '🤖 用 AI 批改');
      const aiMsg = el('div');
      aiBtn.addEventListener('click', async () => {
        if (!ctx.settings?.geminiKey) { aiMsg.replaceChildren(el('div', { class: 'notice danger' }, '還沒設定 Gemini 鑰匙，請先到「⚙️ 設定」。')); return; }
        const done = spinnerButton(aiBtn, 'AI 批改中…');
        try {
          await aiGradeFile(f, {
            apiKey: ctx.settings.geminiKey, model: ctx.settings.model, gradeBand: band || (f.name.match(/\d-\d年級/) || [''])[0],
            onProgress: (d, t) => { aiBtn.lastChild.textContent = ` AI 批改中…（${d}/${t}）`; },
          });
          f.overrides = {};
          ctx.toast('AI 批改完成，請老師看一下 🟡❓ 的地方');
        } catch (e) { done(); aiMsg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); return; }
        done();
        draw();
      });
      const cycle = (r, c) => {
        const cur = r.marks[c].verdict;
        const next = VERDICT_CYCLE[(VERDICT_CYCLE.indexOf(cur) + 1) % VERDICT_CYCLE.length];
        f.overrides = { ...(f.overrides || {}), [`${r.key}|${c}`]: next };
        draw();
      };
      // 給批改老師的總結：每題答對比例、需要再教的題目、錯比較多的學生
      const needHelp = results.filter(r => r.total && r.right / r.total < 0.6);
      const gradeSummary = [
        `【${f.name.replace(/\.(csv|xlsx?)$/i, '')}】共 ${results.length} 人`,
        ...perQ.map(q => `${qLabel(qIndex.get(q.col))} ${q.q}：${q.ok}/${q.n} 答對（${q.n ? Math.round(q.ok / q.n * 100) : 0}%）`),
        `需要再教的題目：${perQ.filter(q => q.n && q.ok / q.n < 0.6).map(q => qLabel(qIndex.get(q.col))).join('、') || '無'}`,
        `答對不到六成的學生（${needHelp.length}）：${needHelp.map(r => r.name).join('、') || '無'}`,
      ].join('\n');
      return el('div', { class: 'card' },
        el('div', { class: 'output-head' },
          el('h2', {}, `📄 ${f.name}`),
          el('button', { class: 'btn small danger', onclick: () => { S.files.splice(fi, 1); draw(); } }, '移除'),
        ),
        el('p', { class: 'muted' }, `共 ${f.rows.length} 筆回覆`),
        el('div', { class: 'row' },
          el('div', {}, el('label', {}, '學生名字在哪一欄？'), sel(f.idCol, v => { f.idCol = v; }, false)),
          el('div', {}, el('label', {}, '交卷時間在哪一欄？'), sel(f.tsCol, v => { f.tsCol = v; }, true)),
          el('div', {}, el('label', {}, 'Google 表單自動算的分數'), sel(f.scoreCol, v => { f.scoreCol = v; }, true)),
        ),
        el('details', { open: !anyKey && f.scoreCol < 0 }, el('summary', {}, '✏️ 設定正確答案（選擇題填答案；簡答題可以留空給 AI 判斷）'),
          el('p', { class: 'muted' }, '可以從下拉選單選學生填過的答案。複選題用分號分開，例如：A;C'),
          ...keyInputs),
        el('div', { class: 'notice ok' }, '🤖 AI 批改：只會送「S1、S2…」代號和答案給 AI，不會送學生名字。AI 也可能看錯，結果要請老師看過。'),
        el('div', { class: 'btns' }, aiBtn),
        aiMsg,
        el('h3', {}, '每位學生'),
        perQ.length ? el('p', { class: 'muted' }, '✅ 對　🟡 部分對　❌ 錯　❓ AI 看不懂　⬜ 沒寫。覺得 AI 判錯了，直接點那個符號就能改。') : null,
        el('div', { style: 'overflow-x:auto' }, el('table', { class: 'grid' },
          el('thead', {}, el('tr', {}, el('th', {}, '名字'), el('th', {}, '交卷時間'), el('th', {}, '分數'), el('th', {}, '每一題'), el('th', {}, '錯的題目'))),
          el('tbody', {}, ...results.map(r => el('tr', {},
            el('td', {}, r.name, r.dup > 1 ? el('span', { class: 'tag warn' }, `交了 ${r.dup} 次`) : null,
              list.length && !list.some(s => s.key === r.key) ? el('span', { class: 'tag warn' }, '名單裡找不到') : null),
            el('td', {}, r.ts ? `${r.ts.getMonth() + 1}/${r.ts.getDate()} ${String(r.ts.getHours()).padStart(2, '0')}:${String(r.ts.getMinutes()).padStart(2, '0')}` : '—',
              r.late ? el('span', { class: 'tag warn' }, '遲交') : null),
            el('td', {}, [
              r.formScore ? `表單：${r.formScore.got}/${r.formScore.total}` : '',
              r.total ? `批改：${r.right}/${r.total}` : '',
            ].filter(Boolean).join('　') || '—'),
            el('td', { class: 'marks' }, ...Object.entries(r.marks).map(([c, m]) => el('button', {
              class: 'mark', title: `${f.headers[c]}\n學生答：${m.answer || '（沒寫）'}${m.reason ? `\n${m.reason}` : ''}`,
              'aria-label': `${qLabel(qIndex.get(Number(c)))} ${m.verdict}`,
              onclick: () => cycle(r, Number(c)),
            }, `${qLabel(qIndex.get(Number(c)))}${VERDICT_ICON[m.verdict] || ''}`))),
            el('td', {}, r.wrong.length ? r.wrong.join('、') : (r.total ? (r.partial.length ? `部分對：${r.partial.join('、')}` : '全對 🎉') : '—')),
          ))),
        )),
        perQ.length ? el('div', {}, el('h3', {}, '每一題答對比例'),
          ...perQ.map(q => el('div', { class: 'list-item' }, el('span', {}, `${qLabel(qIndex.get(q.col))} ${q.q}`), el('span', { class: q.n && q.ok / q.n < 0.5 ? 'tag warn' : 'tag' }, `${q.ok}/${q.n}（${q.n ? Math.round(q.ok / q.n * 100) : 0}%）`)))) : null,
        perQ.length ? el('div', {},
          el('h3', {}, '📋 批改總結'),
          el('div', { class: 'bubble' }, gradeSummary),
          el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: async () => ctx.toast(await copyText(gradeSummary) ? '已複製' : '複製失敗') }, '📋 複製批改總結')),
          el('p', { class: 'muted' }, '⚠️ 總結裡有學生名字，只能給老師之間看，不要貼到家長群組。')) : null,
      );
    });

    body.replaceChildren(...[
      S.files.length && isMain ? el('div', { class: 'card' },
        el('h2', {}, '📌 總結'),
        list.length ? null : el('div', { class: 'notice warn' }, '還沒貼學生名單，所以只能看已交的人，看不出誰沒交。'),
        el('div', { class: 'bubble' }, summaryText),
        unknown.length ? el('div', { class: 'notice warn' }, `表單裡有 ${unknown.length} 個名字對不到名單（可能打錯字）：${unknown.map(r => r.name).join('、')}`) : null,
        el('div', { class: 'btns' }, el('button', { class: 'btn primary', onclick: async () => ctx.toast(await copyText(summaryText) ? '已複製' : '複製失敗') }, '📋 複製未交／遲交名單')),
        el('p', { class: 'muted' }, '⚠️ 這份名單有學生名字，只能私下提醒，不要貼到家長群組。'),
      ) : null,
      ...fileCards,
    ].filter(Boolean));
  }

  root.replaceChildren(...[
    el('h1', {}, isMain ? '📊 問卷檢查（全校）' : `📝 ${band}答案批改`),
    el('div', { class: 'notice ok' }, isMain
      ? '🔒 問卷回覆只在這個畫面裡處理，不會被儲存。用 AI 批改時只送代號和答案，不送名字。名單只有在你按「記住這份名單」時，才會存在你自己的帳號裡。'
      : `🔒 上傳 ${band}問卷的回覆，按「🤖 用 AI 批改」就好。回覆不會被儲存，AI 只看得到代號和答案，看不到學生名字。`),
    el('div', { class: 'card' },
      el('h2', {}, el('span', { class: 'step-num' }, '1'), '下載問卷回覆'),
      el('ol', { class: 'muted' },
        el('li', {}, '打開 Google 表單 → 上面的「回覆」分頁。'),
        el('li', {}, '按右上角「⋮」→「下載回覆（.csv）」。如果是連到試算表，就在試算表按「檔案 → 下載 → 逗號分隔值（.csv）」。'),
        isMain ? el('li', {}, '1-2 年級和 3-8 年級兩份都下載，一起上傳。') : el('li', {}, `只要下載 ${band}那一份。`),
      ),
      el('div', { class: 'btns' }, el('button', { class: 'btn primary', onclick: () => fileInput.click() }, '📂 上傳回覆（CSV 或 Excel）'), fileInput),
    ),
    !isMain ? null : el('div', { class: 'card' },
      el('h2', {}, el('span', { class: 'step-num' }, '2'), '學生名單（用來找出誰沒交）'),
      el('div', { class: 'btns', style: 'margin-top:0' },
        el('button', { class: 'btn primary', onclick: () => rosterFile.click() }, '📂 上傳名單 Excel'), rosterFile,
        rememberBtn, forgetBtn),
      el('p', { class: 'muted' }, '⚠️ 名單有學生名字，不要放到 GitHub 或任何公開的地方。'),
      roster,
      rosterInfo,
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '截止日期'), dDate),
        el('div', {}, el('label', {}, '截止時間'), dTime),
      ),
    ),
    body,
  ].filter(Boolean));
  drawRosterInfo();
  draw();
}
