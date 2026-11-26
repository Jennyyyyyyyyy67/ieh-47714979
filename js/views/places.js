// 📍 踏查地點：地點庫（室內／室外、去過的日期）＋自動排 10 週（晴天、雨天各一個）
import { el, toROC, copyText } from '../utils.js';
import { readXlsxBook } from './survey.js';
import {
  placeKey, TYPES, SEASONS, typeLabel, rainSafe, parseDates, lastVisit, visitSummary, findPlace, planTen, tripDates,
  quarterOf, seasonOfQuarter, findAnchor,
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
        el('div', {}, el('div', { class: 'title' }, p.name), el('span', { class: p.needsType ? 'tag warn' : 'tag' }, typeLabel(p.type)),
          p.transport ? el('span', { class: 'tag' }, p.transport === '捷運' ? '🚇 捷運' : '🚌 專車') : null,
          p.season && SEASONS[p.season] ? el('span', { class: 'tag' }, `${SEASONS[p.season].icon} ${SEASONS[p.season].label}`) : null,
          p.theme ? el('span', { class: 'tag' }, p.theme) : null,
          p.needsType ? el('span', { class: 'tag warn' }, '請確認室內／室外') : null),
        el('div', { class: 'btns', style: 'margin:0' }, visited, edit, del)),
      el('div', {}, visitSummary(p)),
      visits.length ? el('div', { class: 'muted' }, '去過的日子：', ...visits.map(v => el('span', { class: 'tag', title: '點一下刪除這一筆', style: 'cursor:pointer', onclick: async () => {
        if (!confirm(`刪除「${p.name}」${toROC(v)} 這一筆紀錄？`)) return;
        await store.save('places', { ...p, visits: (p.visits || []).filter(x => x !== v) });
        await refresh();
      } }, toROC(v)))) : null,
      p.desc || p.access ? el('div', { class: 'muted' }, [p.access, p.desc].filter(Boolean).join('｜')) : null,
      p.note ? el('div', { class: 'muted' }, `備註：${p.note}`) : null);
  }

  function drawList() {
    const q = search.value.trim();
    const key = q.toLowerCase();
    const shown = places
      .filter(p => !q || placeKey(p.name).includes(placeKey(q)) || [p.note, p.theme, p.desc, p.access].join(' ').toLowerCase().includes(key))
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
    transport: el('select', {}, el('option', { value: '' }, '（不確定）'), el('option', { value: '捷運' }, '🚇 捷運可以到'), el('option', { value: '專車' }, '🚌 要坐專車')),
    season: el('select', {}, el('option', { value: '' }, '（都可以）'), ...Object.entries(SEASONS).map(([k, v]) => el('option', { value: k }, `${v.icon} ${v.label}`))),
  };
  form.type.value = 'indoor';
  const formTitle = el('h2', {}, '➕ 新增地點');
  const cancelBtn = el('button', { class: 'btn', hidden: true }, '取消修改');
  const formMsg = el('div');
  function resetForm() { editing = null; form.name.value = ''; form.note.value = ''; form.dates.value = ''; form.type.value = 'indoor'; form.transport.value = ''; form.season.value = ''; formTitle.textContent = '➕ 新增地點'; cancelBtn.hidden = true; formMsg.replaceChildren(); }
  function fillForm(p) {
    editing = p.id; form.name.value = p.name; form.type.value = p.type || 'mixed'; form.note.value = p.note || ''; form.transport.value = p.transport || ''; form.season.value = p.season || '';
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
    await store.save('places', { ...old, name, type: form.type.value, transport: form.transport.value, season: form.season.value, note: form.note.value.trim(), visits, needsType: false });
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

  // ---------- 匯入 Excel（整理好的地點檔，也可以有「本季行程」工作表） ----------
  const importInput = el('input', { type: 'file', accept: '.xlsx,.xls', hidden: true });
  const importMsg = el('div');
  const toType = (v) => (/室內外|都有|兩/.test(v) ? 'mixed' : /室內/.test(v) ? 'indoor' : /室外|戶外/.test(v) ? 'outdoor' : '');
  const toTransport = (v) => (/捷運|輕軌/.test(v) ? '捷運' : /專車|汽車|遊覽車|自車/.test(v) ? '專車' : '');
  const toSeason = (v) => (/夏|第一|第四/.test(v) ? 'summer' : /秋|冬|第二|第三/.test(v) ? 'winter' : '');
  function table(rows, must) {
    const h = rows.findIndex(r => r.some(c => must.test(c)));
    if (h < 0) return null;
    const head = rows[h];
    const col = (re) => head.findIndex(c => re.test(c));
    return { rows: rows.slice(h + 1), col };
  }
  importInput.addEventListener('change', async () => {
    const f = importInput.files[0];
    importInput.value = '';
    if (!f) return;
    importMsg.replaceChildren(el('div', { class: 'muted' }, '讀取中…'));
    let book;
    try { book = await readXlsxBook(f); } catch (e) { importMsg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); return; }
    const names = Object.keys(book);
    const placeSheet = names.find(n => /地點/.test(n)) || names[0];
    const t = table(book[placeSheet] || [], /地點名稱|^地點$/);
    if (!t) { importMsg.replaceChildren(el('div', { class: 'notice danger' }, '這個檔案找不到「地點名稱」這一欄。')); return; }
    const c = { name: t.col(/地點名稱|^地點$/), type: t.col(/室內外/), transport: t.col(/^交通$|交通方式/), season: t.col(/學季|季節/), theme: t.col(/主題/),
      access: t.col(/交通說明|捷運站|怎麼去/), desc: t.col(/特色|參訪型態/), dates: t.col(/去過/), note: t.col(/備註/), check: t.col(/需要確認/) };
    const get = (r, k) => (c[k] >= 0 ? String(r[c[k]] || '').trim() : '');
    let current = [...places];
    const toSave = new Map();
    let added = 0, merged = 0;
    for (const r of t.rows) {
      const name = get(r, 'name');
      if (!name) continue;
      const row = { type: toType(get(r, 'type')), transport: toTransport(get(r, 'transport')), season: toSeason(get(r, 'season')),
        theme: get(r, 'theme'), access: get(r, 'access'), desc: get(r, 'desc'), note: get(r, 'note') };
      const visits = parseDates(get(r, 'dates'));
      const needsType = /室內外/.test(get(r, 'check')) || !row.type;
      const hit = findPlace(current, name) || toSave.get(placeKey(name));
      const filled = Object.fromEntries(Object.entries(row).filter(([, v]) => v));
      const item = hit
        ? { ...hit, ...filled, visits: [...new Set([...(hit.visits || []), ...visits])].sort(), needsType: hit.needsType && needsType }
        : { name, type: row.type || 'mixed', ...filled, visits, needsType };
      if (hit) merged++; else added++;
      toSave.set(placeKey(name), item);
      if (hit && hit.id) current = current.map(p => (p.id === hit.id ? item : p));
    }
    const list = [...toSave.values()];
    for (let i = 0; i < list.length; i += 300) await store.saveMany('places', list.slice(i, i + 300));
    places = await store.list('places');
    const lines = [`✅ 匯入完成：新增 ${added} 個地點、更新 ${merged} 個（名稱相同的，去過的日期會合併，不會重複）。`];
    // 本季行程
    const planSheet = names.find(n => /本季|行程/.test(n));
    const pt = planSheet ? table(book[planSheet], /週次|^週$/) : null;
    if (pt) {
      const wc = pt.col(/週次|^週$/), pc = pt.col(/地點/), bc = pt.col(/預約/);
      const dates = tripDates(start);
      const weeks = dates.map((d, i) => ({ ...(plan?.weeks?.[i] || {}), week: i + 1, date: d }));
      let n = 0;
      const missing = [];
      for (const r of pt.rows) {
        const w = Number(String(r[wc] || '').replace(/\D/g, ''));
        const p = findPlace(places, r[pc] || '');
        if (w && w <= 10 && !p && String(r[pc] || '').trim()) missing.push(`第 ${w} 週「${String(r[pc]).trim()}」`);
        if (!w || w > 10 || !p) continue;
        weeks[w - 1] = { ...weeks[w - 1], sunnyId: p.id, rainyId: rainSafe(p) ? p.id : (weeks[w - 1].rainyId || ''), chosen: 'sunny', booked: /是|✓|v|完成|已/i.test(String(r[bc] || '')) };
        n++;
      }
      if (n && (!plan || confirm(`要用檔案裡「本季行程」的 ${n} 週，換掉現在的 10 週計畫嗎？`))) { await savePlan(weeks); lines.push(`🗓️ 已匯入本季行程 ${n} 週（標「已預約」的也一起勾好了）。`); }
      if (missing.length) lines.push(`⚠️ 這幾週的地點在地點庫裡找不到，沒有排進去，請自己選：${missing.join('、')}`);
    }
    importMsg.replaceChildren(el('div', { class: 'notice ok' }, ...lines.map(l => el('div', {}, l))));
    toast('匯入完成');
    drawList(); drawPlan();
  });

  // ---------- 10 週計畫 ----------
  const planBox = el('div');
  const planMsg = el('div');
  const remindBox = el('div');
  /** 提醒：下一次踏查如果在 8 天內，還沒決定天氣或還沒預約，就提醒 */
  function drawRemind() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const next = (plan?.weeks || []).find(w => new Date(`${w.date}T12:00:00`) >= today);
    if (!next) { remindBox.replaceChildren(); return; }
    const days = Math.round((new Date(`${next.date}T12:00:00`) - today) / 86400000);
    if (days > 8) { remindBox.replaceChildren(); return; }
    const m = byId();
    const issues = [];
    if (!next.chosen) issues.push('還沒決定去天晴或下雨的地點');
    if (!next.booked) issues.push('還沒標記已預約');
    const sp = m.get(next.sunnyId), rp = m.get(next.rainyId);
    remindBox.replaceChildren(el('div', { class: issues.length ? 'notice warn' : 'notice ok' },
      `📅 下一次踏查：${toROC(next.date)}（二）${days === 0 ? '就是今天' : `，還有 ${days} 天`}。天晴去 ${sp?.name || '（空）'}、下雨去 ${rp?.name || '（空）'}。`,
      el('div', {}, issues.length ? `⚠️ ${issues.join('、')}。請看天氣預報決定，並先跟對方預約。` : '✅ 已經決定、也預約好了。')));
  }
  async function savePlan(weeks) { plan = { id: 'current', start, weeks }; await store.save('plans', plan); }
  const anchorCb = el('input', { type: 'checkbox', checked: true });
  const quarter = quarterOf(start), season = seasonOfQuarter(quarter);
  const autoBtn = el('button', { class: 'btn primary' }, '🗓️ 自動排 10 週');
  autoBtn.addEventListener('click', async () => {
    if (plan && !confirm('要重新排 10 週嗎？現在的安排會被換掉。')) return;
    const anchor = anchorCb.checked ? findAnchor(places) : null;
    if (anchorCb.checked && !anchor) toast('地點庫裡沒有「總圖」，第 1、5、9 週就照一般方式排');
    const r = planTen(places, start, { anchorId: anchor?.id || '' });
    await savePlan(r.weeks);
    planMsg.replaceChildren(...r.warnings.map(w => el('div', { class: 'notice warn' }, w)));
    drawPlan();
  });
  function drawPlan() {
    drawRemind();
    if (!plan || !plan.weeks?.length) { planBox.replaceChildren(el('p', { class: 'muted' }, '還沒有排。按上面的「自動排 10 週」。')); return; }
    const m = byId();
    const opts = (cur, only) => [el('option', { value: '' }, '（空）'), ...places.filter(p => !only || only(p)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')).map(p => el('option', { value: p.id, selected: p.id === cur }, `${typeLabel(p.type).split(' ')[0]} ${p.name}`))];
    const rows = plan.weeks.map((w, i) => {
      const sunny = el('select', {}, ...opts(w.sunnyId));
      const rainy = el('select', {}, ...opts(w.rainyId, rainSafe));
      sunny.addEventListener('change', async () => { plan.weeks[i] = { ...w, sunnyId: sunny.value, rainyId: (m.get(sunny.value) && rainSafe(m.get(sunny.value))) ? sunny.value : w.rainyId }; await savePlan(plan.weeks); drawPlan(); });
      rainy.addEventListener('change', async () => { plan.weeks[i] = { ...w, rainyId: rainy.value }; await savePlan(plan.weeks); drawPlan(); });
      const booked = el('input', { type: 'checkbox', checked: !!w.booked });
      booked.addEventListener('change', async () => { plan.weeks[i] = { ...w, booked: booked.checked }; await savePlan(plan.weeks); drawPlan(); });
      const chosen = el('select', {},
        el('option', { value: '' }, '還沒決定'),
        el('option', { value: 'sunny', selected: w.chosen === 'sunny' }, '☀️ 決定去天晴的地點'),
        el('option', { value: 'rainy', selected: w.chosen === 'rainy' }, '☔ 決定去下雨的地點'));
      chosen.addEventListener('change', async () => { plan.weeks[i] = { ...w, chosen: chosen.value }; await savePlan(plan.weeks); drawPlan(); });
      const goPlace = m.get(w.chosen === 'rainy' ? w.rainyId : w.chosen === 'sunny' ? w.sunnyId : '');
      const sp = m.get(w.sunnyId);
      const stale = sp && lastVisit(sp) ? `（上次 ${toROC(lastVisit(sp))}）` : (sp ? '（沒去過）' : '');
      return el('div', { class: 'topic plan-row' },
        el('div', { class: 'title' }, `第 ${w.week} 週　${toROC(w.date)}（二）`),
        el('div', { class: 'row' },
          el('div', {}, el('label', {}, '☀️ 天晴去'), sunny, el('div', { class: 'muted' }, stale)),
          el('div', {}, el('label', {}, '☔ 下雨去（室內）'), rainy)),
        el('div', { class: 'row', style: 'margin-top:8px' },
          el('div', {}, el('label', {}, '📅 前一週看天氣預報後決定'), chosen),
          el('div', {}, el('label', { class: 'inline', style: 'margin-top:28px' }, booked, el('span', {}, '📞 已經預約／確認好了')))),
        goPlace ? el('div', { class: w.booked ? 'notice ok' : 'notice warn' }, `${w.chosen === 'rainy' ? '☔' : '☀️'} 決定去：${goPlace.name}（${TYPES[goPlace.type]?.label || '室內外'}）${w.booked ? '　✅ 已預約' : '　⚠️ 還沒標記已預約'}`) : null);
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
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '交通'), form.transport),
        el('div', {}, el('label', {}, '適合哪一季'), form.season)),
      el('label', {}, '備註'), form.note,
      el('label', {}, '去過的日期'), form.dates,
      formMsg,
      el('div', { class: 'btns' }, saveBtn, cancelBtn)),
    el('div', { class: 'card' },
      el('h2', {}, '📂 匯入地點 Excel'),
      el('p', { class: 'muted' }, '匯入整理好的地點檔（.xlsx）。名稱一樣的地點會合併，去過的日期不會重複。檔案裡如果有「本季行程」工作表，也會一起匯入 10 週計畫。'),
      el('div', { class: 'btns', style: 'margin-top:0' }, el('button', { class: 'btn primary', onclick: () => importInput.click() }, '📂 選擇 Excel 檔'), importInput),
      importMsg),
    el('div', { class: 'card' },
      el('h2', {}, '📋 一次貼上很多個'),
      el('p', { class: 'muted' }, '每行一個：地點,室內或室外,去過的日期（日期可以不寫，多個用分號分開）。名稱已經有的，會把日期合併進去。'),
      bulk, bulkMsg, el('div', { class: 'btns' }, addBulk)),
    el('div', { class: 'card' },
      el('h2', {}, '🗓️ 這個學季的 10 週計畫'),
      el('p', { class: 'muted' }, `從 ${toROC(tripDates(start)[0])} 開始，共 10 個週二。規則：沒去過的、最久沒去的優先；晴天地點不重複；室外不連續超過 2 週；下雨的備案一定是室內。每週都可以自己改。前一週看天氣預報、先預約好之後，在那一週選「決定去哪個」並勾「已預約」。`),
      quarter ? el('p', {}, `📅 這是第 ${quarter} 學季（${SEASONS[season].label.split('（')[0]}）：會優先排${season === 'summer' ? '「夏季推薦」的室內' : '「秋冬推薦」的戶外'}地點。`) : null,
      el('label', { class: 'inline' }, anchorCb, el('span', {}, '第 1、5、9 週固定去總圖（歷年都是這樣排）')),
      el('div', { class: 'btns', style: 'margin-top:0' }, autoBtn, copyPlan),
      remindBox, planMsg, planBox),
  ].filter(Boolean));
  drawList(); drawPlan();
}
