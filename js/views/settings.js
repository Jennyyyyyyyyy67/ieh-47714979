// ⚙️ 設定：Gemini 鑰匙、模型、預設分享老師
import { el } from '../utils.js';
import { listModels, DEFAULT_MODEL, pickBestFlash, pickFastModel, guessFastModel } from '../gemini.js';
import { spinnerButton } from './common.js';
import { PARTS, partLabels } from './report.js';
import { DEFAULT_QUARTER_START, DEFAULT_DEPART, DEFAULT_RETURN, DEFAULT_RETURN_PLACE } from '../places-logic.js';

export async function renderSettings(root, ctx) {
  const { store, toast } = ctx;
  const s = { ...(ctx.settings || {}) };
  const isMain = true; // 設定頁只有「踏查、週會、發送」工作看得到
  const key = el('input', { type: 'password', value: s.geminiKey || '', placeholder: '貼上 Google AI Studio 給你的鑰匙', autocomplete: 'off' });
  const show = el('input', { type: 'checkbox' });
  show.addEventListener('change', () => { key.type = show.checked ? 'text' : 'password'; });
  const model = el('input', { type: 'text', value: s.model || DEFAULT_MODEL, list: 'modelList' });
  const modelList = el('datalist', { id: 'modelList' });
  const fastModel = el('input', { type: 'text', value: s.fastModel || '', list: 'modelList', placeholder: guessFastModel(s.model) });
  const speaker = el('input', { type: 'text', value: s.speaker || '蓓禎老師' });
  const sendWeekday = el('select', {}, ...['日', '一', '二', '三', '四', '五', '六'].map((d, i) => el('option', { value: String(i), selected: i === (s.sendWeekday ?? 2) }, `星期${d}`)));
  const sendTime = el('input', { type: 'time', value: s.sendTime || '17:00' });
  const quarterStart = el('input', { type: 'date', value: s.quarterStart || DEFAULT_QUARTER_START });
  const departTime = el('input', { type: 'time', value: s.departTime || DEFAULT_DEPART });
  const returnTime = el('input', { type: 'time', value: s.returnTime || DEFAULT_RETURN });
  const returnPlace = el('input', { type: 'text', value: s.returnPlace || DEFAULT_RETURN_PLACE });
  const retention = el('select', {}, ...[[7, '7 天後自動刪除（建議）'], [14, '14 天後自動刪除'], [30, '30 天後自動刪除'], [0, '不要自動刪除']].map(([v, t]) => el('option', { value: String(v), selected: v === (s.retentionDays ?? 7) }, t)));
  // 本週名單的標題和獎勵文字
  const labels = partLabels(s);
  const labelInputs = Object.fromEntries(Object.keys(PARTS).map(k => [k, {
    title: el('input', { type: 'text', value: labels[k].title }),
    note: el('input', { type: 'text', value: labels[k].note, placeholder: '括號裡的文字，例如：5元心幣' }),
  }]));
  const msg = el('div');
  const testBtn = el('button', { class: 'btn' }, '🔑 檢查鑰匙');
  testBtn.addEventListener('click', async () => {
    const done = spinnerButton(testBtn, '檢查中…');
    try {
      const models = await listModels(key.value.trim());
      modelList.replaceChildren(...models.map(m => el('option', { value: m })));
      let ok = models.includes(model.value.trim());
      let note = `✅ 鑰匙可以用，模型「${model.value}」也找得到。`;
      if (!ok) {
        const best = pickBestFlash(models);
        if (best) { note = `✅ 鑰匙可以用。原本的模型「${model.value}」已經沒有了，已自動換成「${best}」，請按「儲存設定」。`; model.value = best; ok = true; }
        else note = `鑰匙可以用，但找不到模型「${model.value}」。請從模型欄位的下拉選單挑一個名字有 flash 的。`;
      }
      const fast = pickFastModel(models);
      if (fast) { fastModel.value = fast; note += ` ⚡ 快速模式會用「${fast}」。`; }
      else note += ' （沒有找到較快的 lite 模型，快速模式會自動改用一般模型。）';
      msg.replaceChildren(el('div', { class: ok ? 'notice ok' : 'notice warn' },
        note,
        el('details', {}, el('summary', {}, `可以用的模型（${models.length}）`), el('div', { class: 'muted' }, models.join('、')))));
    } catch (e) { msg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
    done();
  });
  const saveBtn = el('button', { class: 'btn primary' }, '💾 儲存設定');
  saveBtn.addEventListener('click', async () => {
    const next = { ...s, geminiKey: key.value.trim(), model: model.value.trim() || DEFAULT_MODEL, fastModel: fastModel.value.trim(), speaker: speaker.value.trim(), sendWeekday: Number(sendWeekday.value), sendTime: sendTime.value || '17:00', retentionDays: Number(retention.value), quarterStart: quarterStart.value || DEFAULT_QUARTER_START,
      departTime: departTime.value || DEFAULT_DEPART, returnTime: returnTime.value || DEFAULT_RETURN, returnPlace: returnPlace.value.trim() || DEFAULT_RETURN_PLACE,
      reportLabels: Object.fromEntries(Object.entries(labelInputs).map(([k, v]) => [k, { title: v.title.value, note: v.note.value }])) };
    await store.saveSettings(next);
    await ctx.reloadSettings();
    toast('設定已儲存');
  });

  root.replaceChildren(...[
    modelList,
    el('h1', {}, '⚙️ 設定'),
    el('div', { class: 'card' },
      el('h2', {}, isMain ? '🤖 Gemini（看照片、寫文案、批改的 AI）' : '🤖 Gemini（批改答案的 AI）'),
      el('ol', { class: 'muted' },
        el('li', {}, '用 Google 帳號打開 ', el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'Google AI Studio'), '。'),
        el('li', {}, '按「Create API key（建立 API 金鑰）」，複製那串英文數字。'),
        el('li', {}, '貼在下面，按「檢查鑰匙」，再按「儲存設定」。'),
      ),
      el('p', {}, '這把鑰匙存在這個共用帳號裡，所有工作（包括批改問卷）都會用它，其他老師不用再申請。'),
      el('div', { class: 'notice warn' }, '⚠️ 免費版的資料，Google 可能拿去改進產品。所以只上傳有肖像同意的照片，也不要在行程表裡寫學生名字。鑰匙就像密碼，不要給別人。'),
      el('label', {}, 'Gemini 鑰匙（API key）'), key,
      el('label', { class: 'inline' }, show, el('span', {}, '顯示鑰匙')),
      el('label', {}, '模型名稱'), model,
      el('label', {}, '⚡ 快速模式用的模型（按「檢查鑰匙」會自動找）'), fastModel,
      el('p', { class: 'muted' }, `預設是 ${DEFAULT_MODEL}。如果以後 Google 改了名字，按「檢查鑰匙」就能看到現在能用哪些。`),
      msg,
      el('div', { class: 'btns' }, testBtn),
    ),
    !isMain ? null : el('div', { class: 'card' },
      el('h2', {}, '⛪ 週會'),
      el('label', {}, '預設分享的老師'), speaker,
    ),
    el('div', { class: 'card' },
      el('h2', {}, '📋 本週名單的格式'),
      el('p', { class: 'muted' }, '名單上每一類的名稱，和括號裡的獎勵／處理方式。改完按最下面的「儲存設定」。'),
      ...Object.entries(labelInputs).map(([k, v]) => el('div', { class: 'row' },
        el('div', {}, el('label', {}, '名稱'), v.title),
        el('div', {}, el('label', {}, '（括號裡的文字）'), v.note))),
    ),
    !isMain ? null : el('div', { class: 'card' },
      el('h2', {}, '⏰ 發送時間與清容量'),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '每週發送日'), sendWeekday),
        el('div', {}, el('label', {}, '發送時間'), sendTime),
      ),
      el('label', {}, '學季第一週的日期（那一週的任何一天都可以）'), quarterStart,
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '踏查出發時間'), departTime),
        el('div', {}, el('label', {}, '回到的時間'), returnTime),
        el('div', {}, el('label', {}, '回到哪裡'), returnPlace)),
      el('p', { class: 'muted' }, '每週踏查都一樣的時間，新增踏查時會自動寫進行程表。'),
      el('p', { class: 'muted' }, '一個學季 10 週。系統會算出這週是第幾週，自動填年級範圍：第 1、5、9 週＝小小孩 1-2／大孩子 3-8；其他單週＝1-3／4-8；雙週＝1-3／4-6。'),
      el('label', {}, '舊紀錄（踏查、週會）'), retention,
      el('p', { class: 'muted' }, '每次登入時會自動清掉太舊的紀錄。教學紀錄請記得先複製到學校的檔案裡。'),
    ),
    el('div', { class: 'card' },
      el('div', { class: 'btns', style: 'margin-top:0' }, saveBtn),
      el('p', { class: 'muted' }, `目前模式：${store.mode === 'firebase' ? '正式版（Firebase，換裝置登入也看得到資料）' : '本機試用模式（資料只在這台裝置）'}`),
    ),
  ].filter(Boolean));
}
