// 📍 踏查地點：地點庫（室內／室外、去過的日期）＋自動排 10 週（晴天、雨天各一個）
import { el, toROC, copyText } from '../utils.js';
import {
  placeKey, TYPES, typeLabel, rainSafe, parseDates, lastVisit, visitSummary, findPlace, planTen, tripDates,
  DEFAULT_QUARTER_START, DEFAULT_DEPART, DEFAULT_RETURN, DEFAULT_RETURN_PLACE,
} from '../places-logic.js';

/** 踏查頁用：把這次去過的日期記進地點庫。找不到同名地點就新增一個（室內外先標「室內外都有」，請老師補）。 */
export async function recordVisit(store, name, dateISO) {
  const nm = (name || '').trim();
  if (!nm || !dateISO) return null;
  const places = await store.list('places');
  const hit = findPlace(places, nm);
  if (hit) {
    if (!(hit.visits || []).includes(dateISO)) await store.save('places', { ...hit, visits: [...(hit.visits || []), dateISO].sort() });
    return { place: hit, created: false };
  }
  const saved = await store.save('places', { name: nm, type: 'mixed', note: '', visits: [dateISO], needsType: true });
  return { place: saved, created: true };
}

export async function renderPlaces(root, ctx) {
  const { store, toast } = ctx;
  let places = await store.list('places');
  let plan = (await store.list('plans')).find(p => p.id === 'current') || null;
  const start = ctx.settings?.quarterStart || DEFAULT_QUARTER_START;
  const byId = () => new Map(places.map(p => [p.id, p]));
  const refresh = async () => { places = await store.list('places'); plan = (await store.list('plans')).find(p => p.id === 'current') || null; drawList(); drawPlan(); };

  // ---------- 搜尋 ----------
  const search = el('input', { type: 'text', placeholder: '🔍 打地點名稱，看看什麼時候去過', autocomplete: 'off' });
  const result = el('div');
  const listBox = el('div');
  const countEl = el('span', { class: 'muted' });
  search.addEventListener('input', () => { drawList(); });

  function placeCard(p) {
    const visits = (p.visits || []).slice().sort().reverse();
    const edit = el('button', { class: 'btn small', onclick: () => fillForm(p) }, '修改');
    const del = el('button', { class: 'btn small danger', onclick: async () => {
      if (!confirm(`確定要刪除「${p.name}」嗎？（去過的紀錄也會一起刪掉）`)) return;
      await store.remove('places', p.id);
      toast('已刪除');
      await refresh();
    } }, '刪除');
    const visited = el('button', { class: 'btn small', onclick: async () => {
      const d = prompt(`「${p.name}」是哪一天去的？\n例如：115/11/17 或 2026-11-17`);
      if (!d) return;
      const ds = parseDates(d);
      if (!ds.length) { toast('看不懂這個日期，請寫成 115/11/17 這樣'); return; }
      await store.save('places', { ...p, visits: [...new Set([...(p.visits || []), ...ds])].sort(), needsType: p.needsType });
      toast('已記下');
      await refresh();
    } }, '＋ 記一次去過');
    return el('div', { class: 'topic' },
      el('div', { class: 'topic-head' },
        el('div', {}, el('div', { class: 'title' }, p.name), el('span', { class: p.needsType ? 'tag warn' : 'tag' }, typeLabel(p.type)), p.needsType ? el('span', { class: 'tag warn' }, '請確認室內／室外') : null),
        el('div', { class: 'btns', style: 'margin:0' }, visited, edit, del)),
      el('div', {}, visitSummary(p)),
      visits.length ? el('div', { class: 'muted' }, '去過的日子：', ...visits.map(v => el('span', { class: 'tag', title: '點一下刪除這一筆', style: 'cursor:pointer', onclick: async () => {
        if (!confirm(`刪除「${p.name}」${toROC(v)} 這一筆紀錄？`)) return;
        await store.save('places', { ...p, visits: (p.visits || []).filter(x => x !== v) });
        await refresh();
      } }, toROC(v)))) : null,
      p.note ? el('div', { class: 'muted' }, `備註：${p.note}`) : null);
  }

  function drawList() {
    const q = search.value.trim();
    const key = q.toLowerCase();
    const shown = places
      .filter(p => !q || placeKey(p.name).includes(placeKey(q)) || (p.note || '').toLowerCase().includes(key))
      .sort((a, b) => (lastVisit(b) || '').localeCompare(lastVisit(a) || '') || a.name.localeCompare(b.name, 'zh-Hant'));
    countEl.textContent = `共 ${places.length} 個地點`;
    const exact = q && findPlace(places, q);
    const addHere = () => { form.name.value = q; form.name.focus(); window.scrollTo({ top: form.name.getBoundingClientRect().top + scrollY - 100, behavior: 'smooth' }); };
    result.replaceChildren(...(!q || exact ? [] : shown.length
      ? [el('div', { class: 'muted' }, `找到 ${shown.length} 個名稱相近的地點。要找的是別的地方？`, el('button', { class: 'btn small', onclick: addHere }, `＋ 新增「${q}」`))]
      : [el('div', { class: 'notice warn' }, `地點庫裡沒有「${q}」。`, el('button', { class: 'btn small', onclick: addHere }, '＋ 新增這個地點'))]));
    if (!places.length) { listBox.replaceChildren(el('p', { class: 'muted' }, '還沒有任何地點。可以用下面的表單新增，或一次貼上很多個。')); return; }
    listBox.replaceChildren(...(shown.length ? shown.map(placeCard) : [el('p', { class: 'muted' }, '沒有符合的地點')]));
  }

  // ---------- 新增／修改 ----------
  let editing = null;
  const form = {
    name: el('input', { type: 'text', placeholder: '例如：台灣滷味博物館' }),
    type: el('select', {}, ...Object.entries(TYPES).map(([k, t]) => el('option', { value: k }, `${t.icon} ${t.label}（${t.note}）`))),
    note: el('input', { type: 'text', placeholder: '（選填）例如：週二有開、要預約、離學校 40 分鐘' }),
    dates: el('input', { type: 'text', placeholder: '（選填）去過的日期，例如：115/9/29、115/10/13' }),
  };
  form.type.value = 'indoor';
  const formTitle = el('h2', {}, '➕ 新增地點');
  const cancelBtn = el('button', { class: 'btn', hidden: true }, '取消修改');
  const formMsg = el('div');
  function resetForm() { editing = null; form.name.value = ''; form.note.value = ''; form.dates.value = ''; form.type.value = 'indoor'; formTitle.textContent = '➕ 新增地點'; cancelBtn.hidden = true; formMsg.replaceChildren(); }
  function fillForm(p) {
    editing = p.id; form.name.value = p.name; form.type.value = p.type || 'mixed'; form.note.value = p.note || '';
    form.dates.value = (p.visits || []).map(toROC).join('、'); formTitle.textContent = `✏️ 修改：${p.name}`; cancelBtn.hidden = false;
    formTitle.scrollIntoView({ behavior: 'smooth' });
  }
  cancelBtn.addEventListener('click', resetForm);
  const saveBtn = el('button', { class: 'btn primary' }, '儲存');
  saveBtn.addEventListener('click', async () => {
    const name = form.name.value.trim();
    if (!name) { formMsg.replaceChildren(el('div', { class: 'notice danger' }, '請填地點名稱')); return; }
    const dup = findPlace(places, name);
    if (dup && dup.id !== editing) { formMsg.replaceChildren(el('div', { class: 'notice danger' }, `「${dup.name}」已經在地點庫裡了，請直接搜尋它，再按「＋ 記一次去過」。`)); return; }
    const visits = parseDates(form.dates.value);
    if (form.dates.value.trim() && !visits.length) { formMsg.replaceChildren(el('div', { class: 'notice danger' }, '看不懂去過的日期，請寫成 115/9/29 這樣（多個用頓號分開）')); return; }
    const old = places.find(p => p.id === editing) || {};
    await store.save('places', { ...old, name, type: form.type.value, note: form.note.value.trim(), visits, needsType: false });
    toast(editing ? '已修改' : '已新增');
    resetForm();
    await refresh();
  });

  // ---------- 一次貼上多個 ----------
  const bulk = el('textarea', { placeholder: '一行一個，用逗號分開：地點,室內或室外,去過的日期\n台灣滷味博物館,室內,115/9/29\n高雄市立總圖,室內,115/8/4;115/3/10\n愛河河堤,室外', style: 'min-height:130px' });
  const bulkMsg = el('div');
  const typeFrom = (s) => (/室內外|都有|兩|混/.test(s) ? 'mixed' : /內/.test(s) ? 'indoor' : /外/.test(s) ? 'outdoor' : null);
  const addBulk = el('button', { class: 'btn primary' }, '加入這些地點');
  addBulk.addEventListener('click', async () => {
    const lines = bulk.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let added = 0, merged = 0; const problems = [];
    let current = [...places];
    for (const [i, line] of lines.entries()) {
      const [name, t, ...rest] = line.split(/[,，\t]/).map(x => x.trim());
      if (!name) continue;
      if (/^地點$|^名稱$/.test(name)) continue; // 標題列
      const type = typeFrom(t || '');
      if (!type) { problems.push(`第 ${i + 1} 行「${name}」：請寫「室內」「室外」或「室內外」（它是什麼？）`); continue; }
      const visits = parseDates(rest.join(';'));
      const hit = findPlace(current, name);
      if (hit) { const merged1 = { ...hit, type, visits: [...new Set([...(hit.visits || []), ...visits])].sort(), needsType: false }; await store.save('places', merged1); current = current.map(p => p.id === hit.id ? merged1 : p); merged++; }
      else { const s = await store.save('places', { name, type, note: '', visits, needsType: false }); current.push(s); added++; }
    }
    bulkMsg.replaceChildren(el('div', { class: problems.length ? 'notice warn' : 'notice ok' }, `新增 ${added} 個${merged ? `、更新 ${merged} 個（名稱相同，日期已合併）` : ''}。`, ...problems.map(m => el('div', {}, m))));
    if (added || merged) { bulk.value = ''; await refresh(); }
  });

  // ---------- 10 週計畫 ----------
  const planBox = el('div');
  const planMsg = el('div');
  async function savePlan(weeks) { plan = { id: 'current', start, weeks }; await store.save('plans', plan); }
  const autoBtn = el('button', { class: 'btn primary' }, '🗓️ 自動排 10 週');
  autoBtn.addEventListener('click', async () => {
    if (plan && !confirm('要重新排 10 週嗎？現在的安排會被換掉。')) return;
    const r = planTen(places, start);
    await savePlan(r.weeks);
    planMsg.replaceChildren(...r.warnings.map(w => el('div', { class: 'notice warn' }, w)));
    drawPlan();
  });
  function drawPlan() {
    if (!plan || !plan.weeks?.length) { planBox.replaceChildren(el('p', { class: 'muted' }, '還沒有排。按上面的「自動排 10 週」。')); return; }
    const m = byId();
    const opts = (cur, only) => [el('option', { value: '' }, '（空）'), ...places.filter(p => !only || only(p)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')).map(p => el('option', { value: p.id, selected: p.id === cur }, `${typeLabel(p.type).split(' ')[0]} ${p.name}`))];
    const rows = plan.weeks.map((w, i) => {
      const sunny = el('select', {}, ...opts(w.sunnyId));
      const rainy = el('select', {}, ...opts(w.rainyId, rainSafe));
      sunny.addEventListener('change', async () => { plan.weeks[i] = { ...w, sunnyId: sunny.value, rainyId: (m.get(sunny.value) && rainSafe(m.get(sunny.value))) ? sunny.value : w.rainyId }; await savePlan(plan.weeks); drawPlan(); });
      rainy.addEventListener('change', async () => { plan.weeks[i] = { ...w, rainyId: rainy.value }; await savePlan(plan.weeks); drawPlan(); });
      const sp = m.get(w.sunnyId);
      const stale = sp && lastVisit(sp) ? `（上次 ${toROC(lastVisit(sp))}）` : (sp ? '（沒去過）' : '');
      return el('div', { class: 'topic plan-row' },
        el('div', { class: 'title' }, `第 ${w.week} 週　${toROC(w.date)}（二）`),
        el('div', { class: 'row' },
          el('div', {}, el('label', {}, '☀️ 天晴去'), sunny, el('div', { class: 'muted' }, stale)),
          el('div', {}, el('label', {}, '☔ 下雨去（室內）'), rainy)));
    });
    planBox.replaceChildren(...rows);
  }
  const copyPlan = el('button', { class: 'btn', onclick: async () => {
    if (!plan) { toast('還沒有排'); return; }
    const m = byId();
    const line = (id) => { const p = m.get(id); return p ? `${p.name}（${TYPES[p.type]?.label || '室內外'}）` : '（空）'; };
    const txt = [`【${toROC(plan.weeks[0].date)} 起 10 週踏查計畫】每週二 ${DEFAULT_DEPART} 出發，${DEFAULT_RETURN} 回到${DEFAULT_RETURN_PLACE}`, '',
      ...plan.weeks.map(w => `第${w.week}週 ${toROC(w.date)}\n  ☀️ ${line(w.sunnyId)}\n  ☔ ${line(w.rainyId)}`)].join('\n');
    toast(await copyText(txt) ? '已複製' : '複製失敗');
  } }, '📋 複製計畫');

  root.replaceChildren(...[
    el('h1', {}, '📍 踏查地點'),
    el('p', { class: 'muted' }, `每週二 ${DEFAULT_DEPART} 出發、${DEFAULT_RETURN} 回到${DEFAULT_RETURN_PLACE}。把去過的和新的地點存在這裡，打名字就知道什麼時候去過。`),
    el('div', { class: 'card' },
      el('div', { class: 'output-head' }, el('h2', {}, '🔍 查地點'), countEl),
      search, result, listBox),
    el('div', { class: 'card' },
      formTitle,
      el('label', {}, '地點名稱 *'), form.name,
      el('label', {}, '室內還是室外？'), form.type,
      el('p', { class: 'muted' }, '🏠 室內：下雨也能去　🌳 室外：要天晴　🏠🌳 室內外都有：下雨可以去室內的部分（例如園區、植物園）'),
      el('label', {}, '備註'), form.note,
      el('label', {}, '去過的日期'), form.dates,
      formMsg,
      el('div', { class: 'btns' }, saveBtn, cancelBtn)),
    el('div', { class: 'card' },
      el('h2', {}, '📋 一次貼上很多個'),
      el('p', { class: 'muted' }, '每行一個：地點,室內或室外,去過的日期（日期可以不寫，多個用分號分開）。名稱已經有的，會把日期合併進去。'),
      bulk, bulkMsg, el('div', { class: 'btns' }, addBulk)),
    el('div', { class: 'card' },
      el('h2', {}, '🗓️ 這個學季的 10 週計畫'),
      el('p', { class: 'muted' }, `從 ${toROC(tripDates(start)[0])} 開始，共 10 個週二。規則：沒去過的、最久沒去的優先；晴天地點不重複；室外不連續超過 2 週；下雨的備案一定是室內。每週都可以自己改。`),
      el('div', { class: 'btns', style: 'margin-top:0' }, autoBtn, copyPlan),
      planMsg, planBox),
  ].filter(Boolean));
  drawList(); drawPlan();
}
