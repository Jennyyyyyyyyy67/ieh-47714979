// ⛪ 週會家長信：貼上逐字稿 → AI 照範例整理成 300 字內
import { el, todayISO, toROC, countChars } from '../utils.js';
import { callGemini, DEFAULT_MODEL } from '../gemini.js';
import { MEETING_SCHEMA, meetingPrompt, TRANSCRIBE_SCHEMA, transcribePrompt } from '../prompts.js';
import { recordingSupported, startRecording, blobToBase64, audioMimeFor, MAX_AUDIO_BYTES } from '../recorder.js';
import { publishChecklist, outputBlock, spinnerButton } from './common.js';

const MAX = 300;
let M = null;
let activeRec = null; // 正在錄音的話，離開這一頁時要停掉（不留麥克風開著）
const fresh = () => ({ id: null, date: todayISO(), weekInfo: '本週', speaker: '', transcript: '', challengeHint: '', letter: '' });

export async function renderMeeting(root, ctx) {
  const { store, toast } = ctx;
  const settings = ctx.settings || {};
  if (ctx.params?.meeting) { M = { ...fresh(), ...ctx.params.meeting }; ctx.params = null; }
  if (!M) M = fresh();
  if (!M.speaker) M.speaker = settings.speaker || '蓓禎老師';
  if (activeRec) { activeRec.cancel(); activeRec = null; toast('離開了週會頁，上一段錄音已經中止'); }

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

  // ===== 🎙️ 錄音 → 逐字稿 =====
  const consent = el('input', { type: 'checkbox' });
  const recBtn = el('button', { class: 'btn primary', disabled: true }, '🔴 開始錄音');
  const stopBtn = el('button', { class: 'btn', hidden: true }, '⏹️ 停止並轉成文字');
  const upBtn = el('button', { class: 'btn', disabled: true }, '📂 上傳錄音檔');
  const audioInput = el('input', { type: 'file', accept: 'audio/*,.m4a,.mp3,.wav,.aac,.ogg,.flac,.webm', hidden: true });
  const recMsg = el('div');
  const recStatus = el('div', { class: 'muted' });
  consent.addEventListener('change', () => { recBtn.disabled = !consent.checked || !recordingSupported(); upBtn.disabled = !consent.checked; });
  const fmtTime = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  async function transcribe(blob, mime, note) {
    if (!settings.geminiKey) { recMsg.replaceChildren(el('div', { class: 'notice danger' }, '還沒設定 Gemini 鑰匙，請先到「⚙️ 設定」。')); return; }
    if (blob.size > MAX_AUDIO_BYTES) { recMsg.replaceChildren(el('div', { class: 'notice danger' }, `錄音檔太大了（${(blob.size / 1048576).toFixed(1)}MB，上限約 ${Math.round(MAX_AUDIO_BYTES / 1048576)}MB）。請分成兩段，或用手機錄音 App 壓成較小的檔案。`)); return; }
    if (!blob.size) { recMsg.replaceChildren(el('div', { class: 'notice danger' }, '錄音是空的，沒有聲音進來。')); return; }
    const done = spinnerButton(stopBtn.hidden ? upBtn : stopBtn, 'AI 正在聽、轉成文字…');
    recStatus.textContent = '';
    try {
      const data = await blobToBase64(blob);
      const out = await callGemini({
        apiKey: settings.geminiKey, model: settings.model || DEFAULT_MODEL, temperature: 0.1, schema: TRANSCRIBE_SCHEMA,
        parts: [{ text: transcribePrompt() }, { inline_data: { mime_type: mime, data } }],
      });
      const text = String(out.transcript || '').trim();
      if (!text) { recMsg.replaceChildren(el('div', { class: 'notice warn' }, 'AI 沒有聽到內容（可能太小聲或只有雜音）。')); }
      else {
        transcript.value = transcript.value.trim() ? `${transcript.value.trim()}

${text}` : text;
        M.transcript = transcript.value; updT();
        recMsg.replaceChildren(el('div', { class: 'notice ok' }, `✅ 已轉成文字，放進下面的逐字稿欄。${note || ''}請聽著或對照原本的錄音檢查：人名、經文、數字容易聽錯。`));
      }
    } catch (e) {
      const bad = /400|格式|mime|Unsupported/i.test(e.message);
      recMsg.replaceChildren(el('div', { class: 'notice danger' }, e.message, bad ? '　這個錄音格式 Gemini 可能不收，請改傳 mp3、m4a、wav 或 aac 檔。' : ''));
    }
    done();
  }

  recBtn.addEventListener('click', async () => {
    recMsg.replaceChildren();
    try {
      activeRec = await startRecording({
        onTick: (s, bytes) => { recStatus.textContent = `🔴 錄音中 ${fmtTime(s)}（${(bytes / 1048576).toFixed(1)}MB）。請不要切換分頁，也不要鎖螢幕。`; },
        onAutoStop: () => { toast('錄音檔快要超過上限，已自動停止並轉成文字'); },
      });
    } catch (e) { recMsg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); return; }
    recBtn.hidden = true; upBtn.hidden = true; stopBtn.hidden = false; consent.disabled = true;
    recStatus.textContent = '🔴 錄音中…';
    // 自動停止時，也要接著轉文字
    const rec = activeRec;
    stopBtn.onclick = async () => {
      const r = await rec.stop();
      activeRec = null;
      stopBtn.hidden = true; recBtn.hidden = false; upBtn.hidden = false; consent.disabled = false;
      recStatus.textContent = '';
      await transcribe(r.blob, r.mime, r.truncated ? '（錄音太長，已在上限處截斷，後面的部分沒有轉。）' : '');
      stopBtn.hidden = true;
    };
  });
  upBtn.addEventListener('click', () => audioInput.click());
  audioInput.addEventListener('change', async () => {
    const f = audioInput.files[0];
    audioInput.value = '';
    if (!f) return;
    const mime = audioMimeFor(f);
    if (!mime) { recMsg.replaceChildren(el('div', { class: 'notice danger' }, `「${f.name}」看不出是什麼聲音格式，請改傳 mp3、m4a、wav 或 aac 檔。`)); return; }
    recMsg.replaceChildren();
    await transcribe(f, mime, '');
  });

  const recCard = el('div', { class: 'card' },
    el('h2', {}, '🎙️ 錄音轉逐字稿（選填）'),
    el('p', { class: 'muted' }, '直接錄週會，或上傳已經錄好的檔案，AI 會幫你轉成文字，放進下面的逐字稿欄。錄音只留在這個畫面，轉完就丟掉，不會存起來。'),
    el('div', { class: 'notice warn' }, '⚠️ 錄音檔會傳給 Google 轉成文字（免費版的資料，Google 可能拿去改進產品）。錄音裡如果有孩子的聲音，要先確認有同意。'),
    el('label', { class: 'inline' }, consent, el('strong', {}, '我確認可以把這段錄音傳給 Google 轉成文字')),
    !recordingSupported() ? el('div', { class: 'notice warn' }, '這個瀏覽器不支援直接錄音，可以用手機的錄音 App 錄好，再按「上傳錄音檔」。') : null,
    el('div', { class: 'btns' }, recBtn, stopBtn, upBtn, audioInput),
    recStatus, recMsg,
    el('p', { class: 'muted' }, '💡 手機螢幕鎖定時，網頁錄音可能會中斷。比較穩的方法：用手機內建的錄音 App 錄，再上傳。'),
  );

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
    recCard,
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
