// 🎙️ 錄音：在瀏覽器裡錄，錄完交給 Gemini 轉成文字。錄音只放在記憶體，轉完就丟掉，不存檔。
export const MAX_AUDIO_BYTES = 14 * 1024 * 1024; // 轉成 base64 會變大約 1/3，Gemini 單次請求上限約 20MB

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function recordingSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');
}

function friendlyMicError(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return '沒有麥克風權限。請按網址列左邊的鎖頭圖示，把「麥克風」改成允許，再試一次。';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return '找不到麥克風，請確認裝置有麥克風。';
  if (n === 'NotReadableError') return '麥克風正被別的程式使用，請先關掉它再試。';
  return `無法開始錄音：${e?.message || n}`;
}

/** 副檔名猜錄音檔的格式（手機有時會給空白的 type） */
export function audioMimeFor(file) {
  if (file.type && file.type.startsWith('audio/')) return file.type.split(';')[0];
  const ext = (file.name.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm', aiff: 'audio/aiff' })[ext] || '';
}

export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * 開始錄音。回傳 { stop(): Promise<{blob, mime, truncated}>, cancel() }。
 * onTick(seconds, bytes) 每秒呼叫；超過大小上限會自動停止（onAutoStop 會被呼叫）。
 */
export async function startRecording({ onTick, onAutoStop } = {}) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { throw new Error(friendlyMicError(e)); }
  const mimeType = MIME_CANDIDATES.find(m => MediaRecorder.isTypeSupported?.(m)) || '';
  const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 24000 });
  const chunks = []; let bytes = 0; let truncated = false; let finish;
  const done = new Promise(r => { finish = r; });
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; } // 盡量不讓螢幕自己暗掉
  const t0 = Date.now();
  const timer = setInterval(() => onTick?.(Math.round((Date.now() - t0) / 1000), bytes), 1000);
  const cleanup = () => { clearInterval(timer); stream.getTracks().forEach(t => t.stop()); try { wake?.release(); } catch { /* ignore */ } };
  rec.ondataavailable = e => {
    if (!e.data?.size) return;
    chunks.push(e.data); bytes += e.data.size;
    if (bytes >= MAX_AUDIO_BYTES - 512 * 1024 && rec.state === 'recording') { truncated = true; rec.stop(); onAutoStop?.(); }
  };
  rec.onstop = () => { cleanup(); finish({ blob: new Blob(chunks, { type: (rec.mimeType || mimeType || 'audio/webm').split(';')[0] }), mime: (rec.mimeType || mimeType || 'audio/webm').split(';')[0], truncated }); };
  rec.start(1000);
  return {
    stop: () => { if (rec.state !== 'inactive') rec.stop(); return done; },
    cancel: () => { chunks.length = 0; if (rec.state !== 'inactive') { rec.onstop = cleanup; rec.stop(); } else cleanup(); },
  };
}
