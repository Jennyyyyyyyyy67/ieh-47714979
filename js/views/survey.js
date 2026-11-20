// 📊 問卷檢查：誰還沒交、誰遲交、答案對不對
// 名單和回覆都只在這個畫面裡處理，不會被儲存（因為有學生名字）。
import { el, parseCSV, normName, parseFormTimestamp, parseScore, todayISO, copyText } from '../utils.js';

const S = { roster: '', deadlineDate: '', deadlineTime: '23:59', files: [] };

const ID_HINTS = ['姓名', '名字', '學生', 'name', '座號'];
const TS_HINTS = ['時間戳記', 'timestamp', '時間'];
const SCORE_HINTS = ['分數', 'score'];
const SKIP_HINTS = ['電子郵件', 'email', '年級', '班級'];

function guessCol(headers, hints) {
  const i = headers.findIndex(h => hints.some(k => h.toLowerCase().includes(k.toLowerCase())));
  return i;
}

function parseRoster(text) {
  // 每行一位學生：「姓名」或「年級,姓名」或「年級 姓名」
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const parts = l.split(/[,，\t]/).map(x => x.trim()).filter(Boolean);
    const name = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const group = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
    return { name, group, key: normName(name) };
  });
}

/** 批改一份問卷，回傳每位學生的結果 */
export function gradeFile(file, deadline) {
  const { headers, rows, idCol, tsCol, scoreCol, keys } = file;
  const qCols = Object.keys(keys).map(Number).filter(i => (keys[i] || '').trim());
  const byKey = new Map();
  for (const r of rows) {
    const name = (r[idCol] || '').trim();
    if (!name) continue;
    const ts = tsCol >= 0 ? parseFormTimestamp(r[tsCol]) : null;
    const wrong = [];
    let right = 0;
    for (const c of qCols) {
      const correct = keys[c].split(/[;；]/).map(normName).filter(Boolean).sort().join(';');
      const ans = String(r[c] || '').split(/[;；]/).map(normName).filter(Boolean).sort().join(';');
      if (ans === correct) right++; else wrong.push(headers[c]);
    }
    const rec = {
      name, key: normName(name), ts,
      late: !!(deadline && ts && ts > deadline),
      formScore: scoreCol >= 0 ? parseScore(r[scoreCol]) : null,
      right, total: qCols.length, wrong, dup: 1,
    };
    const prev = byKey.get(rec.key);
    if (prev) { rec.dup = prev.dup + 1; if (prev.ts && rec.ts && prev.ts > rec.ts) { prev.dup = rec.dup; continue; } }
    byKey.set(rec.key, rec);
  }
  const results = [...byKey.values()];
  // 每題答對比例：每位學生只算一次（重複交的取最後一次）
  const perQ = qCols.map(c => ({
    q: headers[c],
    ok: results.filter(r => !r.wrong.includes(headers[c])).length,
    n: results.length,
  }));
  return { results, perQ };
}

