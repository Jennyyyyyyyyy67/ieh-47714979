// ⚙️ 設定：Gemini 鑰匙、模型、預設分享老師
import { el, makeInviteLink, copyText } from '../utils.js';
import { listModels, DEFAULT_MODEL, pickBestFlash } from '../gemini.js';
import { spinnerButton } from './common.js';
import { ROLES } from './survey.js';

export async function renderSettings(root, ctx) {
  const { store, toast } = ctx;
  const s = { ...(ctx.settings || {}) };
  const isMain = (s.role || 'main') === 'main';
  const key = el('input', { type: 'password', value: s.geminiKey || '', placeholder: '貼上 Google AI Studio 給你的鑰匙', autocomplete: 'off' });
  const show = el('input', { type: 'checkbox' });
  show.addEventListener('change', () => { key.type = show.checked ? 'text' : 'password'; });
  const model = el('input', { type: 'text', value: s.model || DEFAULT_MODEL, list: 'modelList' });
  const modelList = el('datalist', { id: 'modelList' });
  const speaker = el('input', { type: 'text', value: s.speaker || '蓓禎老師' });
  const sendWeekday = el('select', {}, ...['日', '一', '二', '三', '四', '五', '六'].map((d, i) => el('option', { value: String(i), selected: i === (s.sendWeekday ?? 2) }, `星期${d}`)));
  const sendTime = el('input', { type: 'time', value: s.sendTime || '17:00' });
  const retention = el('select', {}, ...[[7, '7 天後自動刪除（建議）'], [14, '14 天後自動刪除'], [30, '30 天後自動刪除'], [0, '不要自動刪除']].map(([v, t]) => el('option', { value: String(v), selected: v === (s.retentionDays ?? 7) }, t)));
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
      msg.replaceChildren(el('div', { class: ok ? 'notice ok' : 'notice warn' },
        note,
        el('details', {}, el('summary', {}, `可以用的模型（${models.length}）`), el('div', { class: 'muted' }, models.join('、')))));
    } catch (e) { msg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
    done();
  });
  const saveBtn = el('button', { class: 'btn primary' }, '💾 儲存設定');
  saveBtn.addEventListener('click', async () => {
    const next = { ...s, geminiKey: key.value.trim(), model: model.value.trim() || DEFAULT_MODEL, speaker: speaker.value.trim(), sendWeekday: Number(sendWeekday.value), sendTime: sendTime.value || '17:00', retentionDays: Number(retention.value) };
    await store.saveSettings(next);
    await ctx.reloadSettings();
    toast('設定已儲存');
  });

  function inviteCard() {
    const out = el('div');
    const mk = (role, label) => el('button', { class: 'btn', onclick: async () => {
      if (!ctx.settings?.geminiKey) { out.replaceChildren(el('div', { class: 'notice danger' }, '請先在上面設定好你的 Gemini 鑰匙，並按「儲存設定」。')); return; }
      const link = makeInviteLink(location.href, { key: ctx.settings.geminiKey, model: ctx.settings.model, role });
      const msgText = `老師好！請幫忙批改${label}問卷 🙏\n1. 點這個連結：${link}\n2. 輸入你的 Email 和密碼，按「第一次使用：註冊」\n3. 系統會自動設定好，直接上傳問卷回覆、按「🤖 用 AI 批改」就可以了\n（這個連結請不要轉傳給別人）`;
      const ok = await copyText(msgText);
      out.replaceChildren(el('div', { class: ok ? 'notice ok' : 'notice warn' }, ok ? `✅ 已複製「${label}批改老師」的邀請訊息，可以直接貼到 LINE 私訊給那位老師。` : '複製失敗，請手動選取下面的文字。'),
        el('div', { class: 'bubble' }, msgText));
    } }, `📩 邀請 ${label}批改老師`);
    return el('div', { class: 'card' },
      el('h2', {}, '🔗 邀請批改老師'),
      el('p', { class: 'muted' }, '按下去會複製一段邀請訊息。批改老師點連結、註冊，就會自動用你的 AI 鑰匙，不用自己申請。'),
      el('div', { class: 'notice warn' }, '⚠️ 連結裡面藏著你的鑰匙：只私訊給那位老師，不要貼到群組。萬一傳錯了，到 Google AI Studio 把這把鑰匙刪掉、建立新的，再重新邀請一次就好。三位老師共用同一把鑰匙的免費額度。'),
      el('div', { class: 'btns' }, mk('g12', '1-2年級'), mk('g38', '3-8年級')),
      out,
    );
  }

  root.replaceChildren(...[
    modelList,
    el('h1', {}, '⚙️ 設定'),
    el('div', { class: 'card' },
      el('h2', {}, '👤 我的身分'),
      el('p', {}, el('strong', {}, ROLES[s.role || 'main'].label), el('span', { class: 'muted' }, `　${ROLES[s.role || 'main'].desc}`)),
      el('div', { class: 'btns', style: 'margin-top:0' }, el('button', { class: 'btn small', onclick: () => ctx.pickRole() }, '換身分')),
    ),
    !isMain && s.sharedKey && s.geminiKey ? el('div', { class: 'card' },
      el('h2', {}, '🤖 AI 鑰匙'),
      el('div', { class: 'notice ok' }, '✅ 主要老師已經幫你設定好了，不用自己申請。直接到「📝 答案批改」開始吧！'),
    ) : null,
    !isMain && s.sharedKey && s.geminiKey ? null : el('div', { class: 'card' },
      el('h2', {}, isMain ? '🤖 Gemini（看照片、寫文案、批改的 AI）' : '🤖 Gemini（批改答案的 AI）'),
      isMain ? null : el('p', {}, '最簡單的方法：請主要老師在他的「⚙️ 設定」按「邀請批改老師」，把連結傳給你。'),
      el('ol', { class: 'muted' },
        el('li', {}, '用 Google 帳號打開 ', el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'Google AI Studio'), '。'),
        el('li', {}, '按「Create API key（建立 API 金鑰）」，複製那串英文數字。'),
        el('li', {}, '貼在下面，按「檢查鑰匙」，再按「儲存設定」。'),
      ),
      el('div', { class: 'notice warn' }, '⚠️ 免費版的資料，Google 可能拿去改進產品。所以只上傳有肖像同意的照片，也不要在行程表裡寫學生名字。鑰匙就像密碼，不要給別人。'),
      el('label', {}, 'Gemini 鑰匙（API key）'), key,
      el('label', { class: 'inline' }, show, el('span', {}, '顯示鑰匙')),
      el('label', {}, '模型名稱'), model,
      el('p', { class: 'muted' }, `預設是 ${DEFAULT_MODEL}。如果以後 Google 改了名字，按「檢查鑰匙」就能看到現在能用哪些。`),
      msg,
      el('div', { class: 'btns' }, testBtn),
    ),
    !isMain ? null : inviteCard(),
    !isMain ? null : el('div', { class: 'card' },
      el('h2', {}, '⛪ 週會'),
      el('label', {}, '預設分享的老師'), speaker,
    ),
    !isMain ? null : el('div', { class: 'card' },
      el('h2', {}, '⏰ 發送時間與清容量'),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '每週發送日'), sendWeekday),
        el('div', {}, el('label', {}, '發送時間'), sendTime),
      ),
      el('label', {}, '舊紀錄（踏查、週會）'), retention,
      el('p', { class: 'muted' }, '每次登入時會自動清掉太舊的紀錄。教學紀錄請記得先複製到學校的檔案裡。'),
    ),
    el('div', { class: 'card' },
      el('div', { class: 'btns', style: 'margin-top:0' }, saveBtn),
      el('p', { class: 'muted' }, `目前模式：${store.mode === 'firebase' ? '正式版（Firebase，換裝置登入也看得到資料）' : '本機試用模式（資料只在這台裝置）'}`),
    ),
  ].filter(Boolean));
}
