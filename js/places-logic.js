// 踏查地點的規則（不用 AI、不用網路，全部在老師的電腦上算）
import { normName, toROC } from './utils.js';

export const DEFAULT_QUARTER_START = '2026-11-16'; // 本學季開學日（週一）
export const TRIP_WEEKDAY = 2;                      // 每週二踏查
export const DEFAULT_DEPART = '13:30';
export const DEFAULT_RETURN = '16:00';
export const DEFAULT_RETURN_PLACE = '青埔';

export const TYPES = {
  indoor: { label: '室內', icon: '🏠', note: '下雨也能去' },
  outdoor: { label: '室外', icon: '🌳', note: '要天晴' },
  mixed: { label: '室內外都有', icon: '🏠🌳', note: '下雨可去室內的部分' },
};
export const typeLabel = (t) => `${(TYPES[t] || TYPES.mixed).icon} ${(TYPES[t] || TYPES.mixed).label}`;
/** 下雨也能去：室內，或室內外都有 */
export const rainSafe = (p) => p.type === 'indoor' || p.type === 'mixed' || !p.type;

/** 地點名稱比對用：去掉空白、標點、「台/臺」差異 */
export function placeKey(name) {
  return normName(name).replace(/[台臺]/g, '臺').replace(/[（）()「」『』、，,．.\-_]/g, '');
}

/** 把「115/9/29」「2026-09-29」「2026/9/29」轉成 2026-09-29；看不懂回傳 null */
export function parseDate(s) {
  const m = String(s || '').match(/(\d{2,4})\s*[\/.\-年]\s*(\d{1,2})\s*[\/.\-月]\s*(\d{1,2})/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 200) y += 1911;
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function parseDates(text) {
  return [...new Set(String(text || '').split(/[;；、\n]|(?<=\d)\s+(?=\d{2,4}[\/.\-年])/).map(parseDate).filter(Boolean))].sort();
}

export const lastVisit = (p) => (p.visits || []).slice().sort().at(-1) || null;

/** 距今幾週（日期相差天數 / 7，取整數） */
export function weeksAgo(iso, today = new Date()) {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Math.max(0, Math.floor((today - d) / (7 * 86400000)));
}

/** 一句話說明這個地點去過沒：「去過 2 次，最近一次 115/9/29（8 週前）」 */
export function visitSummary(p, today = new Date()) {
  const v = (p.visits || []).slice().sort();
  if (!v.length) return '還沒去過';
  const last = v.at(-1);
  const w = weeksAgo(last, today);
  return `去過 ${v.length} 次，最近一次 ${toROC(last)}（${w === 0 ? '這週' : `${w} 週前`}）`;
}

/** 找名稱相同的地點（忽略空白、標點、台臺） */
export function findPlace(places, name) {
  const k = placeKey(name);
  return k ? places.find(p => placeKey(p.name) === k) : null;
}

/** 這個學季第 1～10 週的踏查日期（每週二） */
export function tripDates(startISO, weeks = 10) {
  const d0 = new Date(`${startISO}T12:00:00`);
  d0.setDate(d0.getDate() - ((d0.getDay() + 6) % 7)); // 當週週一
  return Array.from({ length: weeks }, (_, i) => {
    const d = new Date(d0);
    d.setDate(d.getDate() + i * 7 + ((TRIP_WEEKDAY + 6) % 7));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

/**
 * 自動排 10 週。規則：
 * 1. 沒去過的優先，其次是最久沒去的（名稱順序當同分時的排序，結果每次都一樣）
 * 2. 晴天的地點：每週一個，10 週不重複
 * 3. 雨天的地點：一定是「下雨也能去」的室內（或室內外）地點。如果晴天的地點本身就是室內，雨天就去同一個；
 *    不然從其他室內地點挑，也盡量不重複
 * 4. 室外地點最多連續 2 週，避免一直曬太陽或淋雨
 * 回傳 { weeks:[{week,date,sunnyId,rainyId}], warnings:[…] }
 */
export function planTen(places, startISO, { fixed = {} } = {}) {
  const warnings = [];
  const dates = tripDates(startISO);
  const staleness = (p) => lastVisit(p) || '0000-00-00';
  const byStale = [...places].sort((a, b) => staleness(a).localeCompare(staleness(b)) || a.name.localeCompare(b.name, 'zh-Hant'));
  const usedSunny = new Set(), usedRainy = new Set();
  // 第一輪：先排好 10 週的晴天地點
  const sunnyOf = [];
  let outdoorRun = 0;
  for (let i = 0; i < 10; i++) {
    const keep = fixed[i];
    let sunny = keep ? places.find(p => p.id === keep.sunnyId) : null;
    if (!sunny) {
      let pool = byStale.filter(p => !usedSunny.has(p.id));
      if (outdoorRun >= 2) { const indoor = pool.filter(rainSafe); if (indoor.length) pool = indoor; }
      sunny = pool[0] || null;
    }
    if (sunny) usedSunny.add(sunny.id);
    outdoorRun = sunny && !rainSafe(sunny) ? outdoorRun + 1 : 0;
    sunnyOf.push(sunny);
  }
  // 第二輪：雨天備案。室內的晴天地點就去同一個；室外的，挑「不在這 10 週主要地點裡」的室內地點
  const weeks = sunnyOf.map((sunny, i) => {
    const keep = fixed[i];
    let rainy = keep ? places.find(p => p.id === keep.rainyId) : null;
    if (!rainy && sunny) {
      if (rainSafe(sunny)) rainy = sunny;
      else {
        const safe = byStale.filter(p => rainSafe(p) && p.id !== sunny.id);
        rainy = safe.find(p => !usedSunny.has(p.id) && !usedRainy.has(p.id))
          || safe.find(p => !usedSunny.has(p.id))
          || safe.find(p => !usedRainy.has(p.id))
          || safe[0] || null;
      }
    }
    if (rainy) usedRainy.add(rainy.id);
    return { week: i + 1, date: dates[i], sunnyId: sunny?.id || '', rainyId: rainy?.id || '' };
  });
  if (places.length < 10) warnings.push(`地點庫只有 ${places.length} 個地點，不夠排 10 週，有 ${10 - places.length} 週是空的，請先新增地點。`);
  if (!places.some(rainSafe)) warnings.push('地點庫裡沒有任何「下雨也能去」的室內地點，雨天會沒有地方可去。請至少新增一個室內地點。');
  else if (places.filter(rainSafe).length < 3) warnings.push('室內地點太少（少於 3 個），雨天備案會一直重複，建議多新增幾個室內地點。');
  return { weeks, warnings };
}
