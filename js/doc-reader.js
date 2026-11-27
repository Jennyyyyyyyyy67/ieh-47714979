// 📂 讀各種檔案：PDF、Word、PowerPoint、Excel、文字檔、照片、壓縮檔（.zip）
// 全部在老師自己的電腦上讀。讀出來的文字要送給 AI 之前，會先用 redactText 遮掉個資。
import { readXlsxBook } from './views/survey.js';
import { resizeImage, decodeText } from './utils.js';

// 讀檔工具放在公開的 CDN；第一個連不上，就換第二個
const CDN = {
  pdf: [
    { lib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', cmaps: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/' },
    { lib: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js', cmaps: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/' },
  ],
  zip: [{ lib: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js' }, { lib: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js' }],
  docx: [{ lib: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js' }, { lib: 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js' }],
};
const GLOBAL = { pdf: 'pdfjsLib', zip: 'JSZip', docx: 'mammoth' };
const LABEL = { pdf: 'PDF 讀取工具', zip: '壓縮檔讀取工具', docx: 'Word 讀取工具' };
const loaded = {};

const MAX_FILE = 40 * 1024 * 1024;     // 一個檔案最大 40MB
const MAX_BINARY = 14 * 1024 * 1024;   // 掃描檔／照片要整個送給 AI，最大 14MB（Google 一次最多約 20MB）
const MIN_PAGE_CHARS = 20;             // 一頁少於 20 個字，大概是掃描的圖片

export const ACCEPT = '.xlsx,.xls,.csv,.pdf,.docx,.pptx,.txt,.md,.zip,.doc,.ppt,image/*';

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(src)); };
    document.head.append(s);
  });
}

async function loadLib(kind) {
  if (window[GLOBAL[kind]]) return { lib: window[GLOBAL[kind]], cdn: loaded[kind] || CDN[kind][0] };
  for (const cdn of CDN[kind]) {
    try { await injectScript(cdn.lib); } catch { continue; }
    if (window[GLOBAL[kind]]) { loaded[kind] = cdn; return { lib: window[GLOBAL[kind]], cdn }; }
  }
  throw new Error(`無法載入${LABEL[kind]}，請檢查網路後再試一次。`);
}

const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp' };
const isImage = (file) => /^image\//.test(file.type) || /^(jpe?g|png|gif|webp|heic|heif|bmp)$/.test(extOf(file.name));

export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- PDF ----------

/** 讀出 PDF 每一頁的文字；同一行的字依左右排好（表格會變成一行一行） */
async function readPdf(buf) {
  const { lib: pdfjs, cdn } = await loadLib('pdf');
  pdfjs.GlobalWorkerOptions.workerSrc = cdn.worker;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), cMapUrl: cdn.cmaps, cMapPacked: true, isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('這個 PDF 有密碼，請先解除密碼再上傳。');
    throw new Error('這個 PDF 打不開，可能壞掉了。');
  }
  const pages = [];
  const emptyPages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 4); // 高度差不多（4pt 以內）就算同一行
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    const lines = [...rows.entries()].sort((a, b) => b[0] - a[0])
      .map(([, its]) => its.sort((a, b) => a.x - b.x).map(t => t.s).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const text = lines.join('\n');
    if (text.replace(/\s/g, '').length < MIN_PAGE_CHARS) emptyPages.push(i);
    pages.push(text);
  }
  return { text: pages.map((t, i) => (t ? `【第 ${i + 1} 頁】\n${t}` : '')).filter(Boolean).join('\n\n'), pages: doc.numPages, emptyPages };
}

// ---------- Word（.docx）：表格的每一列變成一行，用「 | 」隔開 ----------

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const lines = [];
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const walk = (node) => {
    for (const n of node.children) {
      if (n.tagName === 'TABLE') {
        for (const tr of n.querySelectorAll('tr')) lines.push([...tr.children].map(td => clean(td.textContent)).join(' | '));
      } else if (/^(P|H[1-6]|LI)$/.test(n.tagName)) lines.push(clean(n.textContent));
      else walk(n);
    }
  };
  walk(doc.body.firstElementChild);
  return lines.filter(l => l.replace(/[|\s]/g, '')).join('\n');
}