export async function renderSurvey(root, ctx) {
  if (!S.deadlineDate) {
    const trips = await ctx.store.list('trips');
    S.deadlineDate = trips[0]?.date || todayISO();
  }

  const roster = el('textarea', { placeholder: '一行一位學生，例如：\n3年級,王小明\n3年級,陳小華\n（也可以只寫名字）', style: 'min-height:140px' });
  roster.value = S.roster;
  roster.addEventListener('input', () => { S.roster = roster.value; draw(); });
  const dDate = el('input', { type: 'date', value: S.deadlineDate });
  const dTime = el('input', { type: 'text', value: S.deadlineTime, placeholder: '23:59', style: 'max-width:120px' });
  dDate.addEventListener('change', () => { S.deadlineDate = dDate.value; draw(); });
  dTime.addEventListener('input', () => { S.deadlineTime = dTime.value; draw(); });

  const fileInput = el('input', { type: 'file', accept: '.csv,text/csv', multiple: true, hidden: true });
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      const rows = parseCSV(await f.text());
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

    const summaryText = [
      `未交（${missing.length}）：${missing.map(s => s.name).join('、') || '無'}`,
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
      const keyInputs = Object.keys(f.keys).map(Number).map(i => {
        const answers = [...new Set(f.rows.map(r => (r[i] || '').trim()).filter(Boolean))].slice(0, 30);
        const listId = `ans-${fi}-${i}`;
        const inp = el('input', { type: 'text', value: f.keys[i], list: listId, placeholder: '正確答案（留空＝這題不批改）' });
        inp.addEventListener('change', () => { f.keys[i] = inp.value; draw(); });
        return el('div', {}, el('label', {}, f.headers[i]), inp, el('datalist', { id: listId }, ...answers.map(a => el('option', { value: a }))));
      });
      const anyKey = Object.values(f.keys).some(v => (v || '').trim());
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
        el('details', { open: !anyKey && f.scoreCol < 0 }, el('summary', {}, '✏️ 設定正確答案（如果表單已經開「測驗模式」自動算分，可以不用設）'),
          el('p', { class: 'muted' }, '可以從下拉選單選學生填過的答案。複選題用分號分開，例如：A;C'),
          ...keyInputs),
        el('h3', {}, '每位學生'),
        el('div', { style: 'overflow-x:auto' }, el('table', { class: 'grid' },
          el('thead', {}, el('tr', {}, el('th', {}, '名字'), el('th', {}, '交卷時間'), el('th', {}, '分數'), el('th', {}, '錯的題目'))),
          el('tbody', {}, ...results.map(r => el('tr', {},
            el('td', {}, r.name, r.dup > 1 ? el('span', { class: 'tag warn' }, `交了 ${r.dup} 次`) : null,
              list.length && !list.some(s => s.key === r.key) ? el('span', { class: 'tag warn' }, '名單裡找不到') : null),
            el('td', {}, r.ts ? `${r.ts.getMonth() + 1}/${r.ts.getDate()} ${String(r.ts.getHours()).padStart(2, '0')}:${String(r.ts.getMinutes()).padStart(2, '0')}` : '—',
              r.late ? el('span', { class: 'tag warn' }, '遲交') : null),
            el('td', {}, [
              r.formScore ? `表單：${r.formScore.got}/${r.formScore.total}` : '',
              r.total ? `批改：${r.right}/${r.total}` : '',
            ].filter(Boolean).join('　') || '—'),
            el('td', {}, r.wrong.length ? r.wrong.join('、') : (r.total ? '全對 🎉' : '—')),
          ))),
        )),
        perQ.length ? el('div', {}, el('h3', {}, '每一題答對比例'),
          ...perQ.map(q => el('div', { class: 'list-item' }, el('span', {}, q.q), el('span', { class: q.n && q.ok / q.n < 0.5 ? 'tag warn' : 'tag' }, `${q.ok}/${q.n}（${q.n ? Math.round(q.ok / q.n * 100) : 0}%）`)))) : null,
      );
    });

    body.replaceChildren(
      S.files.length ? el('div', { class: 'card' },
        el('h2', {}, '📌 總結'),
        list.length ? null : el('div', { class: 'notice warn' }, '還沒貼學生名單，所以只能看已交的人，看不出誰沒交。'),
        el('div', { class: 'bubble' }, summaryText),
        unknown.length ? el('div', { class: 'notice warn' }, `表單裡有 ${unknown.length} 個名字對不到名單（可能打錯字）：${unknown.map(r => r.name).join('、')}`) : null,
        el('div', { class: 'btns' }, el('button', { class: 'btn primary', onclick: async () => ctx.toast(await copyText(summaryText) ? '已複製' : '複製失敗') }, '📋 複製未交／遲交名單')),
        el('p', { class: 'muted' }, '⚠️ 這份名單有學生名字，只能私下提醒，不要貼到家長群組。'),
      ) : null,
      ...fileCards,
    );
  }

  root.replaceChildren(
    el('h1', {}, '📊 問卷檢查'),
    el('div', { class: 'notice ok' }, '🔒 名單和問卷回覆只在這個畫面裡處理，不會被儲存，也不會傳給 AI。重新整理網頁就會清空。'),
    el('div', { class: 'card' },
      el('h2', {}, el('span', { class: 'step-num' }, '1'), '下載問卷回覆'),
      el('ol', { class: 'muted' },
        el('li', {}, '打開 Google 表單 → 上面的「回覆」分頁。'),
        el('li', {}, '按右上角「⋮」→「下載回覆（.csv）」。如果是連到試算表，就在試算表按「檔案 → 下載 → 逗號分隔值（.csv）」。'),
        el('li', {}, '1-2 年級和 3-8 年級兩份都下載，一起上傳。'),
      ),
      el('div', { class: 'btns' }, el('button', { class: 'btn primary', onclick: () => fileInput.click() }, '📂 上傳回覆 CSV'), fileInput),
    ),
    el('div', { class: 'card' },
      el('h2', {}, el('span', { class: 'step-num' }, '2'), '學生名單（用來找出誰沒交）'),
      roster,
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '截止日期'), dDate),
        el('div', {}, el('label', {}, '截止時間'), dTime),
      ),
    ),
    body,
  );
  draw();
}
