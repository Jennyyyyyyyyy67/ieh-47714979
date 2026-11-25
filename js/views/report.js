// 📋 本週名單：把三位老師的工作合在一起 —— 未填問卷、大孩子老師出題全對、大孩子自出題全對、小小孩全對
// 有學生名字，存在共用帳號裡，跟踏查紀錄一樣，超過保留天數會自動刪除。
import { el, toROC, weekKey, copyText } from '../utils.js';

// 順序就是名單上的順序。title／note 是預設文字，可以在「⚙️ 設定 → 名單格式」改。
export const PARTS = {
  missing: { title: '未填問卷', note: '補填問卷、抄未完成作業箴言3次/一年級1次', by: '主要老師（📊 問卷檢查）' },
  perfect38t: { title: '大孩子老師出題全對', note: '5元心幣', by: '批改 3-8 年級的老師' },
  perfect38s: { title: '大孩子自出題全對', note: '5元心幣', by: '批改 3-8 年級的老師' },
  perfect12: { title: '小小孩全對', note: '10元心幣', by: '批改 1-2 年級的老師' },
};

/** 合併老師在設定裡改過的標題和獎勵文字 */
export function partLabels(settings) {
  const custom = settings?.reportLabels || {};
  return Object.fromEntries(Object.entries(PARTS).map(([k, p]) => [k, {
    ...p,
    title: (custom[k]?.title || '').trim() || p.title,
    note: custom[k]?.note !== undefined ? custom[k].note.trim() : p.note,
  }]));
}

/**
 * 把某一部分存進那一週的名單。names：[{name, group}]
 * 每一部分各存一筆（例如 2026-11-17-perfect12），兩位老師同時按儲存也不會互相蓋掉。
 */
export async function saveReportPart(ctx, dateISO, part, names) {
  const week = weekKey(dateISO, ctx.settings?.sendWeekday ?? 2);
  await ctx.store.save('reports', { id: `${week}-${part}`, week, part, names, savedAt: Date.now() });
  return week;
}

/** 把一筆一筆的部分合成「一週一份」 */
function byWeek(items) {
  const weeks = {};
  for (const it of items) {
    if (it.part === 'perfect38') it.part = 'perfect38t'; // 舊版的「3-8年級全對」
    if (!it.week || !PARTS[it.part]) continue;
    const w = (weeks[it.week] = weeks[it.week] || { id: it.week, week: it.week, ids: [] });
    w[it.part] = { names: it.names || [], savedAt: it.savedAt };
    w.ids.push(it.id);
  }
  return Object.values(weeks).sort((a, b) => b.week.localeCompare(a.week));
}

function groupByClass(names) {
  const g = {};
  names.forEach(n => { const k = n.group || '其他'; (g[k] = g[k] || []).push(n.name); });
  return g;
}

export function reportText(r, labels = partLabels()) {
  const lines = [`【${toROC(r.week)} 問卷名單】`];
  for (const [key, p] of Object.entries(labels)) {
    const part = r[key];
    lines.push('');
    lines.push(`${p.title}：${p.note ? `（${p.note}）` : ''}`);
    if (!part) { lines.push('（還沒完成）'); continue; }
    if (!part.names.length) { lines.push('（無）'); continue; }
    if (key === 'missing') {
      for (const [g, ns] of Object.entries(groupByClass(part.names))) lines.push(`${g}：${ns.join('、')}`);
    } else {
      lines.push(part.names.map(n => n.name).join('、'));
    }
  }
  return lines.join('\n');
}

export async function renderReport(root, ctx) {
  const reports = byWeek(await ctx.store.list('reports'));
  const thisWeek = weekKey(null, ctx.settings?.sendWeekday ?? 2);
  let current = (ctx.params?.reportId && reports.find(r => r.id === ctx.params.reportId)) || reports.find(r => r.id === thisWeek) || reports[0];
  ctx.params = null;
  const body = el('div');

  const pick = el('select', {}, ...reports.map(r => el('option', { value: r.id, selected: current && r.id === current.id }, `${toROC(r.week)} 那一週${r.id === thisWeek ? '（本週）' : ''}`)));
  pick.addEventListener('change', () => { current = reports.find(r => r.id === pick.value); draw(); });

  function draw() {
    if (!current) {
      body.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'muted' }, '這週還沒有人存名單。每位老師做完自己的工作後，在「問卷檢查／答案批改」按「💾 存進本週名單」，這裡就會出現。')));
      return;
    }
    const labels = partLabels(ctx.settings);
    const text = reportText(current, labels);
    const waiting = Object.entries(labels).filter(([k]) => !current[k]);
    body.replaceChildren(...[
      el('div', { class: 'card' },
        el('h2', {}, `${toROC(current.week)} 這週`),
        ...Object.entries(labels).map(([k, p]) => el('div', { class: 'list-item' },
          el('span', {}, p.title),
          current[k]
            ? el('span', { class: 'tag' }, `✅ ${current[k].names.length} 人`)
            : el('span', { class: 'tag warn' }, `⏳ 等${p.by}`))),
        waiting.length ? el('div', { class: 'notice warn' }, `還差：${[...new Set(waiting.map(([, p]) => p.by))].join('、')}。完成後重新打開這一頁就會更新。`) : el('div', { class: 'notice ok' }, '🎉 全部都完成了！'),
      ),
      el('div', { class: 'card' },
        el('h2', {}, '📋 合併名單'),
        el('div', { class: 'bubble' }, text),
        el('div', { class: 'btns' },
          el('button', { class: 'btn primary', onclick: async () => ctx.toast(await copyText(text) ? '已複製' : '複製失敗') }, '📋 複製整份名單'),
          el('button', { class: 'btn', onclick: () => ctx.go('report', { reportId: current.id }) }, '🔄 重新整理'),
        ),
        el('p', { class: 'muted' }, '⚠️ 名單有學生名字：未填名單只能私下提醒。全對名單要不要公開表揚，請照學校的規定。'),
      ),
    ]);
  }

  root.replaceChildren(...[
    el('h1', {}, '📋 本週名單'),
    el('p', { class: 'muted' }, '三位老師各自做完工作、按「💾 存進本週名單」後，會自動合併在這裡。同一週不管哪天存，都會放進同一份。'),
    reports.length > 1 ? el('div', { class: 'card' }, el('label', {}, '選擇哪一週'), pick) : null,
    body,
  ].filter(Boolean));
  draw();
}