async function readDocx(buf) {
  const { lib: mammoth } = await loadLib('docx');
  const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
  return htmlToText(value);
}

// ---------- PowerPoint（.pptx）：每張投影片的文字 ----------

const unXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

async function readPptx(buf) {
  const { lib: JSZip } = await loadLib('zip');
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const out = [];
  for (const [i, n] of slides.entries()) {
    const xml = await zip.file(n).async('string');
    const paras = xml.split('</a:p>')
      .map(p => [...p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map(m => unXml(m[1])).join('').trim())
      .filter(Boolean);
    if (paras.length) out.push(`【第 ${i + 1} 張投影片】\n${paras.join('\n')}`);
  }
  return out.join('\n\n');
}

// ---------- Excel ----------

/** 是不是「踏查地點庫」範本（有「地點名稱」欄，或「地點」＋「去過」欄）？範本可以直接匯入，不用 AI */
export function isTemplateBook(book) {
  return Object.values(book).some(rows => rows.slice(0, 10).some(r =>
    r.some(c => /^地點名稱$/.test(c)) || (r.some(c => /^地點$/.test(c)) && r.some(c => /去過/.test(c)))));
}

const bookToText = (book) => Object.entries(book)
  .map(([name, rows]) => `【工作表：${name}】\n${rows.map(r => r.filter(Boolean).join(' | ')).filter(Boolean).join('\n')}`)
  .join('\n\n');

// ---------- 壓縮檔 ----------

/** 壓縮檔裡的中文檔名：Windows 做的常常是 Big5 */
function decodeFileName(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch { try { return new TextDecoder('big5').decode(u8); } catch { return String.fromCharCode(...u8); } }
}

async function unzip(file) {
  const { lib: JSZip } = await loadLib('zip');
  let zip;
  try { zip = await JSZip.loadAsync(await file.arrayBuffer(), { decodeFileName }); }
  catch { throw new Error('這個壓縮檔打不開（目前只支援 .zip，有密碼的也打不開）。'); }
  const entries = Object.values(zip.files).filter(f => !f.dir && !/(^|\/)(__MACOSX\/|\.|~\$)/.test(f.name));
  const files = [];
  for (const e of entries) {
    const base = e.name.split('/').pop();
    files.push(new File([await e.async('blob')], `${file.name} › ${base}`, { type: MIME[extOf(base)] || '' }));
  }
  return files;
}

// ---------- 全部一起讀 ----------

/**
 * 讀很多個檔案。回傳：
 *   items：{ source, kind: 'template', book }  範本 Excel（直接匯入）
 *          { source, kind: 'text', text, how, note } 讀得到文字的（之後先遮個資再給 AI）
 *          { source, kind: 'binary', mime, base64, bytes, how } 掃描的 PDF、照片（整個給 AI 看）
 *   skipped：{ source, why } 讀不到的檔案和原因
 */
export async function readFiles(fileList, onProgress = () => {}) {
  const queue = [...fileList].map(file => ({ file, depth: 0 }));
  const items = [];
  const skipped = [];
  let n = 0;
  while (queue.length) {
    const { file, depth } = queue.shift();
    const source = file.name;
    const ext = extOf(source);
    onProgress(`讀取中：${source}（第 ${++n} 個）`);
    try {
      if (file.size > MAX_FILE) { skipped.push({ source, why: `檔案太大（超過 ${MAX_FILE / 1048576}MB），請拆成小一點的檔案。` }); continue; }
      if (ext === 'zip') {
        if (depth >= 2) { skipped.push({ source, why: '壓縮檔裡面又包了好幾層壓縮檔，請先解開再上傳。' }); continue; }
        const inner = await unzip(file);
        if (!inner.length) skipped.push({ source, why: '壓縮檔裡沒有檔案。' });
        queue.push(...inner.map(f => ({ file: f, depth: depth + 1 })));
        continue;
      }
      if (ext === 'pdf') {
        const buf = await file.arrayBuffer();
        const r = await readPdf(buf);
        if (r.emptyPages.length === r.pages) {
          if (buf.byteLength > MAX_BINARY) { skipped.push({ source, why: `這是掃描的 PDF（沒有文字），而且太大（超過 ${MAX_BINARY / 1048576}MB），請拆成幾個小檔案。` }); continue; }
          items.push({ source, kind: 'binary', mime: 'application/pdf', base64: toBase64(buf), bytes: buf.byteLength, how: `掃描的 PDF（${r.pages} 頁，沒有文字）` });
        } else {
          const note = r.emptyPages.length ? `第 ${r.emptyPages.join('、')} 頁是圖片，讀不到文字。` : '';
          items.push({ source, kind: 'text', text: r.text, how: `PDF（${r.pages} 頁）`, note });
        }
        continue;
      }
      if (ext === 'docx') { items.push({ source, kind: 'text', text: await readDocx(await file.arrayBuffer()), how: 'Word' }); continue; }
      if (ext === 'pptx') { items.push({ source, kind: 'text', text: await readPptx(await file.arrayBuffer()), how: 'PowerPoint' }); continue; }
      if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
        const book = await readXlsxBook(file);
        if (isTemplateBook(book)) items.push({ source, kind: 'template', book });
        else items.push({ source, kind: 'text', text: bookToText(book), how: 'Excel' });
        continue;
      }
      if (ext === 'txt' || ext === 'md') { items.push({ source, kind: 'text', text: decodeText(await file.arrayBuffer()), how: '文字檔' }); continue; }
      if (isImage(file)) {
        const img = await resizeImage(file, 2000, 0.85);
        items.push({ source, kind: 'binary', mime: img.mimeType, base64: img.base64, bytes: img.bytes, how: '照片' });
        continue;
      }
      if (ext === 'doc') { skipped.push({ source, why: '舊版 Word（.doc）讀不到：請在 Word 按「另存新檔」，存成 .docx 或 PDF 再上傳。' }); continue; }
      if (ext === 'ppt') { skipped.push({ source, why: '舊版 PowerPoint（.ppt）讀不到：請另存成 .pptx 或 PDF 再上傳。' }); continue; }
      skipped.push({ source, why: '看不懂這種檔案。可以用：Excel、PDF、Word（.docx）、PowerPoint（.pptx）、文字檔、照片、壓縮檔（.zip）。' });
    } catch (e) {
      skipped.push({ source, why: e.message || String(e) });
    }
  }
  // 讀到的文字是空的，也算讀不到
  const kept = items.filter(it => it.kind !== 'text' || it.text.replace(/\s/g, ''));
  for (const it of items) if (!kept.includes(it)) skipped.push({ source: it.source, why: '裡面沒有讀到文字。' });
  return { items: kept, skipped };
}

