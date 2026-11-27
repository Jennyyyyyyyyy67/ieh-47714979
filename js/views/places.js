// 📍 踏查地點：地點庫（室內／室外、去過的日期）＋自動排 10 週（晴天、雨天各一個）
import { el, toROC, copyText } from '../utils.js';
import { currentRosterNames } from './survey.js';
import { spinnerButton } from './common.js';
import { callGemini, DEFAULT_MODEL } from '../gemini.js';
import { PLACES_SCHEMA, placesExtractPrompt } from '../prompts.js';
import { ACCEPT, readFiles, redactText, redactSummary, makeBatches } from '../doc-reader.js';
import {
  placeKey, TYPES, SEASONS, typeLabel, rainSafe, parseDate, parseDates, lastVisit, visitSummary, findPlace, planTen, tripDates,
  quarterOf, seasonOfQuarter, findAnchor, nameInText, TRIP_WEEKDAY,
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

  // ---------- 匯入檔案 ----------
  // 範本 Excel（有「地點名稱」欄）直接匯入；其他檔案（PDF、Word、PPT、照片、壓縮檔…）先在電腦上讀出文字、遮掉個資，
  // 再請 AI 找地點和日期，老師看過、勾選後才匯入。
  const importInput = el('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true });
  const importMsg = el('div');
  const aiBox = el('div');
  const toType = (v) => (/室內外|都有|兩/.test(v) ? 'mixed' : /室內/.test(v) ? 'indoor' : /室外|戶外/.test(v) ? 'outdoor' : '');
  const toTransport = (v) => (/捷運|輕軌/.test(v) ? '捷運' : /專車|汽車|遊覽車|自車/.test(v) ? '專車' : '');
  const toSeason = (v) => (/夏|第一|第四/.test(v) ? 'summer' : /秋|冬|第二|第三/.test(v) ? 'winter' : '');
  function table(rows, must) {
    const h = (rows || []).findIndex(r => r.some(c => must.test(c)));
    if (h < 0) return null;
    const head = rows[h];
    const col = (re) => head.findIndex(c => re.test(c));
    return { rows: rows.slice(h + 1), col };
  }

  /**
   * 把很多筆地點合併進地點庫（名稱一樣的合併，去過的日期不重複）。
   * overwrite=false（AI 找到的）：老師已經填好的欄位不會被蓋掉，只補空的欄位。
   */
  async function mergeRows(rows, { overwrite = true } = {}) {
    let current = [...places];
    const toSave = new Map();
    let added = 0, merged = 0;
    for (const row of rows) {
      const name = String(row.name || '').trim();
      if (!name) continue;
      const { name: _name, visits = [], needsType = !row.type, ...rest } = row;
      const filled = Object.fromEntries(Object.entries(rest).filter(([, v]) => v));
      const hit = findPlace(current, name) || toSave.get(placeKey(name));
      let item;
      if (!hit) item = { name, type: row.type || 'mixed', ...filled, visits: [...new Set(visits)].sort(), needsType };
      else {
        const add = overwrite ? filled : Object.fromEntries(Object.entries(filled).filter(([k]) => !hit[k] || (k === 'type' && hit.needsType && !needsType)));
        item = { ...hit, ...add, visits: [...new Set([...(hit.visits || []), ...visits])].sort(), needsType: !!hit.needsType && needsType };
      }
      if (hit) merged++; else added++;
      toSave.set(placeKey(name), item);
      if (hit && hit.id) current = current.map(p => (p.id === hit.id ? item : p));
    }
    const list = [...toSave.values()];
    for (let i = 0; i < list.length; i += 300) await store.saveMany('places', list.slice(i, i + 300));
    places = await store.list('places');
    return { added, merged };
  }

  /** 範本 Excel：地點工作表＋（有的話）本季行程工作表 */
  async function importTemplate(book) {
    const names = Object.keys(book);
    const placeSheet = names.find(n => table(book[n], /^地點名稱$/)) || names.find(n => table(book[n], /^地點$/));
    const t = table(book[placeSheet], /地點名稱|^地點$/);
    if (!t) throw new Error('這個檔案找不到「地點名稱」這一欄。');
    const c = { name: t.col(/地點名稱|^地點$/), type: t.col(/室內外/), transport: t.col(/^交通$|交通方式/), season: t.col(/學季|季節/), theme: t.col(/主題/),
      access: t.col(/交通說明|捷運站|怎麼去/), desc: t.col(/特色|參訪型態/), dates: t.col(/去過/), note: t.col(/備註/), check: t.col(/需要確認/) };
    const get = (r, k) => (c[k] >= 0 ? String(r[c[k]] || '').trim() : '');
    const rows = t.rows.filter(r => get(r, 'name')).map(r => {
      const type = toType(get(r, 'type'));
      return { name: get(r, 'name'), type, transport: toTransport(get(r, 'transport')), season: toSeason(get(r, 'season')),
        theme: get(r, 'theme'), access: get(r, 'access'), desc: get(r, 'desc'), note: get(r, 'note'),
        visits: parseDates(get(r, 'dates')), needsType: /室內外/.test(get(r, 'check')) || !type };
    });
    const { added, merged } = await mergeRows(rows);
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
    return lines;
  }

  importInput.addEventListener('change', async () => {
    const files = [...importInput.files];
    importInput.value = '';
    if (!files.length) return;
    aiBox.replaceChildren();
    const say = (t) => importMsg.replaceChildren(el('div', { class: 'muted' }, t));
    say('讀取中…');
    let read;
    try { read = await readFiles(files, say); }
    catch (e) { importMsg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); return; }
    const out = [];
    const templates = read.items.filter(i => i.kind === 'template');
    for (const it of templates) {
      try { out.push(el('div', { class: 'notice ok' }, el('strong', {}, `📗 ${it.source}`), ...(await importTemplate(it.book)).map(l => el('div', {}, l)))); }
      catch (e) { out.push(el('div', { class: 'notice danger' }, `${it.source}：${e.message}`)); }
    }
    if (read.skipped.length) {
      out.push(el('div', { class: 'notice warn' }, el('strong', {}, `⚠️ 有 ${read.skipped.length} 個檔案沒有讀到`),
        ...read.skipped.map(x => el('div', {}, `・${x.source}：${x.why}`))));
    }
    const aiItems = read.items.filter(i => i.kind === 'text' || i.kind === 'binary');
    if (!out.length && !aiItems.length) out.push(el('div', { class: 'notice danger' }, '沒有讀到任何內容。'));
    importMsg.replaceChildren(...out);
    if (templates.length) { toast('匯入完成'); drawList(); drawPlan(); }
    if (aiItems.length) drawAiStep(aiItems);
  });

  /** 第 2 步：給老師看要送給 AI 的內容（已遮個資），勾同意才送 */
  function drawAiStep(items) {
    const roster = currentRosterNames(ctx.settings);
    const prepared = items.map(it => (it.kind === 'text' ? { ...it, ...redactText(it.text, roster) } : it));
    const consent = el('input', { type: 'checkbox' });
    const goBtn = el('button', { class: 'btn primary', disabled: true }, `🤖 請 AI 找出地點（${prepared.length} 個檔案）`);
    const aiMsg = el('div');
    consent.addEventListener('change', () => { goBtn.disabled = !consent.checked; });
    const hasBinary = prepared.some(p => p.kind === 'binary');
    const list = prepared.map(p => {
      const hid = p.kind === 'text' ? redactSummary(p.counts) : '';
      const info = p.kind === 'binary'
        ? `${p.how}：沒辦法先遮掉個資，請確認裡面沒有學生資料`
        : [p.how, `${p.text.length} 字`, hid && `已遮掉：${hid}`, p.note].filter(Boolean).join('・');
      return el('details', { class: 'doc-item' },
        el('summary', {}, `${p.kind === 'binary' ? '📷' : '📄'} ${p.source}　`, el('span', { class: 'muted' }, info)),
        p.kind === 'text' ? el('pre', { class: 'doc-preview' }, p.text.length > 4000 ? `${p.text.slice(0, 4000)}\n…（後面還有 ${p.text.length - 4000} 字）` : p.text) : null);
    });
    aiBox.replaceChildren(el('div', { class: 'output-block' },
      el('h3', {}, `🤖 這 ${prepared.length} 個檔案要請 AI 幫忙找地點`),
      el('p', { class: 'muted' }, 'AI 會找出地點和去過的日期，先給你看過、勾選後才會存進地點庫。點開檔案，可以看要送給 AI 的內容（個資已經先遮掉）。'),
      ...list,
      el('div', { class: 'notice warn' },
        '⚠️ 內容會傳給 Google Gemini 讀取（免費版的資料，Google 可能拿去改進產品）。系統會先遮掉：問卷名單裡的學生名字、電話、Email、身分證、班級、○○老師，還有「禁足／座號／生日…」和看起來像名單的整行。但沒辦法保證 100% 遮乾淨，有學生名單的頁面，最好上傳前先刪掉。',
        hasBinary ? '　📷 掃描檔和照片沒辦法先遮，會整個傳過去。' : '',
        roster.length ? `　（已用問卷名單的 ${roster.length} 個名字幫忙遮）` : '　💡 先到「📊 問卷檢查」貼上學生名單（不用存），就能把名單裡的名字一起遮掉。'),
      el('label', { class: 'inline' }, consent, el('strong', {}, '我看過了，可以把這些內容傳給 Google Gemini 讀取')),
      el('div', { class: 'btns' }, goBtn),
      aiMsg));
    goBtn.addEventListener('click', () => runAi(prepared, goBtn, aiMsg));
  }

  /** 第 3 步：分批請 AI 找地點 */
  async function runAi(prepared, btn, msgBox) {
    const st = ctx.settings || {};
    if (!st.geminiKey) { msgBox.replaceChildren(el('div', { class: 'notice danger' }, '還沒設定 Gemini 鑰匙，請先到「⚙️ 設定」。')); return; }
    const batches = makeBatches(prepared);
    const done = spinnerButton(btn, 'AI 讀取中…');
    const found = [];
    const errors = [];
    const notPlaces = [];
    for (const [i, b] of batches.entries()) {
      msgBox.replaceChildren(el('div', { class: 'muted' }, `AI 讀取中…（第 ${i + 1} / ${batches.length} 批，檔案多的話要等一下）`));
      const parts = [{ text: placesExtractPrompt(b.binary ? { binarySource: b.binary.source } : { docs: b.docs }) }];
      if (b.binary) parts.push({ inline_data: { mime_type: b.binary.mime, data: b.binary.base64 } });
      try {
        const res = await callGemini({ apiKey: st.geminiKey, model: st.model || DEFAULT_MODEL, parts, schema: PLACES_SCHEMA, temperature: 0.1 });
        const srcKey = b.binary ? '' : placeKey(b.docs.map(d => d.text).join('\n'));
        const srcNames = b.binary ? [b.binary.source] : [...new Set(b.docs.map(d => d.source))];
        for (const p of res.places || []) found.push({ ...p, binary: !!b.binary, srcKey, srcNames });
        notPlaces.push(...(res.skipped || []));
      } catch (e) {
        errors.push(`${b.binary ? b.binary.source : b.docs.map(d => d.label).join('、')}：${e.message}`);
      }
    }
    done();
    msgBox.replaceChildren();
    drawReview(checkFound(found), errors, notPlaces);
  }

  /** 整理 AI 找到的：同名合併、日期檢查、原文找不找得到 */
  function checkFound(found) {
    const maxYear = new Date().getFullYear() + 1;
    const map = new Map();
    const clean = (v) => (v && v !== 'unknown' ? String(v).trim() : '');
    for (const f of found) {
      const name = String(f.name || '').replace(/^[「『"'\s]+|[」』"'\s]+$/g, '').trim();
      const k = placeKey(name);
      if (!k) continue;
      const dates = (f.dates || []).map(parseDate).filter(d => d && Number(d.slice(0, 4)) >= 2010 && Number(d.slice(0, 4)) <= maxYear);
      const cur = map.get(k) || { name, dates: [], type: '', typeFromDoc: false, transport: '', season: '', theme: '', access: '', desc: '', sources: new Set(), quotes: [], found: false, scan: false };
      cur.dates.push(...dates);
      if (!cur.type && clean(f.type)) { cur.type = clean(f.type); cur.typeFromDoc = !!f.typeFromDoc; }
      else if (clean(f.type) && f.typeFromDoc && !cur.typeFromDoc) { cur.type = clean(f.type); cur.typeFromDoc = true; }
      for (const key of ['transport', 'season', 'theme', 'access', 'desc']) if (!cur[key] && clean(f[key])) cur[key] = clean(f[key]);
      (f.srcNames.includes(f.source) ? [f.source] : f.srcNames).forEach(x => cur.sources.add(x));
      if (f.quote && cur.quotes.length < 2) cur.quotes.push(String(f.quote).slice(0, 60));
      if (f.binary) cur.scan = true;
      else if (nameInText(name, f.srcKey)) cur.found = true;
      map.set(k, cur);
    }
    return [...map.values()].map(c => {
      const dates = [...new Set(c.dates)].sort();
      return { ...c, dates, sources: [...c.sources], notFound: !c.found && !c.scan, notTuesday: dates.filter(d => new Date(`${d}T12:00:00`).getDay() !== TRIP_WEEKDAY) };
    }).sort((a, b) => Number(a.notFound) - Number(b.notFound) || a.name.localeCompare(b.name, 'zh-Hant'));
  }

  /** 第 4 步：老師檢查 AI 找到的地點，勾選後才匯入 */
  function drawReview(list, errors, notPlaces) {
    const box = el('div', { class: 'output-block' });
    const errBox = errors.length ? el('div', { class: 'notice danger' }, el('strong', {}, `有 ${errors.length} 批 AI 沒有讀成功（可以再按一次「請 AI 找出地點」）`), ...errors.map(e => el('div', {}, `・${e}`))) : null;
    if (!list.length) {
      box.append(el('div', { class: 'notice warn' }, 'AI 沒有找到任何踏查地點。'), ...(errBox ? [errBox] : []));
      aiBox.append(box);
      return;
    }
    const rows = list.map(f => {
      const cb = el('input', { type: 'checkbox', checked: !f.notFound, 'aria-label': `匯入 ${f.name}` });
      const nameIn = el('input', { type: 'text', value: f.name, 'aria-label': '地點名稱', 'data-name': f.name });
      const aiType = f.type || '';
      const exists = findPlace(places, f.name);
      // 地點庫裡已經有、而且老師確認過室內／室外的：顯示原本的，不讓 AI 的猜測蓋掉
      const locked = !!(exists && !exists.needsType && exists.type);
      const shown = locked ? exists.type : aiType;
      const typeSel = el('select', { 'aria-label': '室內或室外', disabled: locked, title: locked ? '地點庫裡已經確認過，要改請到地點卡片按「修改」' : null },
        ...[['', '❓ 不確定'], ['indoor', '🏠 室內'], ['outdoor', '🌳 室外'], ['mixed', '🏠🌳 室內外都有']].map(([v, t]) => el('option', { value: v, selected: v === shown }, t)));
      const tags = [
        el('span', { class: 'tag' }, exists ? (locked ? '已在地點庫：只會合併日期，室內／室外照原本的' : '已在地點庫：日期會合併') : '🆕 新地點'),
        f.notFound ? el('span', { class: 'tag warn' }, '⚠️ 原文找不到這個名字，可能是 AI 自己想的（預設不匯入）') : null,
        f.scan ? el('span', { class: 'tag warn' }, '📷 從掃描檔／照片讀的，請對照原檔') : null,
        f.notTuesday.length ? el('span', { class: 'tag warn' }, `⚠️ ${f.notTuesday.map(toROC).join('、')} 不是星期二，日期可能算錯了`) : null,
        !locked && aiType && !f.typeFromDoc ? el('span', { class: 'tag warn' }, '室內／室外是 AI 猜的') : null,
      ].filter(Boolean);
      const row = el('div', { class: `ai-row${f.notFound ? ' doubt' : ''}` },
        el('div', { class: 'ai-row-head' }, cb, nameIn, typeSel),
        el('div', { class: 'muted' }, f.dates.length ? `去過：${f.dates.map(toROC).join('、')}` : '文件沒寫日期（會記成「還沒去過」）'),
        el('div', {}, ...tags),
        el('div', { class: 'muted small' }, `來源：${f.sources.join('、')}`, f.quotes[0] ? `｜原文：「${f.quotes[0]}」` : ''));
      return { f, cb, nameIn, typeSel, row };
    });
    const go = el('button', { class: 'btn primary' });
    const refreshCount = () => { const n = rows.filter(r => r.cb.checked).length; go.textContent = `✅ 匯入勾選的 ${n} 個地點`; go.disabled = !n; };
    rows.forEach(r => r.cb.addEventListener('change', refreshCount));
    refreshCount();
    go.addEventListener('click', async () => {
      const pick = rows.filter(r => r.cb.checked && r.nameIn.value.trim());
      const done = spinnerButton(go, '匯入中…');
      const res = await mergeRows(pick.map(({ f, nameIn, typeSel }) => {
        const v = typeSel.value;
        return { name: nameIn.value.trim(), type: v, transport: f.transport, season: f.season, theme: f.theme, access: f.access, desc: f.desc,
          visits: f.dates, needsType: !v || (v === (f.type || '') && !f.typeFromDoc) };
      }), { overwrite: false });
      done();
      aiBox.replaceChildren(el('div', { class: 'notice ok' }, `✅ 匯入完成：新增 ${res.added} 個地點、更新 ${res.merged} 個（日期已合併）。沒勾的 ${rows.length - pick.length} 個沒有匯入。標「請確認室內／室外」的，記得到地點卡片按「修改」補上。`));
      toast('匯入完成');
      drawList(); drawPlan();
    });
    box.append(
      el('h3', {}, `🔎 AI 找到 ${list.length} 個地點，請檢查`),
      el('p', { class: 'muted' }, '名稱可以直接改；室內／室外可以重選。打勾的才會匯入。黃色標籤是要特別注意的地方。'),
      errBox || '',
      el('div', { class: 'btns', style: 'margin-top:0' },
        el('button', { class: 'btn small', onclick: () => { rows.forEach(r => { r.cb.checked = true; }); refreshCount(); } }, '全選'),
        el('button', { class: 'btn small', onclick: () => { rows.forEach(r => { r.cb.checked = false; }); refreshCount(); } }, '全部不選')),
      ...rows.map(r => r.row),
      notPlaces.length ? el('details', {}, el('summary', {}, `AI 看到、但不算踏查地點的（${notPlaces.length}）`), el('div', { class: 'muted' }, notPlaces.join('、'))) : '',
      el('div', { class: 'btns' }, go));
    aiBox.append(box);
  }

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
      el('h2', {}, '📂 匯入地點檔案'),
      el('p', { class: 'muted' }, '可以一次選很多個：Excel、PDF、Word（.docx）、PowerPoint（.pptx）、文字檔、照片、壓縮檔（.zip）都可以。名稱一樣的地點會合併，去過的日期不會重複。'),
      el('ul', { class: 'muted' },
        el('li', {}, '📗 照範本的 Excel（有「地點名稱」欄）：直接匯入。有「本季行程」工作表的話，也會一起匯入 10 週計畫。'),
        el('li', {}, '🤖 其他檔案：先在你的電腦上讀出文字、遮掉個資，再請 AI 找出地點和日期。AI 找到的會先給你看過，勾選後才匯入。')),
      el('div', { class: 'btns', style: 'margin-top:0' }, el('button', { class: 'btn primary', onclick: () => importInput.click() }, '📂 選擇檔案'), importInput),
      importMsg, aiBox),
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
