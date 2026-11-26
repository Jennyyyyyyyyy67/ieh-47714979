// 📤 本週發送（照 LINE 實際順序：週會 → 踏查 → 照片）與 🗂️ 紀錄
import { el, toROC, todayISO, downloadFile, copyText, thisWeekSendTime, formatDateTime, weekdayName, findPII } from '../utils.js';
import { publishChecklist, outputBlock, LINKS, spinnerButton } from './common.js';
import { askPostman, tellPostman, STATUS_TEXT } from '../postman.js';

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

  const st0 = ctx.settings || {};
  const postman = { url: (st0.postmanUrl || '').trim(), secret: st0.postmanSecret || '' };
  /** 🤖 確認後自動發送（交給郵差，時間到送到 LINE 官方帳號和 FB 粉專） */
  function autoSendCard({ blocks, fbBlock }) {
    const statusBox = el('div');
    const msg = el('div');
    const lineCb = el('input', { type: 'checkbox', checked: blocks.length > 0, disabled: !blocks.length });
    const fbCb = el('input', { type: 'checkbox', checked: !!fbBlock, disabled: !fbBlock });
    // 這週的發送時間過了的話，預設排到下週同一時間；也可以選「現在馬上發送」
    const weekTime = thisWeekSendTime(new Date(), st0.sendWeekday ?? 2, st0.sendTime || '17:00');
    const passed = weekTime.getTime() <= Date.now();
    const sendAt = passed ? new Date(weekTime.getTime() + 7 * 86400000) : weekTime;
    const goBtn = el('button', { class: 'btn primary', disabled: true }, `✅ 確認，${formatDateTime(sendAt)} 自動發送`);
    const nowBtn = passed ? el('button', { class: 'btn', disabled: true }, '⚡ 確認，現在馬上發送') : null;
    let gateOpen = false;
    const refreshGo = () => { const off = !gateOpen || !postman.url || (!lineCb.checked && !fbCb.checked); goBtn.disabled = off; if (nowBtn) nowBtn.disabled = off; };
    lineCb.addEventListener('change', refreshGo); fbCb.addEventListener('change', refreshGo);
    const showStatus = (st) => {
      const j = st?.job;
      if (!j) { statusBox.replaceChildren(el('p', { class: 'muted' }, '郵差那裡目前沒有排好的發送。')); return; }
      const r = j.results || {};
      const parts = [];
      if (j.lineCount) parts.push(`LINE ${j.lineCount} 則`);
      if (j.hasFb) parts.push('FB 1 篇');
      const cls = { sent: 'ok', scheduled: 'warn', partial: 'danger', failed: 'danger' }[j.status] || '';
      const btns = [];
      if (j.status === 'scheduled') btns.push(el('button', { class: 'btn small danger', onclick: (e) => act(e.target, 'cancel', '取消中…', s => s.job?.status === 'cancelled') }, '🚫 取消這次發送'));
      if (j.status === 'partial' || j.status === 'failed') btns.push(el('button', { class: 'btn small', onclick: (e) => act(e.target, 'retry', '重試中…', s => s.job && s.job.status !== 'sending' && s.job.sentAt !== j.sentAt) }, '🔁 重送失敗的部分'));
      statusBox.replaceChildren(el('div', { class: `notice ${cls}` },
        el('div', {}, el('strong', {}, STATUS_TEXT[j.status] || j.status), j.dryRun || st.dryRun ? '（測試模式：不會真的發出去）' : '', st.lineTest ? '（LINE 只發給測試的老師）' : ''),
        el('div', {}, `${j.label || ''}　發送時間：${formatDateTime(new Date(j.sendAt))}　內容：${parts.join('、')}`),
        r.line ? el('div', {}, `📱 LINE：${r.line.ok ? '✅' : '❌'} ${r.line.msg || ''}`) : null,
        r.fb ? el('div', {}, `📘 FB：${r.fb.ok ? '✅' : '❌'} ${r.fb.msg || ''}`) : null,
        r.note ? el('div', {}, r.note) : null,
        st.triggerOn === false ? el('div', {}, '⚠️ 郵差的鬧鐘還沒設定，時間到不會發。請到 Apps Script 執行一次「安裝」。') : null,
        btns.length ? el('div', { class: 'btns' }, ...btns) : null));
    };
    async function act(btn, action, label, verify, extra) {
      const done = spinnerButton(btn, label);
      try { const st = await tellPostman(postman.url, postman.secret, action, extra, { verify }); showStatus(st); msg.replaceChildren(); ctx.toast('郵差收到了'); }
      catch (e) { msg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
      done();
    }
    async function refresh() {
      if (!postman.url) return;
      statusBox.replaceChildren(el('p', { class: 'muted' }, '正在問郵差…'));
      try { showStatus(await askPostman(postman.url, postman.secret)); }
      catch (e) { statusBox.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
    }
    async function schedule(btn, at) {
      const line = lineCb.checked ? blocks.map(b => b.getText().trim()).filter(Boolean) : [];
      const fb = fbCb.checked && fbBlock ? fbBlock.getText().trim() : '';
      if (!line.length && !fb) { msg.replaceChildren(el('div', { class: 'notice danger' }, '沒有要發送的內容。')); return; }
      const hits = [...line, fb].flatMap(t => findPII(t));
      if (hits.length && !confirm(`文案裡可能有個資：${hits.map(h => `「${h.text}」`).join('、')}。確定沒問題、還是要發送嗎？`)) return;
      if (!at && !confirm('確定要現在馬上發送嗎？郵差 5 分鐘內會送出，家長會馬上收到。')) return;
      try {
        const cur = await askPostman(postman.url, postman.secret);
        if (cur.job?.status === 'scheduled' && !confirm(`郵差那裡已經有一個排好的發送（${cur.job.label || ''}）。要換成這一次的嗎？`)) return;
      } catch (e) { msg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); return; }
      const label = [meeting?.letter && lineCb.checked ? `${toROC(meeting.date)}週會` : '', trip ? `${toROC(trip.date)} ${trip.place}` : ''].filter(Boolean).join('＋');
      const id = `${Date.now()}`;
      await act(btn, 'schedule', '交給郵差中…', s => s.job?.id === id, { job: { id, label, sendAt: at || Date.now(), line, fb } });
      refreshGo();
    }
    goBtn.addEventListener('click', () => schedule(goBtn, sendAt.getTime()));
    if (nowBtn) nowBtn.addEventListener('click', () => schedule(nowBtn, 0));
    const card = el('div', { class: 'card' },
      el('h2', {}, '🤖 確認後自動發送'),
      postman.url
        ? el('p', { class: 'muted' }, `4 項檢查清單勾完後按下面的按鈕，郵差會在 ${formatDateTime(sendAt)} 自動發送。${passed ? `（這週的 ${formatDateTime(weekTime)} 已經過了，所以排到下週；要補發請按「現在馬上發送」。）` : ''}發送前隨時可以取消。照片和 IG 還是要老師用手機自己發。`)
        : el('div', { class: 'notice warn' }, '還沒設定郵差，所以現在只能用上面的「一鍵複製」。設定方法：到「⚙️ 設定」→「📮 自動發送（郵差）」。'),
      el('label', { class: 'inline' }, lineCb, el('span', {}, `📱 發到 LINE 官方帳號（${blocks.length} 個泡泡，一次送出）`)),
      el('label', { class: 'inline' }, fbCb, el('span', {}, '📘 發到 FB 粉專（只有文字，照片請自己補）')),
      el('div', { class: 'btns' }, goBtn, nowBtn, postman.url ? el('button', { class: 'btn', onclick: refresh }, '🔄 重新整理狀態') : null),
      msg, statusBox);
    refresh();
    return { card, setGate(open) { gateOpen = open; refreshGo(); } };
  }

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
    let fbBlock = null;
    if (trip?.texts?.fb) { const b = outputBlock({ title: '📘 Facebook 貼文', text: trip.texts.fb, gated: true }); gated.push(b); social.push(b); fbBlock = b; }
    if (trip?.texts?.ig) { const b = outputBlock({ title: '📸 Instagram 貼文', text: trip.texts.ig, gated: true }); gated.push(b); social.push(b); }
    const auto = autoSendCard({ blocks, fbBlock });
    const checklist = publishChecklist(open => { gated.forEach(b => b.setGate(open)); copyAll.disabled = !open; auto.setGate(open); });

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
      ),
      auto.card,
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
