// 各頁面共用的小元件
import { el, copyText, findPII, countChars } from '../utils.js';

export const CHECK_ITEMS = [
  '照片裡的每一位學生都有肖像同意（沒有同意的已經排除）',
  '文案裡沒有個資（學生姓名、班級、座號、電話等）',
  '內容都是真的有發生的事（已對照行程表／學習單）',
  '活動已經結束，而且已經到了發送時間（每週二 17:00），我確認過了',
];

/**
 * 發布前檢查清單。四項都勾了才會呼叫 onChange(true)。
 */
export function publishChecklist(onChange) {
  const boxes = CHECK_ITEMS.map(text => {
    const cb = el('input', { type: 'checkbox' });
    cb.addEventListener('change', () => onChange(boxes.every(b => b.cb.checked)));
    return { cb, row: el('label', { class: 'inline' }, cb, el('span', {}, text)) };
  });
  const box = el('div', { class: 'checklist' },
    el('strong', {}, '✅ 發布前檢查清單（4 項都勾了，複製和發布的按鈕才會亮）'),
    ...boxes.map(b => b.row),
  );
  box.reset = () => { boxes.forEach(b => { b.cb.checked = false; }); onChange(false); };
  return box;
}

/**
 * 一個可以編輯、檢查個資、複製的文案區塊。
 * opts.gated：要不要等檢查清單完成才能複製
 * opts.getNames：回傳老師臨時輸入的學生名字（只用來檢查）
 * opts.maxChars：字數上限（顯示計數）
 */
export function outputBlock({ title, text, gated = false, getNames = () => [], maxChars, hint, extraButtons = [], onEdit }) {
  const ta = el('textarea', { class: 'output' });
  ta.value = text || '';
  const warn = el('div');
  const counter = el('span', { class: 'counter' });
  const copyBtn = el('button', { class: 'btn small primary' }, '📋 一鍵複製');
  copyBtn.disabled = gated;
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(ta.value);
    copyBtn.textContent = ok ? '✅ 已複製' : '❌ 複製失敗，請手動選取';
    setTimeout(() => { copyBtn.textContent = '📋 一鍵複製'; }, 1800);
  });
  const refresh = () => {
    const n = countChars(ta.value);
    counter.textContent = maxChars ? `${n} / ${maxChars} 字` : `${n} 字`;
    counter.classList.toggle('over', !!maxChars && n > maxChars);
    const hits = findPII(ta.value, getNames());
    warn.replaceChildren(...(hits.length ? [el('div', { class: 'notice danger' },
      '⚠️ 可能有個資，請檢查：',
      ...hits.map(h => el('span', { class: 'tag warn' }, `「${h.text}」${h.why}`)),
    )] : []));
    if (onEdit) onEdit(ta.value);
  };
  ta.addEventListener('input', refresh);
  const block = el('div', { class: 'output-block' },
    el('div', { class: 'output-head' }, el('h3', {}, title), el('div', { class: 'btns', style: 'margin:0' }, counter, ...extraButtons, copyBtn)),
    hint ? el('p', { class: 'muted' }, hint) : null,
    ta, warn,
  );
  refresh();
  block.setGate = (open) => { if (gated) copyBtn.disabled = !open; };
  block.getText = () => ta.value;
  block.setText = (t) => { ta.value = t; refresh(); };
  block.refresh = refresh;
  return block;
}

export function spinnerButton(btn, label) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.replaceChildren(el('span', { class: 'spinner' }), ` ${label}`);
  return () => { btn.disabled = false; btn.textContent = old; };
}

export const LINKS = {
  lineManager: 'https://manager.line.biz/',
  businessSuite: 'https://business.facebook.com/latest/home',
};
