// 呼叫 Google Gemini（免費額度）。鑰匙由老師在「設定」頁貼上，不寫在程式碼裡。
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.8-flash';

// Google 下架舊模型時，會在錯誤訊息裡建議新模型。系統會自動換過去，並通知設定頁存起來。
let onModelUpgrade = null;
export function setModelUpgradeHandler(fn) { onModelUpgrade = fn; }

/** 從錯誤訊息找出 Google 建議的新模型，例如「use models/gemini-3.8-flash」 */
export function suggestedModel(message) {
  const m = String(message || '').match(/use\s+models\/([\w.-]+)/i);
  return m ? m[1] : null;
}

/** 從可用的模型裡，挑最新的一般版 flash（例如 gemini-3.8-flash） */
export function pickBestFlash(models) {
  const plain = models.filter(n => /^gemini-[\d.]+-flash$/.test(n));
  const ver = n => n.match(/^gemini-([\d.]+)-/)[1].split('.').map(Number);
  plain.sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); } return 0; });
  return plain[0] || models.find(n => /flash/.test(n)) || null;
}

/** 從可用的模型裡，挑最新的「lite」（較快、較省，品質可能稍差） */
export function pickFastModel(models) {
  const lite = models.filter(n => /^gemini-[\d.]+-flash-lite$/.test(n));
  const ver = n => n.match(/^gemini-([\d.]+)-/)[1].split('.').map(Number);
  lite.sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); } return 0; });
  return lite[0] || models.find(n => /flash-lite/.test(n)) || null;
}
/** 還沒按過「檢查鑰匙」時的猜測：一般模型名稱後面加 -lite */
export const guessFastModel = (model) => `${(model || DEFAULT_MODEL).replace(/-lite$/, '')}-lite`;

function friendlyError(status, bodyText) {
  let msg = '';
  try { msg = JSON.parse(bodyText)?.error?.message || ''; } catch { msg = bodyText.slice(0, 200); }
  if (status === 400 && /API key/i.test(msg)) return 'Gemini 鑰匙不正確，請到「設定」重新貼上。';
  if (status === 403) return 'Gemini 鑰匙沒有權限（可能貼錯，或還沒啟用）。請到「設定」檢查。';
  if (status === 404) return `找不到這個模型名稱，請到「設定」按「檢查鑰匙」換一個模型。（${msg}）`;
  if (status === 429) return '今天（或這一分鐘）的免費次數用完了，請等一下再試。';
  if (status >= 500) return 'Gemini 那邊暫時忙不過來，請過幾分鐘再試。';
  return `Gemini 回覆錯誤（${status}）：${msg}`;
}

/**
 * parts：[{text}] 或 [{inline_data:{mime_type,data}}]
 * schema：要 Gemini 照這個格式回答（JSON）
 */
// Google 那邊太擠（5xx）的時候，自動等一下再試，不用老師一直按。
const RETRY_DELAYS = [2000, 5000, 10000];
let onRetry = null;
export function setRetryHandler(fn) { onRetry = fn; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function callGemini(opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callWithUpgrade(opts);
    } catch (e) {
      if (!e.retryable || attempt >= RETRY_DELAYS.length) throw e;
      if (onRetry) onRetry(attempt + 1, RETRY_DELAYS.length);
      await sleep(opts.retryDelays?.[attempt] ?? RETRY_DELAYS[attempt]);
    }
  }
}

async function callWithUpgrade(opts) {
  try {
    return await callOnce(opts);
  } catch (e) {
    const next = e.status === 404 && opts.upgrade !== false ? suggestedModel(e.raw) : null;
    if (!next || next === opts.model) throw e;
    const out = await callOnce({ ...opts, model: next });
    if (onModelUpgrade) onModelUpgrade(next);
    return out;
  }
}

async function callOnce({ apiKey, model, parts, schema, temperature = 0.4 }) {
  if (!apiKey) throw new Error('還沒有設定 Gemini 鑰匙，請先到「⚙️ 設定」頁貼上。');
  const url = `${BASE}/models/${encodeURIComponent(model || DEFAULT_MODEL)}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, responseMimeType: 'application/json', ...(schema ? { responseSchema: schema } : {}) },
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('連不上 Gemini，請檢查網路。');
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(friendlyError(res.status, text));
    err.status = res.status;
    err.raw = text;
    // 5xx＝Google 太擠；429 且不是「今天的額度用完」＝一分鐘內太多次，等一下就好
    err.retryable = res.status >= 500 || (res.status === 429 && !/PerDay|per day/i.test(text));
    throw err;
  }
  const data = JSON.parse(text);
  const cand = data.candidates?.[0];
  const out = cand?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!out) {
    const reason = data.promptFeedback?.blockReason || cand?.finishReason || '不明';
    throw new Error(`Gemini 沒有給出內容（原因：${reason}）。可以換幾張照片或稍後再試。`);
  }
  try { return JSON.parse(out); }
  catch { throw new Error('Gemini 回覆的格式不正確，請再按一次。'); }
}

/** 檢查鑰匙能不能用，並列出可以用的模型 */
export async function listModels(apiKey) {
  let res;
  try { res = await fetch(`${BASE}/models?pageSize=100`, { headers: { 'x-goog-api-key': apiKey } }); }
  catch { throw new Error('連不上 Gemini，請檢查網路。'); }
  const text = await res.text();
  if (!res.ok) throw new Error(friendlyError(res.status, text));
  const data = JSON.parse(text);
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /gemini/.test(n));
}
