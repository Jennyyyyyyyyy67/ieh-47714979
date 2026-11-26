// 主程式：登入、分頁切換
import { createStore } from './store.js';
import { el, toLoginEmail } from './utils.js';
import { setModelUpgradeHandler, setRetryHandler } from './gemini.js';
import { renderTrip } from './views/trip.js';
import { renderMeeting } from './views/meeting.js';
import { renderPublish, renderHistory } from './views/publish.js';
import { renderSettings } from './views/settings.js';
import { renderSurvey, ROLES, resetSurvey } from './views/survey.js';
import { renderReport } from './views/report.js';
import { renderPlaces } from './views/places.js';

const app = document.getElementById('app');
const tabsEl = document.getElementById('tabs');
const whoEl = document.getElementById('who');
const banner = document.getElementById('modeBanner');
const toastEl = document.getElementById('toast');

const TABS = [
  { key: 'trip', label: '🚌 踏查', render: renderTrip, roles: ['main'] },
  { key: 'places', label: '📍 踏查地點', render: renderPlaces, roles: ['main'] },
  { key: 'meeting', label: '⛪ 週會', render: renderMeeting, roles: ['main'] },
  { key: 'publish', label: '📤 本週發送', render: renderPublish, roles: ['main'] },
  { key: 'survey', label: '📊 問卷檢查', helperLabel: '📝 答案批改', render: renderSurvey, roles: ['main', 'g12', 'g38'] },
  { key: 'report', label: '📋 本週名單', render: renderReport, roles: ['main', 'g12', 'g38'] },
  { key: 'history', label: '🗂️ 紀錄', render: renderHistory, roles: ['main'] },
  { key: 'settings', label: '⚙️ 設定', render: renderSettings, roles: ['main'] },
];
const myRole = () => ctx.role || 'main';
const ROLE_KEY = 'tripapp:task';
const myTabs = () => TABS.filter(t => t.roles.includes(myRole()));

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

const ctx = {
  store: null,
  settings: {},
  toast,
  current: 'trip',
  params: null,
  async go(key, params = null) {
    ctx.current = key; ctx.params = params;
    renderTabs();
    app.replaceChildren(el('p', { class: 'muted center' }, '載入中…'));
    const tab = myTabs().find(t => t.key === key) || myTabs()[0];
    ctx.current = tab.key;
    renderTabs();
    try {
      await tab.render(app, ctx);
    } catch (e) {
      console.error(e);
      app.replaceChildren(el('div', { class: 'notice danger' }, `出錯了：${e.message}`));
    }
    window.scrollTo(0, 0);
  },
  async reloadSettings() { ctx.settings = await ctx.store.getSettings(); },
};

function renderTabs() {
  tabsEl.replaceChildren(...myTabs().map(t => el('button', {
    class: t.key === ctx.current ? 'active' : '',
    onclick: () => ctx.go(t.key),
  }, myRole() !== 'main' && t.helperLabel ? t.helperLabel : t.label)));
}

function renderAuth() {
  tabsEl.hidden = true;
  whoEl.replaceChildren();
  const user = el('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'teacher' });
  const pw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: '密碼' });
  const msg = el('div');
  const busy = async (fn) => {
    msg.replaceChildren();
    if (!user.value.trim()) { msg.replaceChildren(el('div', { class: 'notice danger' }, '請輸入帳號')); return; }
    try { await fn(); }
    catch (e) { msg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
  };
  app.replaceChildren(el('div', { class: 'card auth' },
    el('h1', {}, '老師登入'),
    el('p', { class: 'muted' }, '全校老師共用同一組帳號密碼。登入後再選今天要做的工作。'),
    el('label', {}, '帳號'), user,
    el('label', {}, '密碼'), pw,
    msg,
    el('div', { class: 'btns' },
      el('button', { class: 'btn primary', onclick: () => busy(() => ctx.store.signIn(toLoginEmail(user.value), pw.value)) }, '登入'),
    ),
    el('details', {}, el('summary', {}, '第一次使用、或忘記密碼？'),
      el('p', { class: 'muted' }, '帳號只要建立一次，由負責的老師處理就好。其他老師直接登入，不用註冊。忘記密碼請找負責的老師。'),
      el('div', { class: 'btns' }, el('button', { class: 'btn small', onclick: () => busy(() => ctx.store.signUp(toLoginEmail(user.value), pw.value)) }, '建立這個帳號（只有第一次）')),
    ),
  ));
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') busy(() => ctx.store.signIn(toLoginEmail(user.value), pw.value)); });
}

