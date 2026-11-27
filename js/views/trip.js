// 🚌 每週二踏查：行程表 → 照片 → AI 看照片（老師核對）→ 問卷連結 → 產生文案 → 檢查清單 → 複製
import { el, todayISO, toROC, surveyTitle, resizeImage, fileToBase64, formatBytes, quarterWeek, weekRanges } from '../utils.js';
import { callGemini, DEFAULT_MODEL, guessFastModel } from '../gemini.js';
import { PHOTO_SCHEMA, photoPrompt, tripGroups, tripSchemaFor, tripPrompt } from '../prompts.js';
import { publishChecklist, outputBlock, spinnerButton } from './common.js';
import { recordVisit } from './places.js';
import { findPlace, visitSummary, typeLabel, DEFAULT_DEPART, DEFAULT_RETURN, DEFAULT_RETURN_PLACE, tripDates, DEFAULT_QUARTER_START } from '../places-logic.js';

const MAX_PHOTOS = 12;
const MAMMOTH_URL = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('無法載入 Word 讀取工具，請改成複製貼上文字。'));
    document.head.append(s);
  });
}

function newState() {
  return {
    id: null, date: todayISO(), place: '', title: '', grades: '',
    scheduleText: '',
    docs: [],              // 只放在記憶體：PDF／圖片檔的行程表、學習單
    photos: [],            // 只放在記憶體：縮小後的照片
    consent: false,
    survey: { g12: '', g38: '', smallRange: '1-3', bigRange: '4-6' }, // g12＝小小孩連結、g38＝大孩子連結
    photoNotes: [],        // [{seen, highlights, uncertain, privacy}]
    notesConfirmed: false,
    outputs: { line: true, survey: true, fb: true, ig: true, record: true, lineQuestions: false },
    result: null,
    texts: {},
  };
}

// 這次使用期間保留（換分頁回來還在）；照片不會被存進資料庫
let S = newState();
/** 踏查頁現在選的照片（只在記憶體）。「本週發送」可以直接拿來發 IG／FB */
export const currentTripPhotos = () => S.photos || [];

