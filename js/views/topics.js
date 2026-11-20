// 📚 學習主題庫：新增、修改、刪除；一次貼上多行；匯入／匯出 CSV
import { el, parseTopicsText, topicsToCSV, downloadFile } from '../utils.js';

export const SUBJECT_SUGGESTIONS = ['戶外踏查', '品格／領袖', '社會', '自然', '國語', '數學', '藝術', '健康與體育', '綜合活動', '生活', '科技', '英語'];

export function topicLabel(t) {
  return [t.grade, t.subject].filter(Boolean).join(' ') + (t.grade || t.subject ? '｜' : '') + t.name;
}

export async function renderTopics(root, ctx) {
  const { store, toast } = ctx;
  let topics = await store.list('topics');
  let editing = null; // 正在編輯的主題 id
  let filter = '';

  const datalist = el('datalist', { id: 'subjectList' }, ...SUBJECT_SUGGESTIONS.map(s => el('option', { value: s })));

  // ----- 新增／修改表單 -----
  const f = {
    grade: el('input', { type: 'text', placeholder: '例如：3-4年級（可留空）' }),
    subject: el('input', { type: 'text', list: 'subjectList', placeholder: '例如：社會、自然、戶外踏查' }),
    name: el('input', { type: 'text', placeholder: '例如：社區的公共服務' }),
    concepts: el('textarea', { placeholder: '一行一個，例如：\n垃圾分類與資源回收\n公共設施的功能' }),
    goals: el('textarea', { placeholder: '一行一個，例如：\n能說出垃圾處理的流程' }),
  };
  const formTitle = el('h2', {}, '➕ 新增一個單元／主題');
  const saveBtn = el('button', { class: 'btn primary' }, '儲存');
  const cancelBtn = el('button', { class: 'btn', hidden: true }, '取消修改');
  const formMsg = el('div');
  const resetForm = () => {
    editing = null;
    Object.values(f).forEach(i => { i.value = ''; });
    formTitle.textContent = '➕ 新增一個單元／主題';
    cancelBtn.hidden = true;
  };
  saveBtn.addEventListener('click', async () => {
    const name = f.name.value.trim();
    if (!name) { formMsg.replaceChildren(el('div', { class: 'notice danger' }, '請填「單元／主題名稱」')); return; }
    const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);
    const old = topics.find(t => t.id === editing) || {};
    await store.save('topics', { ...old, grade: f.grade.value.trim(), subject: f.subject.value.trim(), name, concepts: lines(f.concepts.value), goals: lines(f.goals.value) });
    toast(editing ? '已修改' : '已新增');
    formMsg.replaceChildren();
    resetForm();
    await refresh();
  });
  cancelBtn.addEventListener('click', resetForm);

  // ----- 一次貼上多行 -----
  const bulk = el('textarea', { placeholder: '3-4年級,社會,社區的公共服務,公共設施的功能;垃圾處理流程,能說出焚化廠的功能\n3-4年級,自然,資源回收,垃圾分類與資源回收,能正確分類垃圾' });
  const bulkMsg = el('div');
  const importTopics = async (text, sourceLabel) => {
    const { topics: found, errors } = parseTopicsText(text);
    if (!found.length) {
      bulkMsg.replaceChildren(el('div', { class: 'notice danger' }, `${sourceLabel}裡沒有找到可以匯入的資料。`, ...errors.map(e => el('div', {}, e))));
      return;
    }
    await store.saveMany('topics', found);
    bulkMsg.replaceChildren(el('div', { class: 'notice ok' }, `已匯入 ${found.length} 個單元／主題。`, ...errors.map(e => el('div', {}, e))));
    await refresh();
  };
  const csvInput = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
  csvInput.addEventListener('change', async () => {
    const file = csvInput.files[0];
    if (!file) return;
    await importTopics(await file.text(), 'CSV 檔');
    csvInput.value = '';
  });

  // ----- 清單 -----
  const search = el('input', { type: 'text', placeholder: '🔍 搜尋單元、概念…' });
  search.addEventListener('input', () => { filter = search.value.trim(); drawList(); });
  const listBox = el('div');
  const countEl = el('span', { class: 'muted' });

  function drawList() {
    const shown = topics.filter(t => !filter || JSON.stringify([t.grade, t.subject, t.name, t.concepts, t.goals]).includes(filter));
    countEl.textContent = `共 ${topics.length} 個`;
    if (!topics.length) {
      listBox.replaceChildren(el('p', { class: 'muted' }, '還沒有任何單元。可以用上面的表單一個一個加，或一次貼上多行、匯入 CSV。'));
      return;
    }
    listBox.replaceChildren(...shown.map(t => el('div', { class: 'topic' },
      el('div', { class: 'topic-head' },
        el('div', {}, el('div', { class: 'title' }, topicLabel(t))),
        el('div', { class: 'btns', style: 'margin:0' },
          el('button', { class: 'btn small', onclick: () => {
            editing = t.id;
            f.grade.value = t.grade || ''; f.subject.value = t.subject || ''; f.name.value = t.name;
            f.concepts.value = (t.concepts || []).join('\n'); f.goals.value = (t.goals || []).join('\n');
            formTitle.textContent = `✏️ 修改：${t.name}`;
            cancelBtn.hidden = false;
            formTitle.scrollIntoView({ behavior: 'smooth' });
          } }, '修改'),
          el('button', { class: 'btn small danger', onclick: async () => {
            if (!confirm(`確定要刪除「${t.name}」嗎？刪掉就找不回來了。`)) return;
            await store.remove('topics', t.id);
            if (editing === t.id) resetForm();
            toast('已刪除');
            await refresh();
          } }, '刪除'),
        ),
      ),
      el('div', {}, el('span', { class: 'muted' }, '學習概念：'), ...(t.concepts?.length ? t.concepts.map(c => el('span', { class: 'tag' }, c)) : [el('span', { class: 'muted' }, '（無）')])),
      t.goals?.length ? el('div', { class: 'muted' }, '學習目標：' + t.goals.join('；')) : null,
    )));
  }
  async function refresh() { topics = await store.list('topics'); drawList(); }

  root.replaceChildren(
    datalist,
    el('h1', {}, '📚 學習主題庫'),
    el('p', { class: 'muted' }, '把踏查可以連結到的學習單元和概念放在這裡。學科可以自由填，例如「戶外踏查」「品格／領袖」「社會」。用不到的欄位留空也沒關係。'),
    el('div', { class: 'card' },
      formTitle,
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '年級'), f.grade),
        el('div', {}, el('label', {}, '學科／類別'), f.subject),
      ),
      el('label', {}, '單元／主題名稱 *'), f.name,
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, '學習概念（一行一個）'), f.concepts),
        el('div', {}, el('label', {}, '學習目標（一行一個）'), f.goals),
      ),
      formMsg,
      el('div', { class: 'btns' }, saveBtn, cancelBtn),
    ),
    el('div', { class: 'card' },
      el('h2', {}, '📋 一次貼上多行 ／ 匯入 CSV'),
      el('p', { class: 'muted' }, '每一行一個單元，用逗號分隔：年級,學科,單元名稱,概念1;概念2,目標1;目標2。也可以直接從 Excel 或 Google 試算表複製貼上。'),
      el('details', {}, el('summary', {}, '看範例'), el('pre', { class: 'example' },
        '年級,學科,單元名稱,學習概念,學習目標\n3-4年級,社會,社區的公共服務,公共設施的功能;垃圾處理流程,能說出焚化廠的功能\n3-4年級,自然,資源回收,垃圾分類與資源回收,能正確分類垃圾\n全年級,戶外踏查,認識城市地標,圖書分類;公共空間禮儀,能用分類號找到書')),
      bulk,
      bulkMsg,
      el('div', { class: 'btns' },
        el('button', { class: 'btn primary', onclick: async () => { await importTopics(bulk.value, '貼上的文字'); bulk.value = ''; } }, '加入這些單元'),
        el('button', { class: 'btn', onclick: () => csvInput.click() }, '📂 匯入 CSV 檔'),
        el('button', { class: 'btn', onclick: () => downloadFile('學習主題庫.csv', topicsToCSV(topics)) }, '⬇️ 匯出 CSV'),
        csvInput,
      ),
    ),
    el('div', { class: 'card' },
      el('div', { class: 'output-head' }, el('h2', {}, '目前的單元／主題'), countEl),
      search,
      listBox,
    ),
  );
  drawList();
}
