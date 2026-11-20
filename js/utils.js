// 小工具：建立畫面元素、日期、CSV、照片縮小、個資檢查

/** 建立 DOM 元素（文字一律用 textContent，避免被插入惡意程式碼） */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else if (k === 'disabled') node.disabled = !!v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 今天的日期 yyyy-mm-dd（本地時間） */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 2026-11-17 → 115/11/17（民國年） */
export function toROC(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${y - 1911}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

/** 問卷標題，例如「115/11/17 戶外踏查1-2年級問卷_高雄市立總圖書館」 */
export function surveyTitle(iso, gradeLabel, place) {
  return `${toROC(iso)} 戶外踏查${gradeLabel}問卷_${place || '（地點）'}`;
}

/** 計算字數：不算空白和換行 */
export function countChars(text) {
  return (text || '').replace(/\s/g, '').length;
}

// ---------- CSV ----------

/** 解析 CSV（支援雙引號包住的欄位、欄位裡的逗號與換行） */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = (text || '').replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

/** 把「;」「；」「、」分隔的字串切成清單 */
export function splitList(s) {
  return (s || '').split(/[;；、\n]/).map(x => x.trim()).filter(Boolean);
}

const HEADER_WORDS = ['年級', '學科', '類別', '單元', '主題', '概念', '目標'];

/**
 * 把多行文字或 CSV 轉成主題資料。
 * 每一行：年級,學科,單元名稱,概念1;概念2,目標1;目標2
 * 也接受 Tab 分隔（從 Excel / Google 試算表直接複製）。
 */
export function parseTopicsText(text) {
  const raw = (text || '').trim();
  if (!raw) return { topics: [], errors: [] };
  const firstLine = raw.split(/\r?\n/)[0];
  const rows = firstLine.includes('\t') && !firstLine.includes(',')
    ? raw.split(/\r?\n/).filter(l => l.trim()).map(l => l.split('\t'))
    : parseCSV(raw);
  const topics = [], errors = [];
  rows.forEach((r, idx) => {
    const cells = r.map(c => (c || '').trim());
    if (idx === 0 && HEADER_WORDS.some(w => cells.join('').includes(w)) && cells.length >= 3 &&
        HEADER_WORDS.filter(w => cells.join('').includes(w)).length >= 2) return; // 標題列
    const [grade = '', subject = '', name = '', concepts = '', goals = ''] = cells;
    if (!name) { errors.push(`第 ${idx + 1} 行沒有「單元／主題名稱」，已略過`); return; }
    topics.push({ grade, subject, name, concepts: splitList(concepts), goals: splitList(goals) });
  });
  return { topics, errors };
}

export function topicsToCSV(topics) {
  return toCSV([
    ['年級', '學科／類別', '單元／主題名稱', '學習概念（用 ; 分隔）', '學習目標（用 ; 分隔）'],
    ...topics.map(t => [t.grade, t.subject, t.name, (t.concepts || []).join(';'), (t.goals || []).join(';')]),
  ]);
}

// ---------- 照片縮小 ----------

/**
 * 在手機／電腦上先把照片縮小（長邊最多 maxSide 像素），轉成 JPEG。
 * 重新畫一次也會順便去掉照片裡的 GPS 位置等隱藏資訊。
 */
export async function resizeImage(file, maxSide = 1280, quality = 0.8) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`「${file.name}」無法讀取，可能是 HEIC 格式。請改用 JPG/PNG，或用 iPhone 的「相機設定 → 格式 → 最相容」。`));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = source.width, h = source.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  canvas.getContext('2d').drawImage(source, 0, 0, cw, ch);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return {
    name: file.name,
    originalBytes: file.size,
    width: cw, height: ch,
    dataUrl,
    base64: dataUrl.split(',')[1],
    bytes: Math.round(dataUrl.split(',')[1].length * 3 / 4),
    mimeType: 'image/jpeg',
  };
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- 個資檢查 ----------

const PII_RULES = [
  { re: /座號/g, why: '提到「座號」' },
  { re: /學號/g, why: '提到「學號」' },
  { re: /[0-9０-９一二三四五六七八九十]+\s*年\s*[0-9０-９一二三四五六七八九十甲乙丙丁]+\s*班/g, why: '像是班級（○年○班）' },
  { re: /(?<![月\/\d])\b\d{1,2}\s*號(?!\s*[出入口線])/g, why: '像是座號（○號）' },
  { re: /09\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, why: '像是手機號碼' },
  { re: /\b[A-Z][12]\d{8}\b/g, why: '像是身分證字號' },
  { re: /[\w.+-]+@[\w-]+\.[\w.]+/g, why: '像是 Email' },
];

/**
 * 檢查文案裡有沒有個資。names 是老師臨時輸入、不會被儲存的學生名字。
 * 回傳 [{text, why}]
 */
export function findPII(text, names = []) {
  const hits = [];
  const t = text || '';
  for (const rule of PII_RULES) {
    for (const m of t.matchAll(rule.re)) hits.push({ text: m[0], why: rule.why });
  }
  for (const n of names) {
    const name = n.trim();
    if (name.length >= 2 && t.includes(name)) hits.push({ text: name, why: '出現了你輸入的學生名字' });
    // 也檢查「名字去掉姓」的叫法，例如「小明」
    if (name.length === 3 && t.includes(name.slice(1))) hits.push({ text: name.slice(1), why: '出現了學生名字（去掉姓）' });
  }
  const seen = new Set();
  return hits.filter(h => { const k = h.text + h.why; if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: 'position:fixed;left:-9999px' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function downloadFile(name, text, type = 'text/csv') {
  const blob = new Blob(['﻿' + text], { type: `${type};charset=utf-8` });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 每週發送時間 ----------

/** 這週的發送時間（預設週二 17:00）。weekday：0=日 1=一 2=二 … */
export function thisWeekSendTime(now = new Date(), weekday = 2, hhmm = '17:00') {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h || 0, m || 0, 0, 0);
  d.setDate(d.getDate() + (weekday - d.getDay()));
  return d;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
export function weekdayName(n) { return WEEKDAYS[n] ?? ''; }

export function formatDateTime(d) {
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- 問卷檢查 ----------

/** 名字比對用：去掉空白、全形轉半形、英文轉小寫 */
export function normName(s) {
  return String(s || '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, '')
    .toLowerCase();
}

/** Google 表單的「時間戳記」轉成 Date，例如「2026/11/17 下午 8:05:12」 */
export function parseFormTimestamp(s) {
  const t = String(s || '').trim();
  const m = t.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s*(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;
  let [, y, mo, d, ap1, hh, mm, ss, ap2] = m;
  let h = Number(hh);
  const ap = (ap1 || ap2 || '').toUpperCase();
  if ((ap === '下午' || ap === 'PM') && h < 12) h += 12;
  if ((ap === '上午' || ap === 'AM') && h === 12) h = 0;
  return new Date(Number(y), Number(mo) - 1, Number(d), h, Number(mm), Number(ss || 0));
}

/** 把「8 / 10」「8/10」拆成 {got, total} */
export function parseScore(s) {
  const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  return m ? { got: Number(m[1]), total: Number(m[2]) } : null;
}