// ---------- 遮掉個資（送給 AI 之前） ----------

// 有這些字的整行直接拿掉（名單、懲處、健康、身分資料）
const DROP_LINE = /禁足|違規|懲處|記過|記警告|座號|學號|身分證|生日|過敏|病史|監護人|住址|戶籍|成績/;
// 結尾是這些字的，比較像地名，不是人名
const PLACE_END = /(館|園|區|站|廠|中心|公司|局|所|署|院|宮|寺|廟|街|路|山|湖|港|島|村|社|堂|府|樓|塔|場|處|會|店|坊|室|灣|溪|河|橋|城|鎮|鄉|里|台|臺|校|部|圖)$/;

/** 一行裡有 4 個以上「2～3 個中文字」、用頓號或空白隔開，又沒有數字：很像名單（例如禁足名單） */
const HEADER_WORDS = /日期|地點|週次|時間|行程|交通|備註|內容|活動|主題|名稱|預約|室內|室外|天氣/;
export function looksLikeNameList(line) {
  if (/\d/.test(line) || HEADER_WORDS.test(line)) return false;
  const toks = line.split(/[、，,;；\s|]+/).filter(Boolean);
  return toks.length >= 4 && toks.every(t => /^[一-鿿]{2,3}$/.test(t) && !PLACE_END.test(t));
}

