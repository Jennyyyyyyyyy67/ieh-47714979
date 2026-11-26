// 和「郵差」（Google Apps Script）溝通。
// 為什麼這麼麻煩：Google 的郵差不太接受網頁直接讀它的回覆（瀏覽器的安全規則，叫 CORS），
// 所以「送東西過去」用不需要回覆的方式送，「查結果」用 <script> 的方式讀（叫 JSONP）。

let seq = 0;
/** 查郵差的狀態（或檢查連線）。回傳郵差的回答，失敗會丟出白話錯誤。 */
export function askPostman(url, secret, action = 'status', timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error('還沒有設定郵差網址，請到「⚙️ 設定」貼上。'));
    const cb = `__postman_cb_${Date.now()}_${seq++}`;
    const s = document.createElement('script');
    const cleanup = () => { delete window[cb]; s.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('郵差沒有回應。請檢查郵差網址，或郵差的「部署」是不是選了「所有人」都能存取。')); }, timeoutMs);
    window[cb] = (data) => { cleanup(); if (data && data.ok) resolve(data); else reject(new Error(data?.error || '郵差回覆錯誤')); };
    s.onerror = () => { cleanup(); reject(new Error('連不上郵差。請檢查郵差網址是不是貼對了（要用 /exec 結尾的那個）。')); };
    const q = new URLSearchParams({ action, secret: secret || '', callback: cb });
    s.src = `${url}${url.includes('?') ? '&' : '?'}${q}`;
    document.head.appendChild(s);
  });
}

/** 送東西給郵差（排程、取消、重試）。送出後再查一次狀態，確認郵差真的收到了。 */
export async function tellPostman(url, secret, action, extra = {}, { verify, tries = 4, waitMs = 1500 } = {}) {
  if (!url) throw new Error('還沒有設定郵差網址，請到「⚙️ 設定」貼上。');
  try {
    await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, secret, ...extra }) });
  } catch {
    throw new Error('連不上郵差，請檢查網路。');
  }
  // 看不到郵差的回覆，所以再問一次狀態，確認真的有收到
  for (let i = 0; i < tries; i++) {
    const st = await askPostman(url, secret, 'status');
    if (!verify || verify(st)) return st;
    await new Promise(r => setTimeout(r, waitMs));
  }
  throw new Error('郵差好像沒有收到。請再按一次，或按「重新整理狀態」看看。');
}

export const STATUS_TEXT = {
  scheduled: '⏳ 已排好，時間到會自動發送',
  sending: '📮 發送中…',
  sent: '✅ 已發送',
  partial: '⚠️ 只有一部分發送成功',
  failed: '❌ 發送失敗',
  cancelled: '🚫 已取消',
  expired: '⌛ 太晚才被郵差看到，為了安全沒有發送',
};
