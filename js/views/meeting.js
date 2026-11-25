// ⛪ 週會家長信：貼上逐字稿 → AI 照範例整理成 300 字內
import { el, todayISO, toROC, countChars } from '../utils.js';
import { callGemini, DEFAULT_MODEL } from '../gemini.js';
import { MEETING_SCHEMA, meetingPrompt } from '../prompts.js';
import { publishChecklist, outputBlock, spinnerButton } from './common.js';

const MAX = 300;
let M = null;
const fresh = () => ({ id: null, date: todayISO(), weekInfo: '本週', speaker: '', transcript: '', challengeHint: '', letter: '' });

export async function renderMeeting(root, ctx) {
  const { store, toast } = ctx;
  const settings = ctx.settings || {};
  if (ctx.params?.meeting) { M = { ...fresh(), ...ctx.params.meeting }; ctx.params = null; }
  if (!M) M = fresh();
  if (!M.speaker) M.speaker = settings.speaker || '蓓禎老師';

  const date = el('input', { type: 'date', value: M.date });
  const weekInfo = el('input', { type: 'text', value: M.weekInfo, placeholder: '例如：本週、新學季首週' });
  const speaker = el('input', { type: 'text', value: M.speaker });
  const transcript = el('textarea', { placeholder: '把週會錄音轉出來的逐字稿貼在這裡', style: 'min-height:220px' });
  transcript.value = M.transcript;
  const hint = el('input', { type: 'text', value: M.challengeHint, placeholder: '（選填）逐字稿沒講清楚時，可以在這裡補充本週領袖挑戰' });
  const tCount = el('span', { class: 'muted' });
  const updT = () => { tCount.textContent = `逐字稿 ${countChars(transcript.value)} 字`; };
  transcript.addEventListener('input', () => { M.transcript = transcript.value; updT(); });
  date.addEventListener('change', () => { M.date = date.value; });
  weekInfo.addEventListener('input', () => { M.weekInfo = weekInfo.value; });
  speaker.addEventListener('input', () => { M.speaker = speaker.value; });
  hint.addEventListener('input', () => { M.challengeHint = hint.value; });

  const fileInput = el('input', { type: 'file', accept: '.txt,text/plain', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (file) { transcript.value = await file.text(); M.transcript = transcript.value; updT(); }
    fileInput.value = '';
  });

  const msg = el('div');
  const genBtn = el('button', { class: 'btn primary' }, '✨ 整理成家長信');
  const resultBox = el('div');

  const save = async () => { const s = await store.save('meetings', M); M.id = s.id; };

  async function generate(shorterThan) {
    return callGemini({
      apiKey: settings.geminiKey, model: settings.model || DEFAULT_MODEL, temperature: 0.4, schema: MEETING_SCHEMA,
      parts: meetingPrompt({ transcript: M.transcript, weekInfo: M.weekInfo, speaker: M.speaker, challengeHint: M.challengeHint, maxChars: MAX, shorterThan }),
    });
  }

  genBtn.addEventListener('click', async () => {
    if (countChars(M.transcript) < 30) { msg.replaceChildren(el('div', { class: 'notice danger' }, '逐字稿太短了，請貼上完整的逐字稿。')); return; }
    msg.replaceChildren();
    const done = spinnerButton(genBtn, 'AI 正在整理…');
    try {
      let r = await generate();
      // 超過 300 字就自動再精簡一次
      if (countChars(r.letter) > MAX) r = await generate(countChars(r.letter));
      M.letter = (r.letter || '').trim();
      await save();
      toast('整理完成，已自動儲存');
    } catch (e) { msg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
    done();
    drawResult();
  });

  function drawResult() {
    if (!M.letter) { resultBox.replaceChildren(); return; }
    const shortenBtn = el('button', { class: 'btn small' }, '✂️ 再精簡一點');
    const block = outputBlock({ title: '💌 週會家長信', text: M.letter, gated: true, maxChars: MAX, extraButtons: [shortenBtn], onEdit: v => { M.letter = v; } });
    shortenBtn.addEventListener('click', async () => {
      const done = spinnerButton(shortenBtn, '精簡中…');
      try {
        const r = await generate(Math.min(countChars(block.getText()), MAX));
        M.letter = r.letter.trim(); block.setText(M.letter); await save();
      } catch (e) { toast(e.message); }
      done();
    });
    const checklist = publishChecklist(open => block.setGate(open));
    resultBox.replaceChildren(el('div', { class: 'card' },
      el('div', { class: 'notice warn' }, '請對照逐字稿讀一遍：AI 有沒有加了老師沒講的內容？經文有沒有抄對？'),
      block,
      checklist,
      el('div', { class: 'btns' },
        el('button', { class: 'btn', onclick: async () => { await save(); toast('已儲存修改'); } }, '💾 儲存修改'),
        el('button', { class: 'btn', onclick: () => ctx.go('publish', { meetingId: M.id }) }, '📤 到「本週發送」和踏查一起發'),
      ),
    ));
  }

  root.replaceChildren(...[
    el('h1', {}, '⛪ 週會家長信'),
    el('div', { class: 'btns', style: 'margin-top:0' },
      el('button', { class: 'btn small', onclick: () => { if (M.transcript && !confirm('要清空，開始新的一週嗎？（已儲存的不會不見）')) return; M = null; renderMeeting(root, ctx); } }, '🆕 開始新的一週'),
      M.id ? el('span', { class: 'muted' }, `正在編輯：${toROC(M.date)} 的週會`) : null,
    ),
    !settings.geminiKey ? el('div', { class: 'notice danger' }, '還沒設定 Gemini 鑰匙，AI 功能不能用。', el('button', { class: 'btn small', onclick: () => ctx.go('settings') }, '去設定')) : null,
    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '日期'), date),
        el('div', {}, el('label', {}, '這是第幾週？'), weekInfo),
        el('div', {}, el('label', {}, '分享的老師'), speaker),
      ),
      el('div', { class: 'output-head', style: 'margin-top:10px' }, el('label', { style: 'margin:0' }, '本週逐字稿'), tCount),
      transcript,
      el('div', { class: 'btns' }, el('button', { class: 'btn small', onclick: () => fileInput.click() }, '📎 上傳逐字稿文字檔'), fileInput),
      el('label', {}, '本週領袖挑戰（選填）'), hint,
      el('p', { class: 'muted' }, `AI 會照你給的兩篇範例格式整理：問候 → 【主題】→ 兩個小重點 → 收尾 → 【領袖挑戰】，${MAX} 字內。只會用逐字稿裡有講的內容。`),
      msg,
      el('div', { class: 'btns' }, genBtn),
    ),
    resultBox,
  ].filter(Boolean));
  updT();
  drawResult();
}
