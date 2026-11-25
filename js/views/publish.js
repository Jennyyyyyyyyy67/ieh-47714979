// 📤 本週發送（照 LINE 實際順序：週會 → 踏查 → 照片）與 🗂️ 紀錄
import { el, toROC, todayISO, downloadFile, copyText, thisWeekSendTime, formatDateTime, weekdayName } from '../utils.js';
import { publishChecklist, outputBlock, LINKS } from './common.js';

export async function renderPublish(root, ctx) {
  const { store } = ctx;
  const [trips, meetings] = await Promise.all([store.list('trips'), store.list('meetings')]);
  const params = ctx.params || {};
  ctx.params = null;
  let trip = trips.find(t => t.id === params.tripId) || trips[0] || null;
  let meeting = meetings.find(m => m.id === params.meetingId) || meetings[0] || null;

  const tripSel = el('select', {}, el('option', { value: '' }, '（這週不發踏查）'),
    ...trips.map(t => el('option', { value: t.id, selected: trip && t.id === trip.id }, `${toROC(t.date)} ${t.place}`)));
  const meetSel = el('select', {}, el('option', { value: '' }, '（這週不發週會）'),
    ...meetings.map(m => el('option', { value: m.id, selected: meeting && m.id === meeting.id }, `${toROC(m.date)} ${m.weekInfo || ''}週會`)));
  const body = el('div');
  tripSel.addEventListener('change', () => { trip = trips.find(t => t.id === tripSel.value) || null; draw(); });
  meetSel.addEventListener('change', () => { meeting = meetings.find(m => m.id === meetSel.value) || null; draw(); });

  function draw() {
    const gated = [];
    const lineBubbles = [];
    if (meeting?.letter) lineBubbles.push({ title: '① 週會家長信', text: meeting.letter });
    if (trip?.texts?.line) lineBubbles.push({ title: `${lineBubbles.length ? '②' : '①'} 踏查回顧＋問卷`, text: trip.texts.line });

    const blocks = lineBubbles.map(b => {
      const blk = outputBlock({ title: b.title, text: b.text, gated: true });
      gated.push(blk);
      return blk;
    });
    const copyAll = el('button', { class: 'btn primary', disabled: true }, '📋 依順序全部複製');
    copyAll.addEventListener('click', async () => {
      const ok = await copyText(blocks.map(b => b.getText()).join('\n\n'));
      ctx.toast(ok ? '已複製（LINE 會變成一個泡泡；想分開發請一則一則複製）' : '複製失敗');
    });
    const social = [];
    if (trip?.texts?.fb) { const b = outputBlock({ title: '📘 Facebook 貼文', text: trip.texts.fb, gated: true }); gated.push(b); social.push(b); }
    if (trip?.texts?.ig) { const b = outputBlock({ title: '📸 Instagram 貼文', text: trip.texts.ig, gated: true }); gated.push(b); social.push(b); }
    const checklist = publishChecklist(open => { gated.forEach(b => b.setGate(open)); copyAll.disabled = !open; });

    body.replaceChildren(...[
      el('div', { class: 'card' },
        el('h2', {}, '📱 LINE 官方帳號（照順序發）'),
        lineBubbles.length ? null : el('p', { class: 'muted' }, '這週還沒有可以發的內容。先到「週會」或「踏查」產生文案。'),
        ...blocks,
        lineBubbles.length ? el('div', { class: 'output-block' },
          el('h3', {}, `${lineBubbles.length === 2 ? '③' : '②'} 照片`),
          el('p', { class: 'muted' }, '系統不保存照片，所以照片請用手機在 LINE 官方帳號 App 裡自己傳。傳之前再確認一次：照片裡的每位學生都有肖像同意。')) : null,
        lineBubbles.length > 1 ? el('div', { class: 'btns' }, copyAll) : null,
      ),
      social.length ? el('div', { class: 'card' }, el('h2', {}, '📘📸 Facebook／Instagram'), ...social) : null,
      el('div', { class: 'card' },
        checklist,
        el('div', { class: 'btns' },
          el('a', { class: 'btn', href: LINKS.lineManager, target: '_blank', rel: 'noopener' }, '🟢 打開 LINE 官方帳號後台'),
          el('a', { class: 'btn', href: LINKS.businessSuite, target: '_blank', rel: 'noopener' }, '🔵 打開 Business Suite'),
        ),
        el('p', { class: 'muted' }, '🔜 第 2 階段：確認後自動發送到 LINE 官方帳號和 FB 粉專（需要先申請帳號設定，到時候會一步一步教你）。'),
      ),
    ].filter(Boolean));
  }

  const st = ctx.settings || {};
  const sendAt = thisWeekSendTime(new Date(), st.sendWeekday ?? 2, st.sendTime || '17:00');
  const now = new Date();
  const mins = Math.round((sendAt - now) / 60000);
  const sched = mins > 0
    ? el('div', { class: 'notice warn schedule' }, '⏰ 本週發送時間：', el('strong', {}, formatDateTime(sendAt)),
        `　還有 ${mins >= 60 * 24 ? `${Math.floor(mins / 1440)} 天 ` : ''}${Math.floor((mins % 1440) / 60)} 小時 ${mins % 60} 分。可以先準備好，時間到再發。`)
    : el('div', { class: 'notice ok schedule' }, '⏰ 本週發送時間：', el('strong', {}, formatDateTime(sendAt)), '　已經到了，老師確認後就可以發送。');

  root.replaceChildren(...[
    el('h1', {}, '📤 本週發送'),
    sched,
    el('p', { class: 'muted' }, `照你們 LINE 實際的順序：週會 → 踏查 → 照片。每週${weekdayName(st.sendWeekday ?? 2)} ${st.sendTime || '17:00'} 發送，發送前老師一定要確認過。`),
    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '週會'), meetSel),
        el('div', {}, el('label', {}, '踏查'), tripSel),
      ),
    ),
    body,
  ].filter(Boolean));
  draw();
}

