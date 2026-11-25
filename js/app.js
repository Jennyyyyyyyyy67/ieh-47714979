// 主程式：登入、分頁切換
import { createStore } from './store.js';
import { el, readInvite } from './utils.js';
import { setModelUpgradeHandler } from './gemini.js';
import { renderTrip } from './views/trip.js';
import { renderMeeting } from './views/meeting.js';
import { renderPublish, renderHistory } from './views/publish.js';
import { renderSettings } from './views/settings.js';
import { renderSurvey, ROLES } from './views/survey.js';

const app = document.getElementById('app');
const tabsEl = document.getElementById('tabs');
const whoEl = document.getElementById('who');
const banner = document.getElementById('modeBanner');
const toastEl = document.getElementById('toast');

const TABS = [
  { key: 'trip', label: '🚌 踏查', render: renderTrip, roles: ['main'] },
  { key: 'meeting', label: '⛪ 週會', render: renderMeeting, roles: ['main'] },
  { key: 'publish', label: '📤 本週發送', render: renderPublish, roles: ['main'] },
  { key: 'survey', label: '📊 問卷檢查', helperLabel: '📝 答案批改', render: renderSurvey, roles: ['main', 'g12', 'g38'] },
  { key: 'history', label: '🗂️ 紀錄', render: renderHistory, roles: ['main'] },
  { key: 'settings', label: '⚙️ 設定', render: renderSettings, roles: ['main', 'g12', 'g38'] },
];
const myRole = () => ctx.settings?.role || 'main';
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
  const invited = ctx.pendingInvite || (() => { try { return sessionStorage.getItem('tripapp:invite'); } catch { return null; } })();
  const email = el('input', { type: 'email', autocomplete: 'username', placeholder: 'teacher@example.com' });
  const pw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: '至少 6 個字' });
  const msg = el('div');
  const busy = async (fn) => {
    msg.replaceChildren();
    try { await fn(); }
    catch (e) { msg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
  };
  app.replaceChildren(el('div', { class: 'card auth' },
    el('h1', {}, '老師登入'),
    el('p', { class: 'muted' }, '每位老師的資料分開存放，只有自己看得到。'),
    invited ? el('div', { class: 'notice ok' }, '📩 你是被邀請來的！第一次來請輸入 Email 和密碼，按「第一次使用：註冊」。AI 鑰匙和身分會自動設定好。') : null,
    el('label', {}, 'Email'), email,
    el('label', {}, '密碼'), pw,
    msg,
    el('div', { class: 'btns' },
      el('button', { class: 'btn primary', onclick: () => busy(() => ctx.store.signIn(email.value, pw.value)) }, '登入'),
      el('button', { class: 'btn', onclick: () => busy(() => ctx.store.signUp(email.value, pw.value)) }, '第一次使用：註冊'),
    ),
    el('div', { class: 'btns' },
      el('button', { class: 'btn small', onclick: () => busy(async () => {
        await ctx.store.resetPassword(email.value);
        msg.replaceChildren(el('div', { class: 'notice ok' }, '已寄出重設密碼信，請到信箱收信。'));
      }) }, '忘記密碼'),
    ),
  ));
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') busy(() => ctx.store.signIn(email.value, pw.value)); });
}

// 超過保留天數的踏查、週會紀錄自動刪除（清容量）。
export const DEFAULT_RETENTION_DAYS = 7;
async function autoCleanup() {
  const days = ctx.settings.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!days || days <= 0) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const col of ['trips', 'meetings']) {
    for (const item of await ctx.store.list(col)) {
      if ((item.createdAt || item.updatedAt || Date.now()) < cutoff) { await ctx.store.remove(col, item.id); n++; }
    }
  }
  if (n) setTimeout(() => toast(`🧹 已自動清除 ${n} 筆超過 ${days} 天的紀錄`), 400);
}

/** 第一次登入：選擇身分（之後可以在設定改） */
export function renderRolePicker(onDone) {
  tabsEl.hidden = true;
  app.replaceChildren(el('div', { class: 'card auth' },
    el('h1', {}, '你是哪一位老師？'),
    el('p', { class: 'muted' }, '選了之後，系統只會顯示你需要的功能。之後可以在「⚙️ 設定」改。'),
    ...Object.entries(ROLES).map(([key, r]) => el('button', {
      class: 'role-card',
      onclick: async () => {
        ctx.settings = { ...ctx.settings, role: key };
        await ctx.store.saveSettings(ctx.settings);
        tabsEl.hidden = false;
        onDone();
      },
    }, el('strong', {}, r.label), el('span', { class: 'muted' }, r.desc))),
  ));
}
ctx.pickRole = () => renderRolePicker(() => ctx.go(ctx.settings.geminiKey ? (myRole() === 'main' ? 'trip' : 'survey') : 'settings'));

// 邀請連結：先記下來並從網址上拿掉（避免被截圖或分享出去），登入後再套用
function captureInvite() {
  const inv = readInvite(location.hash);
  if (!inv) return;
  try { sessionStorage.setItem('tripapp:invite', JSON.stringify(inv)); } catch { /* 無痕模式也沒關係 */ }
  ctx.pendingInvite = inv;
  history.replaceState(null, '', location.pathname + location.search);
}
async function applyInvite() {
  let inv = ctx.pendingInvite;
  if (!inv) { try { inv = JSON.parse(sessionStorage.getItem('tripapp:invite') || 'null'); } catch { inv = null; } }
  if (!inv) return false;
  ctx.settings = { ...ctx.settings, geminiKey: inv.key, model: inv.model || ctx.settings.model, role: inv.role || ctx.settings.role, sharedKey: true };
  await ctx.store.saveSettings(ctx.settings);
  ctx.pendingInvite = null;
  try { sessionStorage.removeItem('tripapp:invite'); } catch { /* ignore */ }
  setTimeout(() => toast('🎉 已經幫你設定好 AI 鑰匙和身分，可以直接開始了'), 300);
  return true;
}

async function main() {
  captureInvite();
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
    whoEl.replaceChildren(
      el('span', {}, user.email),
      el('button', { class: 'btn small', onclick: () => ctx.store.signOut() }, '登出'),
    );
    tabsEl.hidden = false;
    await ctx.reloadSettings();
    await applyInvite();
    setModelUpgradeHandler(async (model) => {
      ctx.settings = { ...ctx.settings, model };
      await ctx.store.saveSettings(ctx.settings);
      toast(`🔄 Google 換了新模型，已自動改用 ${model}`);
    });
    await autoCleanup();
    if (!ctx.settings.role) { ctx.pickRole(); return; }
    ctx.go(ctx.settings.geminiKey ? (myRole() === 'main' ? 'trip' : 'survey') : 'settings');
  });
}

main();
