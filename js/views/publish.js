// 📤 本週發送（照 LINE 實際順序：週會 → 踏查 → 照片）與 🗂️ 紀錄
import { el, toROC, todayISO, downloadFile, copyText, thisWeekSendTime, formatDateTime, weekdayName, findPII, preparePostPhoto, formatBytes } from '../utils.js';
import { currentTripPhotos } from './trip.js';
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
  // 要發到 IG／FB 的照片：只放在記憶體，按確認後才交給郵差（郵差暫存在雲端硬碟，發完就刪）
  const MAX_POST_PHOTOS = 10;
  const photos = [];
  let pollTimer = null;

  /** 🤖 確認後自動發送（交給郵差，時間到送到 LINE 官方帳號、FB 粉專、IG） */
  function autoSendCard({ blocks, fbBlock, igBlock }) {
    const statusBox = el('div');
    const msg = el('div');
    const lineCb = el('input', { type: 'checkbox', checked: blocks.length > 0, disabled: !blocks.length });
    const fbCb = el('input', { type: 'checkbox', checked: !!fbBlock, disabled: !fbBlock });
    const igCb = el('input', { type: 'checkbox', checked: !!igBlock, disabled: !igBlock });
    const fbPhotoCb = el('input', { type: 'checkbox', checked: true });
    // 這週的發送時間過了的話，預設排到下週同一時間；也可以選「現在馬上發送」
    const weekTime = thisWeekSendTime(new Date(), st0.sendWeekday ?? 2, st0.sendTime || '17:00');
    const passed = weekTime.getTime() <= Date.now();
    const sendAt = passed ? new Date(weekTime.getTime() + 7 * 86400000) : weekTime;
    const goBtn = el('button', { class: 'btn primary', disabled: true }, `✅ 確認，${formatDateTime(sendAt)} 自動發送`);
    const nowBtn = passed ? el('button', { class: 'btn', disabled: true }, '⚡ 確認，現在馬上發送') : null;
    let gateOpen = false;
    const refreshGo = () => {
      const off = !gateOpen || !postman.url || (!lineCb.checked && !fbCb.checked && !igCb.checked);
      goBtn.disabled = off; if (nowBtn) nowBtn.disabled = off;
    };
    [lineCb, fbCb, igCb].forEach(cb => cb.addEventListener('change', () => { refreshGo(); drawPhotos(); }));

    // ----- 照片 -----
    const photoInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    const pickBtn = el('button', { class: 'btn', onclick: () => photoInput.click() }, '📷 選擇照片');
    const fromTrip = currentTripPhotos();
    const tripBtn = el('button', { class: 'btn' }, `📥 用踏查頁選的照片（${fromTrip.length} 張）`);
    const photoGrid = el('div', { class: 'photos' });
    const photoInfo = el('div', { class: 'muted' });
    const photoBox = el('div', { class: 'output-block' });
    async function addPhotos(srcs) {
      if (photos.length + srcs.length > MAX_POST_PHOTOS) ctx.toast(`IG 一篇最多 ${MAX_POST_PHOTOS} 張，多的會略過`);
      photoInfo.textContent = '照片處理中…';
      msg.replaceChildren(); // 選了照片，「IG 一定要有照片」的提醒就不用了
      for (const src of srcs.slice(0, MAX_POST_PHOTOS - photos.length)) {
        try { photos.push(await preparePostPhoto(src.dataUrl || src, { name: src.name })); }
        catch (e) { ctx.toast(e.message); }
      }
      drawPhotos();
    }
    photoInput.addEventListener('change', async () => { const files = [...photoInput.files]; photoInput.value = ''; await addPhotos(files); });
    tripBtn.addEventListener('click', () => addPhotos(currentTripPhotos()));
    function drawPhotos() {
      const want = igCb.checked || (fbCb.checked && fbPhotoCb.checked);
      photoGrid.replaceChildren(...photos.map((p, i) => el('div', { class: 'photo' },
        el('img', { src: p.dataUrl, alt: `照片 ${i + 1}` }),
        el('button', { class: 'x', title: '移除這張', 'aria-label': `移除照片 ${i + 1}`, onclick: () => { photos.splice(i, 1); drawPhotos(); } }, '✕'),
        el('div', { class: 'meta' }, `${i === 0 ? '⭐ 第 1 張' : `第 ${i + 1} 張`}${p.cropped ? '（已裁切）' : ''} `,
          i > 0 ? el('button', { class: 'btn small', title: '往前移', 'aria-label': `照片 ${i + 1} 往前移`, onclick: () => { photos.splice(i - 1, 0, photos.splice(i, 1)[0]); drawPhotos(); } }, '⬅') : null),
      )));
      const total = photos.reduce((n, p) => n + p.bytes, 0);
      photoInfo.textContent = photos.length
        ? `已選 ${photos.length} 張（最多 ${MAX_POST_PHOTOS} 張，共 ${formatBytes(total)}）。⭐ 第 1 張決定 IG 的裁切形狀，可以按 ⬅ 換順序。太長或太寬的照片已經從中間裁掉一點（IG 規定）。`
        : (igCb.checked ? '📸 IG 一定要有照片：請選 1～10 張。' : '還沒有選照片。');
      tripBtn.hidden = !fromTrip.length || photos.length > 0;
      photoBox.classList.toggle('muted-box', !want);
    }
    photoBox.append(
      el('h3', {}, '📷 照片（IG 一定要有；FB 也可以一起附上）'),
      el('div', { class: 'notice warn' }, '⚠️ 只選「每位學生都有肖像同意」的照片。按確認後，照片會暫時放在郵差的 Google 雲端硬碟，發完就刪掉；沒發成功的，3 天後也會自動刪掉。LINE 的照片還是請老師用手機自己傳。'),
      el('div', { class: 'btns', style: 'margin-top:0' }, pickBtn, tripBtn, photoInput),
      photoInfo, photoGrid);

    const showStatus = (st) => {
      clearTimeout(pollTimer);
      const j = st?.job;
      if (!j) { statusBox.replaceChildren(el('p', { class: 'muted' }, '郵差那裡目前沒有排好的發送。')); return; }
      const r = j.results || {};
      const parts = [];
      if (j.lineCount) parts.push(`LINE ${j.lineCount} 則`);
      if (j.hasFb) parts.push(`FB 1 篇${j.fbPhotos ? '（附照片）' : ''}`);
      if (j.hasIg) parts.push('IG 1 篇');
      if (j.photoCount) parts.push(`照片 ${j.photoCount} 張`);
      const cls = { sent: 'ok', scheduled: 'warn', sending: 'warn', partial: 'danger', failed: 'danger' }[j.status] || '';
      const btns = [];
      if (j.status === 'scheduled') btns.push(el('button', { class: 'btn small danger', onclick: (e) => act(e.target, 'cancel', '取消中…', s => s.job?.status === 'cancelled') }, '🚫 取消這次發送'));
      if (j.status === 'partial' || j.status === 'failed') {
        btns.push(el('button', { class: 'btn small', onclick: (e) => { const rid = `${Date.now()}`; act(e.target, 'retry', '重送中…', s => s.job?.retryId === rid, { retryId: rid }, { tries: 10, waitMs: 3000 }); } }, '🔁 重送失敗的部分'));
      }
      const line = (icon, name, x) => (x ? el('div', {}, `${icon} ${name}：${x.ok ? '✅' : '❌'} ${x.msg || ''}`,
        x.url ? el('a', { href: x.url, target: '_blank', rel: 'noopener' }, '　看貼文') : null) : null);
      statusBox.replaceChildren(el('div', { class: `notice ${cls}` },
        el('div', {}, el('strong', {}, STATUS_TEXT[j.status] || j.status), j.dryRun || st.dryRun ? '（測試模式：不會真的發出去）' : '', st.lineTest ? '（LINE 只發給測試的老師）' : ''),
        el('div', {}, `${j.label || ''}　發送時間：${formatDateTime(new Date(j.sendAt))}　內容：${parts.join('、')}`),
        line('📱', 'LINE', r.line), line('📘', 'FB', r.fb), line('📸', 'IG', r.ig),
        r.note ? el('div', {}, r.note) : null,
        j.photosNote ? el('div', {}, `📷 ${j.photosNote}`) : null,
        st.triggerOn === false ? el('div', {}, '⚠️ 郵差的鬧鐘還沒設定，時間到不會發。請到 Apps Script 執行一次「安裝」。') : null,
        btns.length ? el('div', { class: 'btns' }, ...btns) : null));
      // 發送中：每 4 秒自動再問一次，直到發完
      if (j.status === 'sending' && statusBox.isConnected) pollTimer = setTimeout(refresh, 4000);
    };
    async function act(btn, action, label, verify, extra, opts = {}) {
      const done = spinnerButton(btn, label);
      try { const st = await tellPostman(postman.url, postman.secret, action, extra, { verify, ...opts }); showStatus(st); msg.replaceChildren(); ctx.toast('郵差收到了'); }
      catch (e) { msg.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
      done();
    }
    async function refresh() {
      if (!postman.url) return;
      try { showStatus(await askPostman(postman.url, postman.secret)); }
      catch (e) { statusBox.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
    }
    async function schedule(btn, at) {
      const fail = (t) => { msg.replaceChildren(el('div', { class: 'notice danger' }, t)); };
      const line = lineCb.checked ? blocks.map(b => b.getText().trim()).filter(Boolean) : [];
      const fb = fbCb.checked && fbBlock ? fbBlock.getText().trim() : '';
      const ig = igCb.checked && igBlock ? igBlock.getText().trim() : '';
      if (!line.length && !fb && !ig) return fail('沒有要發送的內容。');
      if (igCb.checked && !photos.length) return fail('IG 一定要有照片：請在「📷 照片」選 1～10 張，或取消勾選「發到 IG」。');
      if (ig.length > 2200) return fail(`IG 文案最多 2200 字，現在有 ${ig.length} 字，請刪短一點。`);
      if ((ig.match(/#[^\s#]+/g) || []).length > 30) return fail('IG 的 hashtag（#）最多 30 個，請刪掉一些。');
      const hits = [...line, fb, ig].flatMap(t => findPII(t));
      if (hits.length && !confirm(`文案裡可能有個資：${hits.map(h => `「${h.text}」`).join('、')}。確定沒問題、還是要發送嗎？`)) return;
      if (!at && !confirm('確定要現在馬上發送嗎？郵差 5 分鐘內會送出，家長會馬上收到。')) return;
      try {
        const cur = await askPostman(postman.url, postman.secret);
        if (cur.job?.status === 'scheduled' && !confirm(`郵差那裡已經有一個排好的發送（${cur.job.label || ''}）。要換成這一次的嗎？`)) return;
      } catch (e) { return fail(e.message); }
      const withPhotos = fb && fbPhotoCb.checked && photos.length > 0;
      const sendPhotos = (ig || withPhotos) ? photos : [];
      const label = [meeting?.letter && lineCb.checked ? `${toROC(meeting.date)}週會` : '', trip ? `${toROC(trip.date)} ${trip.place}` : ''].filter(Boolean).join('＋');
      const id = `${Date.now()}`;
      const job = { id, label, sendAt: at || Date.now(), line, fb, ig, fbPhotos: withPhotos, photos: sendPhotos.map((p, i) => ({ name: `photo${i + 1}.jpg`, mime: p.mimeType, data: p.base64 })) };
      await act(btn, 'schedule', sendPhotos.length ? `把照片交給郵差中（${sendPhotos.length} 張）…` : '交給郵差中…', s => s.job?.id === id, { job },
        sendPhotos.length ? { tries: 8, waitMs: 2500 } : {});
      refreshGo();
    }
    goBtn.addEventListener('click', () => schedule(goBtn, sendAt.getTime()));
    if (nowBtn) nowBtn.addEventListener('click', () => schedule(nowBtn, 0));
    const card = el('div', { class: 'card' },
      el('h2', {}, '🤖 確認後自動發送'),
      postman.url
        ? el('p', { class: 'muted' }, `4 項檢查清單勾完後按下面的按鈕，郵差會在 ${formatDateTime(sendAt)} 自動發送。${passed ? `（這週的 ${formatDateTime(weekTime)} 已經過了，所以排到下週；要補發請按「現在馬上發送」。）` : ''}發送前隨時可以取消。`)
        : el('div', { class: 'notice warn' }, '還沒設定郵差，所以現在只能用上面的「一鍵複製」。設定方法：到「⚙️ 設定」→「📮 自動發送（郵差）」。'),
      el('label', { class: 'inline' }, lineCb, el('span', {}, `📱 發到 LINE 官方帳號（${blocks.length} 個泡泡，一次送出；照片請自己傳）`)),
      el('label', { class: 'inline' }, fbCb, el('span', {}, '📘 發到 FB 粉專')),
      el('label', { class: 'inline', style: 'margin-left:28px' }, fbPhotoCb, el('span', {}, 'FB 也附上下面選的照片')),
      el('label', { class: 'inline' }, igCb, el('span', {}, `📸 發到 IG${igBlock ? '（一定要有照片，最多 10 張）' : '（這次踏查沒有產生 IG 文案）'}`)),
      photoBox,
      el('div', { class: 'btns' }, goBtn, nowBtn, postman.url ? el('button', { class: 'btn', onclick: refresh }, '🔄 重新整理狀態') : null),
      msg, statusBox);
    fbPhotoCb.addEventListener('change', drawPhotos);
    drawPhotos();
    if (postman.url) { statusBox.replaceChildren(el('p', { class: 'muted' }, '正在問郵差…')); refresh(); }
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
    let igBlock = null;
    if (trip?.texts?.ig) { const b = outputBlock({ title: '📸 Instagram 貼文', text: trip.texts.ig, gated: true }); gated.push(b); social.push(b); igBlock = b; }
    const auto = autoSendCard({ blocks, fbBlock, igBlock });
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