// 超過保留天數的踏查、週會紀錄自動刪除（清容量）。
export const DEFAULT_RETENTION_DAYS = 7;
async function autoCleanup() {
  const days = ctx.settings.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!days || days <= 0) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const col of ['trips', 'meetings', 'reports']) {
    for (const item of await ctx.store.list(col)) {
      if ((item.createdAt || item.updatedAt || Date.now()) < cutoff) { await ctx.store.remove(col, item.id); n++; }
    }
  }
  if (n) setTimeout(() => toast(`🧹 已自動清除 ${n} 筆超過 ${days} 天的紀錄`), 400);
}

/** 登入後選「今天要做什麼工作」：只記在這個分頁，關掉或登出就要重選 */
function renderTaskPicker() {
  tabsEl.hidden = true;
  app.replaceChildren(el('div', { class: 'card auth' },
    el('h1', {}, '今天要做什麼工作？'),
    el('p', { class: 'muted' }, '選了之後只會顯示需要的功能。做完可以按右上角「🔄 切換工作」。'),
    ...Object.entries(ROLES).map(([key, r]) => el('button', {
      class: 'role-card',
      onclick: () => {
        ctx.role = key;
        try { sessionStorage.setItem(ROLE_KEY, key); } catch { /* 無痕模式也沒關係 */ }
        tabsEl.hidden = false;
        renderWho();
        ctx.go(key === 'main' ? (ctx.settings.geminiKey ? 'trip' : 'settings') : 'survey');
      },
    }, el('strong', {}, r.label), el('span', { class: 'muted' }, r.desc))),
  ));
}

function clearTask() {
  ctx.role = null;
  resetSurvey();
  try { sessionStorage.removeItem(ROLE_KEY); } catch { /* ignore */ }
}

function renderWho() {
  whoEl.replaceChildren(...[
    ctx.role ? el('span', {}, ROLES[ctx.role].label) : null,
    ctx.role ? el('button', { class: 'btn small', onclick: () => { clearTask(); renderWho(); renderTaskPicker(); } }, '🔄 切換工作') : null,
    el('button', { class: 'btn small', onclick: () => { clearTask(); ctx.store.signOut(); } }, '登出'),
  ].filter(Boolean));
}

async function main() {
  try {
    ctx.store = await createStore();
  } catch (e) {
    app.replaceChildren(el('div', { class: 'notice danger' }, `系統啟動失敗：${e.message}。請檢查網路，或檢查 firebase-config.js 的設定。`));
    return;
  }
  if (ctx.store.mode === 'local') {
    banner.hidden = false;
    banner.textContent = '🧪 本機試用模式：資料只存在這台裝置的瀏覽器裡，換手機或清除瀏覽紀錄就會不見。正式使用前請照 README 設定 Firebase。';
  }
  ctx.store.onAuth(async user => {
    if (!user) { renderAuth(); return; }
    try { ctx.role = sessionStorage.getItem(ROLE_KEY) || null; } catch { ctx.role = null; }
    if (ctx.role && !ROLES[ctx.role]) ctx.role = null;
    renderWho();
    tabsEl.hidden = false;
    await ctx.reloadSettings();
    setRetryHandler((n, total) => toast(`⏳ Gemini 現在比較忙，自動重試中…（第 ${n}/${total} 次）`));
    setModelUpgradeHandler(async (model) => {
      ctx.settings = { ...ctx.settings, model };
      await ctx.store.saveSettings(ctx.settings);
      toast(`🔄 Google 換了新模型，已自動改用 ${model}`);
    });
    await autoCleanup();
    if (!ctx.role) { renderTaskPicker(); return; }
    ctx.go(myRole() !== 'main' ? 'survey' : (ctx.settings.geminiKey ? 'trip' : 'settings'));
  });
}

main();