export async function renderHistory(root, ctx) {
  const { store, toast } = ctx;
  const days = ctx.settings?.retentionDays ?? 7;
  const expireText = (item) => {
    if (!days || !item.createdAt) return '';
    const d = new Date(item.createdAt + days * 86400000);
    return `　（${d.getMonth() + 1}/${d.getDate()} 自動刪除）`;
  };
  const [trips, meetings] = await Promise.all([store.list('trips'), store.list('meetings')]);
  const del = async (col, item, label) => {
    if (!confirm(`確定要刪除「${label}」嗎？刪掉就找不回來了。`)) return;
    await store.remove(col, item.id);
    toast('已刪除');
    renderHistory(root, ctx);
  };
  root.replaceChildren(
    el('h1', {}, '🗂️ 紀錄'),
    el('p', { class: 'muted' }, '這裡只存文字（行程表、核對過的照片描述、文案）。照片從來不會被儲存。'),
    el('div', { class: 'notice warn' }, (ctx.settings?.retentionDays ?? 7) > 0
      ? `🧹 紀錄會在建立 ${ctx.settings?.retentionDays ?? 7} 天後自動刪除（清容量）。教學紀錄要保存的話，請先按「下載備份」。`
      : '自動刪除已關閉（可以在設定打開）。'),
    el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: () => {
      const lines = [];
      for (const t of trips) { lines.push(`==== 踏查 ${toROC(t.date)} ${t.place} ====`); for (const [k, v] of Object.entries(t.texts || {})) lines.push(`--- ${k} ---`, v, ''); }
      for (const m of meetings) lines.push(`==== 週會 ${toROC(m.date)} ====`, m.letter || '', '');
      downloadFile(`踏查週會備份_${toROC(todayISO()).replace(/\//g, '')}.txt`, lines.join('\n'), 'text/plain');
    } }, '⬇️ 下載備份（文字檔）')),
    el('div', { class: 'card' },
      el('h2', {}, `🚌 踏查（${trips.length}）`),
      trips.length ? null : el('p', { class: 'muted' }, '還沒有紀錄'),
      ...trips.map(t => el('div', { class: 'list-item' },
        el('span', {}, `${toROC(t.date)}　${t.place}${t.title ? `｜${t.title}` : ''}`, el('span', { class: 'muted' }, expireText(t))),
        el('div', { class: 'btns', style: 'margin:0' },
          el('button', { class: 'btn small', onclick: () => ctx.go('trip', { trip: t }) }, '打開'),
          el('button', { class: 'btn small danger', onclick: () => del('trips', t, `${toROC(t.date)} ${t.place}`) }, '刪除'),
        ),
      )),
    ),
    el('div', { class: 'card' },
      el('h2', {}, `⛪ 週會（${meetings.length}）`),
      meetings.length ? null : el('p', { class: 'muted' }, '還沒有紀錄'),
      ...meetings.map(m => el('div', { class: 'list-item' },
        el('span', {}, `${toROC(m.date)}　${m.weekInfo || ''}週會`, el('span', { class: 'muted' }, expireText(m))),
        el('div', { class: 'btns', style: 'margin:0' },
          el('button', { class: 'btn small', onclick: () => ctx.go('meeting', { meeting: m }) }, '打開'),
          el('button', { class: 'btn small danger', onclick: () => del('meetings', m, `${toROC(m.date)} 週會`) }, '刪除'),
        ),
      )),
    ),
  );
}
