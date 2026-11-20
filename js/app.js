// 主程式：登入、分頁切換
import { createStore } from './store.js';
import { el } from './utils.js';
import { renderTopics } from './views/topics.js';
import { renderTrip } from './views/trip.js';
import { renderMeeting } from './views/meeting.js';
import { renderPublish, renderHistory } from './views/publish.js';
import { renderSettings } from './views/settings.js';

const app = document.getElementById('app');
const tabsEl = document.getElementById('tabs');
const whoEl = document.getElementById('who');
const banner = document.getElementById('modeBanner');
const toastEl = document.getElementById('toast');

const TABS = [
  { key: 'trip', label: '🚌 踏查', render: renderTrip },
  { key: 'meeting', label: '⛪ 週會', render: renderMeeting },
  { key: 'publish', label: '📤 本週發送', render: renderPublish },
  { key: 'topics', label: '📚 學習主題庫', render: renderTopics },
  { key: 'history', label: '🗂️ 紀錄', render: renderHistory },
  { key: 'settings', label: '⚙️ 設定', render: renderSettings },
];

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
    const tab = TABS.find(t => t.key === key) || TABS[0];
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
  tabsEl.replaceChildren(...TABS.map(t => el('button', {
    class: t.key === ctx.current ? 'active' : '',
    onclick: () => ctx.go(t.key),
  }, t.label)));
}

function renderAuth() {
  tabsEl.hidden = true;
  whoEl.replaceChildren();
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
    whoEl.replaceChildren(
      el('span', {}, user.email),
      el('button', { class: 'btn small', onclick: () => ctx.store.signOut() }, '登出'),
    );
    tabsEl.hidden = false;
    await ctx.reloadSettings();
    ctx.go(ctx.settings.geminiKey ? 'trip' : 'settings');
  });
}

main();