export function assembleTexts(S, r) {
  const texts = {};
  const qs = (r.home_questions || []).slice(0, 2);
  if (S.outputs.line) {
    const parts = ['【戶外踏查】', String(r.line_title || '').replace(/^【戶外踏查】\s*/, '').trim(), '', String(r.line_body || '').trim()];
    if (S.outputs.lineQuestions && qs.length) parts.push('', '💬 回家可以問問孩子：', ...qs.map(q => `・${q}`));
    if (S.survey.g12) parts.push('', `小小孩問卷（${S.survey.smallRange}年級）：`, S.survey.g12);
    if (S.survey.g38) parts.push('', `大孩子問卷（${S.survey.bigRange}年級）：`, S.survey.g38);
    if (S.survey.g12 || S.survey.g38) parts.push('', '✨✨請提醒孩子們今天晚上12點前要送出問卷喔！');
    texts.line = parts.join('\n');
  }
  if (S.outputs.survey) {
    texts.survey = [
      '📋 問卷標題（複製到 Google 表單）',
      `小小孩：${surveyTitle(S.date, '小小孩', S.place)}`,
      `大孩子：${surveyTitle(S.date, '大孩子', S.place)}`,
      '',
      '💬 建議放進問卷的題目（回家可以問孩子的問題）：',
      ...(qs.length ? qs.map((q, i) => `${i + 1}. ${q}`) : ['（AI 沒有產生題目，請老師自行補上）']),
    ].join('\n');
  }
  if (S.outputs.fb) texts.fb = (r.fb_post || '').trim();
  if (S.outputs.ig) {
    const tags = (r.ig_hashtags || []).map(t => '#' + String(t).replace(/^#+/, '').replace(/\s+/g, '')).filter(t => t.length > 1);
    texts.ig = `${(r.ig_caption || '').trim()}\n\n${tags.join(' ')}`.trim();
  }
  if (S.outputs.record) {
    const lines = [
      '【教學紀錄】',
      `日期：${toROC(S.date)}（${S.date}）`,
      `地點：${S.place}`,
      `活動名稱：${S.title || '戶外踏查'}`,
      `參加年級：${S.grades || '（未填）'}`,
      '',
      `學習重點：${(r.class_connection || '').trim()}`,
      '',
      '活動過程：',
      (r.teaching_process || '').trim(),
      '',
      '教學省思：',
      '',
      '',
    ];
    texts.record = lines.join('\n');
  }
  return texts;
}

export async function renderTrip(root, ctx) {
  const { store, toast } = ctx;
  if (ctx.params?.trip) {
    const t = ctx.params.trip;
    S = { ...newState(), ...t, docs: [], photos: [], consent: false };
    ctx.params = null;
  }
  const settings = ctx.settings || {};
  // 新的一次：小小孩／大孩子的年級範圍沿用上一次
  if (!S.id && !S.texts?.line) {
    const last = (await store.list('trips'))[0];
    if (last?.survey?.smallRange) S.survey.smallRange = last.survey.smallRange;
    if (last?.survey?.bigRange) S.survey.bigRange = last.survey.bigRange;
  }
  const places = await store.list('places');
  const plan = (await store.list('plans')).find(p => p.id === 'current') || null;
  // 新的一次：行程表先帶入每週固定的出發和回來時間
  const depart = settings.departTime || DEFAULT_DEPART, back = settings.returnTime || DEFAULT_RETURN, backAt = settings.returnPlace || DEFAULT_RETURN_PLACE;
  if (!S.id && !S.scheduleText.trim()) S.scheduleText = `${depart} 從${backAt}出發\n${back} 回到${backAt}`;
  let namesForCheck = '';      // 老師臨時輸入的學生名字：只放在記憶體，不儲存
  const getNames = () => namesForCheck.split(/[\s,，、]+/).filter(Boolean);

  const save = async () => {
    const { docs, photos, consent, ...rest } = S; // 照片和附件檔案不儲存
    const saved = await store.save('trips', rest);
    S.id = saved.id;
    return saved;
  };

  // ===== 第 1 步：基本資料＋行程表／學習單 =====
  const f = {
    date: el('input', { type: 'date', value: S.date }),
    place: el('input', { type: 'text', value: S.place, placeholder: '例如：高雄市立圖書館總館', list: 'placeList', autocomplete: 'off' }),
    title: el('input', { type: 'text', value: S.title, placeholder: '例如：建築與視野探索（可留空）' }),
    grades: el('input', { type: 'text', value: S.grades, placeholder: '例如：1-8年級' }),
    schedule: el('textarea', { placeholder: '把行程表、學習單的文字貼在這裡。\n例如：\n09:00 出發\n09:30 主題書區導覽\n10:30 用分類號找書、交換閱讀\n11:30 學習單分享', style: 'min-height:160px' }),
  };
  f.schedule.value = S.scheduleText;
  f.date.addEventListener('change', () => { S.date = f.date.value; applyWeekRanges(true); autoFillPlace(); drawPlaceHint(); drawSurveyTitles(); });
  const placeHint = el('div', { class: 'muted' });
  const placeList = el('datalist', { id: 'placeList' }, ...places.map(p => el('option', { value: p.name }, typeLabel(p.type))));
  /** 計畫裡這一天已經決定好去哪裡，就先填進來（不會蓋掉老師自己打的） */
  function autoFillPlace() {
    const w = plan?.weeks?.find(x => x.date === S.date);
    const id = w?.chosen === 'rainy' ? w.rainyId : w?.chosen === 'sunny' ? w.sunnyId : '';
    const p = places.find(x => x.id === id);
    if (p && !f.place.value.trim()) { f.place.value = p.name; S.place = p.name; }
  }
  function drawPlaceHint() {
    const hit = findPlace(places, f.place.value);
    const planWeek = plan?.weeks?.find(w => w.date === S.date);
    const pm = new Map(places.map(p => [p.id, p]));
    const nodes = [];
    if (hit) nodes.push(el('div', { class: hit.visits?.length ? 'notice warn' : 'notice ok' }, `📍 ${typeLabel(hit.type)}｜${visitSummary(hit)}`));
    else if (f.place.value.trim()) nodes.push(el('div', { class: 'muted' }, '這個地點還不在地點庫裡，產生文案時會自動加進去（室內外要到「📍 踏查地點」補）。'));
    if (planWeek?.chosen) {
      const cp = pm.get(planWeek.chosen === 'rainy' ? planWeek.rainyId : planWeek.sunnyId);
      if (cp) nodes.push(el('div', { class: planWeek.booked ? 'notice ok' : 'notice warn' }, `前一週已決定：${planWeek.chosen === 'rainy' ? '☔ 下雨' : '☀️ 天晴'}去「${cp.name}」${planWeek.booked ? '（✅ 已預約）' : '（⚠️ 還沒標記已預約）'}`));
    }
    if (planWeek) {
      const mk = (label, id) => { const p = pm.get(id); return p ? el('button', { class: 'btn small', onclick: () => { f.place.value = p.name; S.place = p.name; drawPlaceHint(); drawSurveyTitles(); } }, `${label} ${p.name}`) : null; };
      nodes.push(el('div', { class: 'btns', style: 'margin-top:6px' }, el('span', { class: 'muted' }, `本週計畫：`), mk('☀️ 天晴', planWeek.sunnyId), planWeek.rainyId !== planWeek.sunnyId ? mk('☔ 下雨', planWeek.rainyId) : null));
    }
    placeHint.replaceChildren(...nodes.filter(Boolean));
  }
  f.place.addEventListener('input', () => { S.place = f.place.value; drawPlaceHint(); drawSurveyTitles(); });
  f.title.addEventListener('input', () => { S.title = f.title.value; });
  f.grades.addEventListener('input', () => { S.grades = f.grades.value; });
  f.schedule.addEventListener('input', () => { S.scheduleText = f.schedule.value; });

  const docInput = el('input', { type: 'file', accept: '.pdf,.txt,.docx,image/*', multiple: true, hidden: true });
  const docList = el('div');
  const drawDocs = () => docList.replaceChildren(...S.docs.map((d, i) => el('div', { class: 'list-item' },
    el('span', {}, `📄 ${d.name}（${formatBytes(d.bytes)}，AI 會直接讀這個檔案）`),
    el('button', { class: 'btn small danger', onclick: () => { S.docs.splice(i, 1); drawDocs(); } }, '移除'),
  )));
  docInput.addEventListener('change', async () => {
    for (const file of docInput.files) {
      try {
        if (/\.txt$/i.test(file.name) || file.type === 'text/plain') {
          f.schedule.value = (f.schedule.value ? f.schedule.value + '\n\n' : '') + await file.text();
        } else if (/\.docx$/i.test(file.name)) {
          if (!window.mammoth) await loadScript(MAMMOTH_URL);
          const { value } = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
          f.schedule.value = (f.schedule.value ? f.schedule.value + '\n\n' : '') + value.trim();
        } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
          if (file.size > 15 * 1024 * 1024) throw new Error(`「${file.name}」超過 15MB，太大了`);
          S.docs.push({ name: file.name, mimeType: 'application/pdf', base64: await fileToBase64(file), bytes: file.size });
        } else if (file.type.startsWith('image/')) {
          const img = await resizeImage(file, 1600, 0.85);
          S.docs.push({ name: file.name, mimeType: img.mimeType, base64: img.base64, bytes: img.bytes });
        } else {
          throw new Error(`「${file.name}」的格式不支援，請用 PDF、Word(.docx)、文字檔或照片`);
        }
      } catch (e) { toast(e.message); }
    }
    S.scheduleText = f.schedule.value;
    docInput.value = '';
    drawDocs();
  });

  // ===== 第 2 步：照片 =====
  const consentCb = el('input', { type: 'checkbox', checked: S.consent });
  const photoInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const pickBtn = el('button', { class: 'btn primary', disabled: !S.consent, onclick: () => photoInput.click() }, '📷 選擇照片');
  consentCb.addEventListener('change', () => { S.consent = consentCb.checked; pickBtn.disabled = !S.consent; });
  const photoGrid = el('div', { class: 'photos' });
  const photoInfo = el('div', { class: 'muted' });
  const drawPhotos = () => {
    photoGrid.replaceChildren(...S.photos.map((p, i) => el('div', { class: 'photo' },
      el('img', { src: p.dataUrl, alt: `照片 ${i + 1}` }),
      el('button', { class: 'x', title: '移除這張', 'aria-label': `移除照片 ${i + 1}`, onclick: () => {
        S.photos.splice(i, 1); S.photoNotes = []; S.notesConfirmed = false; drawPhotos(); drawReview(); updateLocks();
      } }, '✕'),
      el('div', { class: 'meta' }, `照片 ${i + 1}｜${formatBytes(p.originalBytes)} → ${formatBytes(p.bytes)}`),
    )));
    photoInfo.textContent = S.photos.length ? `已選 ${S.photos.length} 張（最多 ${MAX_PHOTOS} 張）。照片已在你的裝置上縮小，只放在這個畫面裡，不會存進資料庫。` : '';
  };
  photoInput.addEventListener('change', async () => {
    const files = [...photoInput.files];
    if (S.photos.length + files.length > MAX_PHOTOS) toast(`最多 ${MAX_PHOTOS} 張，多的會略過`);
    for (const file of files.slice(0, MAX_PHOTOS - S.photos.length)) {
      try { S.photos.push(await resizeImage(file)); }
      catch (e) { toast(e.message); }
    }
    photoInput.value = '';
    S.photoNotes = []; S.notesConfirmed = false;
    drawPhotos(); drawReview(); updateLocks();
  });

  // ===== 第 3 步：AI 看照片，老師核對 =====
  const analyzeBtn = el('button', { class: 'btn primary' }, '🔍 請 AI 看照片');
  const reviewBox = el('div');
  const confirmCb = el('input', { type: 'checkbox', checked: S.notesConfirmed });
  confirmCb.addEventListener('change', () => { S.notesConfirmed = confirmCb.checked; updateLocks(); });
  const confirmRow = el('label', { class: 'inline' }, confirmCb, el('strong', {}, '我已經核對過每張照片的描述（看錯的地方已修改或刪除）'));

  const docParts = () => S.docs.map(d => ({ inline_data: { mime_type: d.mimeType, data: d.base64 } }));
  analyzeBtn.addEventListener('click', async () => {
    if (!S.photos.length) { toast('請先選照片'); return; }
    const done = spinnerButton(analyzeBtn, 'AI 正在看照片…');
    try {
      const parts = photoPrompt({ trip: { ...S, photoCount: S.photos.length }, docParts: docParts() });
      S.photos.forEach((p, i) => { parts.push({ text: `照片 ${i + 1}：` }, { inline_data: { mime_type: p.mimeType, data: p.base64 } }); });
      const res = await callGemini({ apiKey: settings.geminiKey, model: settings.model || DEFAULT_MODEL, parts, schema: PHOTO_SCHEMA, temperature: 0.2 });
      const byIndex = new Map((res.photos || []).map(p => [Number(p.index), p]));
      S.photoNotes = S.photos.map((_, i) => {
        const p = byIndex.get(i + 1) || {};
        return {
          seen: p.seen || '（AI 沒有回答這張，請老師自己寫）',
          highlights: (p.highlights || []).join('、'),
          uncertain: (p.uncertain || []).join('、') || '無',
          privacy: (p.privacy || []).join('、'),
        };
      });
      S.notesConfirmed = false;
      confirmCb.checked = false;
    } catch (e) { toast(e.message); reviewBox.prepend(el('div', { class: 'notice danger' }, e.message)); done(); return; }
    done();
    drawReview(); updateLocks();
  });

  function drawReview() {
    if (!S.photos.length) {
      reviewBox.replaceChildren(el('p', { class: 'muted' }, '這次沒有照片也可以，直接跳到下一步。'));
      return;
    }
    if (!S.photoNotes.length) {
      reviewBox.replaceChildren(el('p', { class: 'muted' }, '按上面的按鈕，AI 會列出每張照片「看到了什麼」和「不確定的地方」。'));
      return;
    }
    reviewBox.replaceChildren(
      el('div', { class: 'notice warn' }, '請一張一張核對。AI 看錯的地方直接改；文案只會用你核對過的文字，而且事實仍以行程表為準。'),
      ...S.photoNotes.map((n, i) => {
        const field = (key, label, rows = 2) => {
          const ta = el('textarea', { style: `min-height:${rows * 28 + 20}px` });
          ta.value = n[key];
          ta.addEventListener('input', () => { n[key] = ta.value; S.notesConfirmed = false; confirmCb.checked = false; updateLocks(); });
          return el('div', {}, el('label', {}, label), ta);
        };
        return el('div', { class: 'review' },
          S.photos[i] ? el('img', { src: S.photos[i].dataUrl, alt: `照片 ${i + 1}` }) : el('div', { class: 'muted' }, `照片 ${i + 1}（照片沒有保存）`),
          el('div', {},
            el('strong', {}, `照片 ${i + 1}`),
            n.privacy ? el('div', { class: 'notice danger' }, `🔒 個資提醒：${n.privacy}`) : null,
            field('seen', '👀 AI 看到了什麼'),
            field('highlights', '✨ 互動亮點', 1),
            field('uncertain', '❓ 不確定的地方', 1),
          ),
        );
      }),
      el('div', { class: 'card', style: 'margin-top:12px' }, confirmRow),
    );
  }

  // ===== 第 4 步：問卷連結 =====
  const g12 = el('input', { type: 'url', value: S.survey.g12, placeholder: 'https://forms.gle/…' });
  const g38 = el('input', { type: 'url', value: S.survey.g38, placeholder: 'https://forms.gle/…' });
  g12.addEventListener('input', () => { S.survey.g12 = g12.value.trim(); });
  g38.addEventListener('input', () => { S.survey.g38 = g38.value.trim(); });
  if (!S.survey.smallRange) S.survey.smallRange = '1-3';
  if (!S.survey.bigRange) S.survey.bigRange = '4-6';
  const smallRange = el('input', { type: 'text', value: S.survey.smallRange, placeholder: '例如：1-3', style: 'max-width:140px' });
  const bigRange = el('input', { type: 'text', value: S.survey.bigRange, placeholder: '例如：4-6', style: 'max-width:140px' });
  smallRange.addEventListener('input', () => { S.survey.smallRange = smallRange.value.trim().replace(/年級$/, ''); drawSurveyTitles(); });
  bigRange.addEventListener('input', () => { S.survey.bigRange = bigRange.value.trim().replace(/年級$/, ''); S.survey.rangeEdited = true; drawSurveyTitles(); });
  smallRange.addEventListener('input', () => { S.survey.rangeEdited = true; });
  const weekInfo = el('div', { class: 'muted' });
  /** 依學季第幾週，自動填年級範圍。force=true：日期改了就重算；手動改過的不會被蓋掉（除非日期又換了） */
  function applyWeekRanges(force) {
    const start = settings.quarterStart || DEFAULT_QUARTER_START;
    const n = quarterWeek(S.date, start);
    const r = weekRanges(n);
    if (!start) { weekInfo.textContent = '💡 到「⚙️ 設定」填學季第一週的日期，系統就會自動填年級範圍。'; return; }
    if (!r) { weekInfo.textContent = '這個日期不在這個學季的 1～10 週內，請手動填年級範圍（或到設定更新學季日期）。'; return; }
    weekInfo.textContent = `📅 這是學季第 ${n} 週：小小孩 ${r.small} 年級、大孩子 ${r.big} 年級（可以手動改）`;
    if (force || !S.survey.rangeEdited) {
      S.survey.smallRange = r.small; S.survey.bigRange = r.big; S.survey.rangeEdited = false;
      smallRange.value = r.small; bigRange.value = r.big;
    }
  }
  const titlesBox = el('div');
  function drawSurveyTitles() {
    titlesBox.replaceChildren(
      el('div', { class: 'muted' }, '建議的問卷標題（產生文案後，在「問卷題目」區塊可以一起複製）：'),
      el('div', { class: 'bubble' }, `${surveyTitle(S.date, '小小孩', S.place)}\n${surveyTitle(S.date, '大孩子', S.place)}`),
    );
  }

  // ===== 第 5 步：選版本、產生 =====
  const OUT_LABELS = [
    ['line', '📱 家長群組溫馨回顧（LINE）'],
    ['survey', '📋 問卷標題＋回家可以問孩子的問題（放進 Google 表單）'],
    ['fb', '📘 Facebook 貼文'],
    ['ig', '📸 Instagram 貼文（含 hashtag）'],
    ['record', '📝 教學紀錄（教學省思留空）'],
  ];
  const outChecks = OUT_LABELS.map(([k, label]) => {
    const cb = el('input', { type: 'checkbox', checked: S.outputs[k] });
    cb.addEventListener('change', () => { S.outputs[k] = cb.checked; });
    return el('label', { class: 'inline' }, cb, el('span', {}, label));
  });
  const lqCb = el('input', { type: 'checkbox', checked: S.outputs.lineQuestions });
  // ⚡ 快速模式：用較快的模型（文案品質可能稍差）。選擇會記在帳號設定裡
  const fastCb = el('input', { type: 'checkbox', checked: !!settings.preferFast });
  fastCb.addEventListener('change', async () => {
    settings.preferFast = fastCb.checked;
    try { await store.saveSettings({ ...settings }); } catch { /* 存不了也沒關係，這次照樣用 */ }
  });
  lqCb.addEventListener('change', () => { S.outputs.lineQuestions = lqCb.checked; });
  const genBtn = el('button', { class: 'btn primary' }, '✨ 產生文案');
  const genMsg = el('div');
  const resultBox = el('div');

  genBtn.addEventListener('click', async () => {
    S.scheduleText = f.schedule.value;
    S.place = f.place.value.trim();
    if (!S.place) { genMsg.replaceChildren(el('div', { class: 'notice danger' }, '請先填「地點」')); return; }
    if (!S.scheduleText.trim() && !S.docs.length) { genMsg.replaceChildren(el('div', { class: 'notice danger' }, '請先貼上行程表／學習單（或上傳檔案）。事實要以它為準。')); return; }
    if (S.photos.length && !S.notesConfirmed) { genMsg.replaceChildren(el('div', { class: 'notice danger' }, '請先在第 3 步核對照片描述並打勾。')); return; }
    if (!Object.entries(S.outputs).some(([k, v]) => k !== 'lineQuestions' && v)) { genMsg.replaceChildren(el('div', { class: 'notice danger' }, '請至少勾一種版本')); return; }
    genMsg.replaceChildren();
    const done = spinnerButton(genBtn, 'AI 正在寫文案…');
    try {
      const photoNotes = S.photoNotes.map((n, i) => `照片${i + 1}：${n.seen}${n.highlights ? `（亮點：${n.highlights}）` : ''}${n.uncertain && n.uncertain !== '無' ? `［不確定：${n.uncertain}］` : ''}`).join('\n');
      // 每一種文案同時請 AI 寫，比一次寫完快；其中一種失敗，其他的還是保留
      const groups = tripGroups(S.outputs);
      const normalModel = settings.model || DEFAULT_MODEL;
      const fastModel = settings.fastModel || guessFastModel(normalModel);
      let useFast = fastCb.checked, fastMissing = false;
      // 快速模型找不到（404）就改回一般模型，不會因此失敗
      const ask = async (opts) => {
        if (useFast) {
          try { return await callGemini({ ...opts, model: fastModel, upgrade: false }); }
          catch (e) { if (e.status !== 404) throw e; fastMissing = true; useFast = false; }
        }
        return callGemini({ ...opts, model: normalModel });
      };
      let finished = 0;
      const label = genBtn.lastChild;
      const settled = await Promise.allSettled(groups.map(async g => {
        const parts = tripPrompt({ trip: S, photoNotes, outputs: g.outputs, docParts: docParts() });
        const out = await ask({ apiKey: settings.geminiKey, parts, schema: tripSchemaFor(g.fields), temperature: 0.6 });
        finished++;
        if (label) label.textContent = ` AI 正在寫文案…（完成 ${finished}/${groups.length}）`;
        return out;
      }));
      const r = { fact_check: [] };
      const failed = [];
      settled.forEach((res, i) => {
        if (res.status === 'fulfilled') {
          const { fact_check, ...rest } = res.value;
          Object.assign(r, Object.fromEntries(groups[i].fields.map(f => [f, rest[f]])));
          r.fact_check.push(...(fact_check || []));
        } else failed.push({ label: groups[i].label, message: res.reason?.message || '失敗了' });
      });
      const seenFacts = new Set();
      r.fact_check = r.fact_check.filter(x => { const k = `${x.claim}|${x.source}`; if (seenFacts.has(k)) return false; seenFacts.add(k); return true; });
      if (failed.length === groups.length) throw new Error(failed[0].message);
      S.result = r;
      S.texts = assembleTexts(S, r);
      S.failedGroups = failed.map(f => f.label);
      if (failed.length) genMsg.replaceChildren(el('div', { class: 'notice warn' }, `⚠️ 這幾個沒有寫成功：${failed.map(f => f.label).join('、')}。其他的已經完成。再按一次「✨ 產生文案」就會全部重寫；${failed[0].message}`));
      if (fastMissing) genMsg.append(el('div', { class: 'notice warn' }, `⚡ 找不到快速模型「${fastModel}」，這次改用一般模型寫完了。可以到「⚙️ 設定」按「檢查鑰匙」重新找快速模型。`));
      await save();
      // 記進地點庫：這個地點這天去過
      try {
        const rec = await recordVisit(store, S.place, S.date);
        if (rec?.created) toast('📍 已把這個新地點加進地點庫，室內外請到「📍 踏查地點」確認');
      } catch (err) { console.error(err); }
      toast('文案完成，已自動儲存（照片不會儲存）');
    } catch (e) {
      genMsg.replaceChildren(el('div', { class: 'notice danger' }, e.message));
    }
    done();
    drawResult();
  });

  function drawResult() {
    if (!S.texts || !Object.keys(S.texts).length) { resultBox.replaceChildren(); return; }
    const names = el('input', { type: 'text', placeholder: '例如：王小明 陳大華（用空白或逗號分開）', autocomplete: 'off' });
    names.value = namesForCheck;
    const blocks = [];
    const gatedBlocks = [];
    const checklist = publishChecklist(open => gatedBlocks.forEach(b => b.setGate(open)));
    const add = (key, title, gated, hint) => {
      if (S.texts[key] === undefined) return;
      const b = outputBlock({ title, text: S.texts[key], gated, getNames, hint, onEdit: v => { S.texts[key] = v; } });
      blocks.push(b);
      if (gated) gatedBlocks.push(b);
    };
    add('line', '📱 家長群組溫馨回顧（LINE）', true, '問卷連結和「12點前送出」提醒是系統照你的格式自動加上的。');
    add('survey', '📋 問卷標題＋題目（給 Google 表單）', false);
    add('fb', '📘 Facebook 貼文', true);
    add('ig', '📸 Instagram 貼文', true, 'IG 一定要附照片，請在 IG 裡自己選照片後貼上這段文字。');
    add('record', '📝 教學紀錄', false, `「教學省思」故意留空，請老師自己寫。⚠️ 紀錄 ${ctx.settings?.retentionDays ?? 7} 天後會自動刪除，教學紀錄請先複製到學校的檔案裡保存。`);
    names.addEventListener('input', () => { namesForCheck = names.value; blocks.forEach(b => b.refresh()); });
    const fc = (S.result?.fact_check || []);
    resultBox.replaceChildren(
      el('div', { class: 'card' },
        el('h2', {}, el('span', { class: 'step-num' }, '6'), '核對與複製'),
        fc.length ? el('details', { open: true }, el('summary', {}, `🔎 AI 寫進文案的事實和來源（${fc.length} 項）— 請核對`),
          ...fc.map(x => el('div', { class: 'list-item' }, el('span', {}, x.claim), el('span', { class: x.source?.includes('照片') ? 'tag warn' : 'tag' }, x.source)))) : null,
        el('label', {}, '🔒 個資檢查（選填）：輸入這次學生的名字，系統會幫你找文案裡有沒有出現。名字不會被儲存。'),
        names,
        ...blocks,
        checklist,
        el('div', { class: 'btns' },
          el('button', { class: 'btn', onclick: async () => { await save(); toast('已儲存修改'); } }, '💾 儲存修改'),
          el('button', { class: 'btn', onclick: () => ctx.go('publish', { tripId: S.id }) }, '📤 到「本週發送」和週會一起發'),
        ),
      ),
    );
  }

  // ===== 鎖住還不能做的步驟 =====
  const step3Card = el('div', { class: 'card' });
  const step6Card = el('div', { class: 'card' });
  function updateLocks() {
    analyzeBtn.disabled = !S.photos.length;
    const canGen = !S.photos.length || S.notesConfirmed;
    genBtn.disabled = !canGen;
    genBtn.title = canGen ? '' : '請先核對照片描述';
  }

  step3Card.append(
    el('h2', {}, el('span', { class: 'step-num' }, '3'), 'AI 看照片 → 老師核對'),
    el('p', { class: 'muted' }, 'AI 只描述畫面，不會辨認是誰。核對完才能產生文案。'),
    el('div', { class: 'btns' }, analyzeBtn),
    reviewBox,
  );
  step6Card.append(
    el('h2', {}, el('span', { class: 'step-num' }, '5'), '要產生哪幾種？'),
    ...outChecks,
    el('p', { class: 'muted' }, '💡 想快一點：只勾今天要用的版本、照片 3～5 張就好。'),
    el('label', { class: 'inline' }, fastCb, el('span', {}, '⚡ 快速模式：用較快的模型（文案品質可能稍差，覺得不好可以取消再產生一次）')),
    el('details', {}, el('summary', {}, '進階選項'),
      el('label', { class: 'inline' }, lqCb, el('span', {}, '「回家可以問孩子的問題」也放進 LINE 家長訊息（預設只放在問卷）'))),
    genMsg,
    el('div', { class: 'btns' }, genBtn),
  );

  root.replaceChildren(
    el('h1', {}, '🚌 每週二踏查'),
    el('div', { class: 'btns', style: 'margin-top:0' },
      el('button', { class: 'btn small', onclick: () => {
        if (S.photos.length || S.scheduleText || S.texts?.line) { if (!confirm('要清空目前的內容，開始新的一次踏查嗎？（已儲存的不會不見）')) return; }
        S = newState(); renderTrip(root, ctx);
      } }, '🆕 開始新的一次'),
      S.id ? el('span', { class: 'muted' }, `正在編輯：${toROC(S.date)} ${S.place}`) : null,
    ),
    el('div', { class: 'card' },
      el('h2', {}, el('span', { class: 'step-num' }, '1'), '行程表／學習單'),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '日期'), f.date),
        el('div', {}, el('label', {}, '地點 *'), f.place, placeList, placeHint),
      ),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '活動名稱'), f.title),
        el('div', {}, el('label', {}, '參加年級'), f.grades),
      ),
      el('label', {}, '行程表／學習單的內容（事實以這裡為準）'),
      f.schedule,
      el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: () => docInput.click() }, '📎 上傳檔案（PDF／Word／文字檔／拍照）'), docInput),
      el('p', { class: 'muted' }, 'Word 和文字檔會轉成文字放進上面的框；PDF 和照片檔會直接交給 AI 讀，但不會儲存。'),
      docList,
    ),
    el('div', { class: 'card' },
      el('h2', {}, el('span', { class: 'step-num' }, '2'), '挑照片'),
      el('div', { class: 'notice warn' }, '⚠️ 上傳前請先排除「沒有肖像同意」的學生照片。AI 不會、也不可以認人，所以這一步只能靠老師把關。'),
      el('label', { class: 'inline' }, consentCb, el('strong', {}, '我確認：要上傳的照片裡，每一位學生都有肖像同意')),
      el('div', { class: 'btns' }, pickBtn, photoInput),
      el('p', { class: 'muted' }, `照片會先在你的裝置上自動縮小，並去掉 GPS 位置等隱藏資訊。最多 ${MAX_PHOTOS} 張，建議 3～5 張就好：照片越少，AI 越快。`),
      photoInfo,
      photoGrid,
    ),
    step3Card,
    el('div', { class: 'card' },
      el('h2', {}, el('span', { class: 'step-num' }, '4'), '問卷連結'),
      el('p', { class: 'muted' }, '每週新的 Google 表單連結貼在這裡。沒有問卷就留空，家長訊息就不會出現問卷那一段。'),
      weekInfo,
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '小小孩是幾年級？'), smallRange),
        el('div', {}, el('label', {}, '大孩子是幾年級？'), bigRange),
      ),
      el('label', {}, '小小孩問卷連結'), g12,
      el('label', {}, '大孩子問卷連結'), g38,
      titlesBox,
    ),
    step6Card,
    resultBox,
  );
  if (!settings.geminiKey) root.prepend(el('div', { class: 'notice danger' }, '還沒設定 Gemini 鑰匙，AI 功能不能用。', el('button', { class: 'btn small', onclick: () => ctx.go('settings') }, '去設定')));
  applyWeekRanges(!S.id); if (!S.id) autoFillPlace(); drawPlaceHint(); drawDocs(); drawPhotos(); drawReview(); drawSurveyTitles(); drawResult(); updateLocks();
}
