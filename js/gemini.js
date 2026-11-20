// 呼叫 Google Gemini（免費額度）。鑰匙由老師在「設定」頁貼上，不寫在程式碼裡。
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-2.5-flash';

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
export async function callGemini({ apiKey, model, parts, schema, temperature = 0.4 }) {
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
  if (!res.ok) throw new Error(friendlyError(res.status, text));
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