/**
 * 把文字裡可能的個資遮掉：問卷名單裡的學生名字、電話、Email、身分證、班級、○○老師，
 * 還有「禁足／座號／生日…」那幾行、看起來像名單的行。回傳 { text, counts }。
 */
export function redactText(text, names = []) {
  const counts = { names: 0, phones: 0, emails: 0, ids: 0, people: 0, lines: 0 };
  const nameList = [...new Set(names.map(s => String(s).trim()).filter(s => s.length >= 2))].sort((a, b) => b.length - a.length);
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (DROP_LINE.test(raw) || looksLikeNameList(raw)) { counts.lines++; continue; }
    let line = raw;
    for (const nm of nameList) {
      if (line.includes(nm)) { counts.names += line.split(nm).length - 1; line = line.split(nm).join('○○'); }
    }
    line = line
      .replace(/(?:\+?886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, () => { counts.phones++; return '（電話）'; })
      .replace(/\(?0\d{1,2}\)?[-\s]?\d{3,4}[-\s]?\d{4}/g, () => { counts.phones++; return '（電話）'; })
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => { counts.emails++; return '（Email）'; })
      .replace(/\b[A-Z][12]\d{8}\b/g, () => { counts.ids++; return '（身分證）'; })
      .replace(/[0-9０-９一二三四五六七八九十]+\s*年\s*[0-9０-９一二三四五六七八九十甲乙丙丁]+\s*班/g, () => { counts.ids++; return '（班級）'; })
      .replace(/(?<=^|[\s、，,:：（(|])[一-鿿]{1,3}(?=\s*(?:老\s*師|先\s*生|小\s*姐|主\s*任|組\s*長|校\s*長|教\s*授|阿\s*姨|叔\s*叔|同\s*學))/g, () => { counts.people++; return '○'; });
    out.push(line);
  }
  return { text: out.join('\n'), counts };
}

export function redactSummary(c) {
  const parts = [];
  if (c.names) parts.push(`學生名字 ${c.names} 個`);
  if (c.people) parts.push(`○○老師／先生等稱呼 ${c.people} 個`);
  if (c.phones) parts.push(`電話 ${c.phones} 個`);
  if (c.emails) parts.push(`Email ${c.emails} 個`);
  if (c.ids) parts.push(`身分證／班級 ${c.ids} 個`);
  if (c.lines) parts.push(`名單、禁足等整行 ${c.lines} 行`);
  return parts.join('、');
}

// ---------- 分批送給 AI ----------

function splitText(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

/** 文字合在一起送（每批最多 maxChars 字，太長的檔案切段）；掃描檔和照片一個一批 */
export function makeBatches(items, maxChars = 20000) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const it of items.filter(i => i.kind === 'text')) {
    const chunks = splitText(it.text, maxChars);
    chunks.forEach((t, k) => {
      if (cur.length && size + t.length > maxChars) { batches.push({ docs: cur }); cur = []; size = 0; }
      cur.push({ source: it.source, label: chunks.length > 1 ? `${it.source}（第 ${k + 1} 段）` : it.source, text: t });
      size += t.length;
    });
  }
  if (cur.length) batches.push({ docs: cur });
  for (const it of items.filter(i => i.kind === 'binary')) batches.push({ binary: it });
  return batches;
}
