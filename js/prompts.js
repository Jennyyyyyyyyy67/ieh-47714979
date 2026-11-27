// 給 Gemini 的指令（提示詞）。規則寫在這裡，老師不用每次重講。

const SAFETY_RULES = `
【一定要遵守的規則】
1. 不可以辨認或猜測照片中的人是誰，不可以描述長相特徵來指認某個人。
2. 不可以出現學生姓名、綽號、班級、座號、學號。提到學生一律用「孩子們」「學生們」「領袖們」「小組」。
3. 事實只能以「行程表／學習單」為準。照片只能用來補充畫面（例如動作、表情、環境），不可以從照片推論出行程表沒寫的活動。
4. 不確定的事情就不要寫，絕對不可以編造沒有發生的事、沒有出現的數字、沒有說過的話。
5. 一律使用台灣繁體中文用語。
`.trim();

export const TRIP_EXAMPLES = [
`【戶外踏查】
香氣與手作的美味旅程：走進台灣滷味博物館 🥚✨

爸爸媽媽，你曾想過餐桌上常見的滷味背後藏著多少學問嗎？今天我們帶孩子走進台灣滷味博物館，展開一場色香味俱全的探索！

在專業導覽帶領下，孩子們認識台灣在地滷味文化的演進；最期待的「黃金蛋DIY」，大家小心翼翼敲殼、浸泡特調滷汁，看著金黃可口的蛋在手中完成，滿滿成就感全寫在笑臉上。

這不只是美食體驗，更是深刻的飲食文化課，珍惜食物與熱愛探索的種子已在心裡悄悄發芽！😋🍳`,
`【戶外踏查】
城市裡的知識座標：走進高雄市總圖 🏙️📖

爸爸媽媽，你知道一座圖書館可以藏著多少看世界的方式嗎？今天我們帶孩子再次造訪高雄市立圖書館總館，展開一場不一樣的「建築與視野」探索！

孩子們走進主題書區，練習透過分類指標尋找解答、與同學交換閱讀書籍。從空間設計到知識檢索，孩子們用雙眼與雙腳重新認識這座文化地標，把主動提問與探索生活的樂趣帶回日常！✨`,
];

export const MEETING_EXAMPLES = [
`親愛的家長您好：

本週週會蓓禎老師延續人際課題，帶領孩子從「不要追求別人的喜歡，不要逃避別人的討厭」出發，修煉更強大的內在心智：

【成熟領袖的堂課：不當幼稚鬼，拿回生命主導權】
別把「不喜歡」當作不禮貌的藉口
世界充滿主觀偏好（如對食物或公眾人物的喜好），想法不同甚至產生討厭都很正常。但老師提醒，若任由情緒流露，用擺臉色、講八卦或排擠等方式明顯表達不喜歡，這種無法管理情緒的行為就叫「幼稚」。成熟的領袖即便面對不欣賞的人事物，仍會選擇尊重與禮貌，絕不用幼稚回應幼稚。

強大的心理建設：一定要「喜歡你自己」
每個人都有不完美，與其浪費時間糾結別人為什麼討厭你，不如學會看重自己。因為每天照鏡子、陪伴你最久的人就是你自己。領袖必須具備「被討厭的勇氣」，不被內心的自我懷疑給擊倒，堅定地活出天父所喜悅的溫柔與善良。

讓我們在生活中不盲從、不幼稚，主動成為身邊人的祝福！

【領袖挑戰：跨世代尊榮行動】
本週任務難度升級，除了持續尊榮家中長輩，更要外加一位20歲以下的同儕或同學手足。`,
`親愛的家長您好：

新學季首週週會，蓓禎老師以詩篇「不從惡人的計謀，不站罪人的道路，不坐褻慢人的座位」為核心，帶領領袖們學習在群體中設立界線、保守己心：

【成熟領袖的防線：不從、不站、不坐，遠離群體盲從】
察覺陷阱的漸進：從「跟從」到「習慣」
墮落往往始於微小的念頭。當心中浮現「反正沒人看到」的試探時若不立刻轉向，就會一步步停留在錯誤的群體中旁觀（站），最後甚至與是非同流合污、麻木不仁（坐）。老師提醒，成熟的領袖懂得在起初就果斷轉身、保持距離，絕不因害怕落單而隨波逐流。

拒絕「褻慢人」的驕傲：保持受教的心
「褻慢人」指的是說不得、將自己的標準凌駕於真理之上的驕傲態度。即便面對不喜歡的同學，領袖也絕不以「他本來就很討人厭」當作排擠或批評的藉口，而是選擇尊重與受教，不讓負面言語污染自己與環境。

讓我們在新學季學會保護耳朵與口舌，活出健康強壯的領袖生命。

【領袖挑戰：遠離是非行動】
本週當身邊出現八卦、抱怨或起鬨的氛圍時，練習果斷轉身離開，並用一句正向肯定為同學帶來鼓勵。`,
`親愛的家長您好：

本週週會蓓禎老師延續「使人和睦」的主題，引導孩子從生活與國際時事切入，審視自己話語的影響力：

【成熟領袖的說話智慧：拒絕散播恐懼，成為和平之子】
察覺話語的動機：是在製造焦慮，還是傳遞平安？
無論是國際政局的放話，還是生活中隨口說的「考試超難完蛋了」、「你這樣會沒人喜歡」，甚至帶有排擠意味的眼神與耳語，本質上都是在「散播恐懼」。老師提醒，若一句話既無法改變結果，又只會讓人陷入緊張與不安，成熟的領袖會選擇勒住舌頭，不讓話語成為製造焦慮的工具。

發揮正向影響力：用話語帶來實質建造
「使人和睦的人有福了」，真正的領袖深知自己深具影響力，因此不單是不製造恐慌，更能積極轉化氛圍。與其批判他人表現或放大內心的擔憂，不如給予清楚、具體且真誠的肯定，用帶著盼望的話語安定人心。

讓我們在生活中不製造驚慌，主動成為傳遞平安與祝福的和平之子！

【領袖挑戰：具體肯定行動】
本週練習改掉嚇唬人或酸言酸語的習慣，主動向一位同學或家人說出一句「具體、聽得懂且真誠」的肯定與祝福。`,
];

// ---------- 1. 看照片 ----------
export const PHOTO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    photos: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER', description: '照片編號，從 1 開始' },
          seen: { type: 'STRING', description: '客觀描述照片中看到的場景與動作（不指認任何人）' },
          highlights: { type: 'ARRAY', items: { type: 'STRING' }, description: '互動亮點，例如試穿裝備、DIY 實作、聽解說' },
          uncertain: { type: 'ARRAY', items: { type: 'STRING' }, description: '看不清楚或無法確定的地方' },
          privacy: { type: 'ARRAY', items: { type: 'STRING' }, description: '可能有個資的地方，例如名牌、制服上的字、可清楚辨識的正臉' },
        },
        required: ['index', 'seen', 'highlights', 'uncertain', 'privacy'],
      },
    },
  },
  required: ['photos'],
};

export function photoPrompt({ trip, docParts }) {
  const text = `你是協助國小老師整理校外踏查紀錄的助理。請逐張看照片，列出「看到了什麼」和「不確定的地方」，讓老師核對。

${SAFETY_RULES}

【補充規則】
- 「seen」只寫畫面裡看得到的東西（場景、物品、動作），一到兩句。
- 「highlights」寫互動亮點（例如：試穿消防衣、動手 DIY、舉手發問），沒有就給空陣列。
- 「uncertain」一定要誠實寫出不確定的地方（例如：看不出這是哪個展區、看不清手上拿的東西）。真的沒有就寫「無」。
- 「privacy」如果看得到名牌、制服上的姓名或學號、清楚的正臉，請提醒老師；沒有就給空陣列。
- 照片共有 ${trip.photoCount} 張，請依照片順序回答，index 從 1 開始，每張都要回答。

【活動基本資料】
日期：${trip.date}
地點：${trip.place}
活動名稱：${trip.title || '（未填）'}

【行程表／學習單文字】
${trip.scheduleText || '（老師沒有貼文字，請參考附件檔案；如果也沒有附件，就只描述照片）'}`;
  return [{ text }, ...docParts];
}

// ---------- 2. 產生文案 ----------
export const TRIP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    line_title: { type: 'STRING', description: '主題標題，格式「一句有畫面的主題：走進○○ 加2個emoji」，不要包含【戶外踏查】' },
    line_body: { type: 'STRING', description: '家長群組溫馨回顧內文，三段，段落之間空一行' },
    home_questions: { type: 'ARRAY', items: { type: 'STRING' }, description: '1～2 題回家可以問孩子的問題（也會放進問卷）' },
    fb_post: { type: 'STRING' },
    ig_caption: { type: 'STRING' },
    ig_hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
    teaching_process: { type: 'STRING', description: '教學紀錄的「活動過程」，條列，依行程表順序' },
    class_connection: { type: 'STRING', description: '一兩句話寫出這次的學習重點（依學習單／行程表）' },
    fact_check: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { claim: { type: 'STRING' }, source: { type: 'STRING', description: '「行程表」「學習單」或「照片N」' } },
        required: ['claim', 'source'],
      },
      description: '文案中提到的每一件事實和它的來源，讓老師核對',
    },
  },
  required: ['line_title', 'line_body', 'home_questions', 'fb_post', 'ig_caption', 'ig_hashtags', 'teaching_process', 'class_connection', 'fact_check'],
};

/** 把一次踏查要產生的文案，分成幾組「同時」請 AI 寫（每組只帶自己需要的說明，比較快）。 */
export function tripGroups(outputs) {
  const groups = [];
  const lineOrQ = outputs.line || outputs.survey || outputs.lineQuestions;
  if (lineOrQ) groups.push({ key: 'line', label: '家長群組／問卷題目', outputs: { line: outputs.line, survey: outputs.survey, lineQuestions: outputs.lineQuestions }, fields: [...(outputs.line ? ['line_title', 'line_body'] : []), 'home_questions'] });
  if (outputs.fb) groups.push({ key: 'fb', label: 'Facebook', outputs: { fb: true }, fields: ['fb_post'] });
  if (outputs.ig) groups.push({ key: 'ig', label: 'Instagram', outputs: { ig: true }, fields: ['ig_caption', 'ig_hashtags'] });
  if (outputs.record) groups.push({ key: 'record', label: '教學紀錄', outputs: { record: true }, fields: ['teaching_process', 'class_connection'] });
  return groups;
}

/** 這一組只要求 AI 回答自己的欄位（再加上事實來源清單） */
export function tripSchemaFor(fields) {
  const props = {};
  [...fields, 'fact_check'].forEach(f => { props[f] = TRIP_SCHEMA.properties[f]; });
  return { type: 'OBJECT', properties: props, required: [...fields, 'fact_check'] };
}

export function tripPrompt({ trip, photoNotes, outputs, docParts }) {
  const want = [];
  if (outputs.line) want.push('line_title、line_body（家長群組溫馨回顧）');
  if (outputs.survey || outputs.lineQuestions) want.push('home_questions（回家可以問孩子的問題，1～2 題）');
  if (outputs.fb) want.push('fb_post（Facebook 粉專貼文）');
  if (outputs.ig) want.push('ig_caption、ig_hashtags（Instagram 貼文和 hashtag）');
  if (outputs.record) want.push('teaching_process（教學紀錄的活動過程）、class_connection（一兩句話寫出這次的學習重點）');

  const guide = [];
  if (outputs.line) guide.push(`■ 家長群組溫馨回顧（line_title + line_body）：完全模仿下面範例的語氣和結構。
  - line_title：一句有畫面的主題＋「：走進○○」＋ 2 個 emoji，不要包含【戶外踏查】（系統會自動加在上一行）。
  - line_body 分三段，段落之間空一行：
    第一段：用一個問句和「爸爸媽媽」對話，接著說「今天我們帶孩子走進……，展開一場……的探索！」
    第二段：寫孩子們做了什麼（導覽學到什麼、最期待的體驗或 DIY），只能寫行程表／學習單裡有的事，可以用照片補充畫面（例如表情、動作）。
    第三段：一句收尾，把這次的學習帶回生活，結尾加 2 個 emoji。
  - 要自然帶出孩子們這次學到什麼（依學習單的內容），但不要像在上課。
  - 不要寫問卷連結和「12點前送出」提醒，系統會自動加上。
  範例 1：
${TRIP_EXAMPLES[0]}

  範例 2：
${TRIP_EXAMPLES[1]}`);
  if (outputs.survey || outputs.lineQuestions) guide.push('■ home_questions：1～2 題，每題都要和這次學習單的學習重點有關，用孩子聽得懂的話，開放式問題（不是是非題）。');
  if (outputs.fb) guide.push('■ fb_post：給學校粉專的宣傳貼文，3～5 段短段落，可用少量 emoji，最後一句邀請大家一起關注孩子的學習。要帶出孩子們學到了什麼。');
  if (outputs.ig) guide.push('■ ig_caption：2～4 行，有節奏感、比 FB 更短。ig_hashtags：8～12 個，不要加 # 號以外的符號，要有地點、活動類型、學習主題，例如「戶外踏查」「校外教學」。不要出現學校名稱以外的個人資訊。');
  if (outputs.record) guide.push('■ teaching_process：依行程表順序條列（每行以「・」開頭），寫實、不誇大。\n■ class_connection：一兩句話，寫這次的學習重點（依學習單／行程表）。');
  guide.push('■ fact_check：把你寫的內容中提到的每件事列出來，並寫來源（行程表／學習單／照片N）。如果某件事找不到來源，就不要寫進文案。');

  const text = `你是國小老師的文案助理，要把一次校外踏查整理成文字。

${SAFETY_RULES}

【這次要產生的欄位】
${want.join('\n')}
只回答上面列出的欄位，另外 fact_check 一定要填。

【寫法】
${guide.join('\n')}

【活動基本資料】
日期：${trip.date}
地點：${trip.place}
活動名稱：${trip.title || '（未填）'}
參加年級：${trip.grades || '（未填）'}

【行程表／學習單文字】
${trip.scheduleText || '（請參考附件檔案）'}

【老師核對過的照片描述（只能用來補充畫面）】
${photoNotes || '（沒有照片）'}`;
  return [{ text }, ...docParts];
}

// ---------- 3. 週會家長信 ----------
export const MEETING_SCHEMA = {
  type: 'OBJECT',
  properties: { letter: { type: 'STRING' } },
  required: ['letter'],
};

export function meetingPrompt({ transcript, weekInfo, speaker, challengeHint, maxChars = 300, shorterThan }) {
  const text = `你是協助老師整理「週會」內容給家長的助理。請把下面的週會逐字稿整理成一封給家長的信。

${SAFETY_RULES}

【格式（一定要照這個順序）】
親愛的家長您好：
（空一行）
一句開場：說明${weekInfo ? `「${weekInfo}」` : '本週'}週會，${speaker || '老師'}以什麼為核心，帶領領袖們學習什麼：
（空一行）
【大標題：用「成熟領袖的……」開頭的有力句子】
小標 1（獨立一行）
內容一段
（空一行）
小標 2（獨立一行）
內容一段
（空一行）
一句收尾鼓勵
（空一行）
【領袖挑戰：行動名稱】
本週具體任務一到兩句

【其他要求】
- 全文（不算空白和換行）一定要在 ${shorterThan ? Math.min(maxChars, shorterThan - 30) : maxChars} 字以內。
- 只能寫逐字稿裡真的講到的內容和經文，不可以加入逐字稿沒有的故事、經文或例子。
- 逐字稿是錄音轉的，可能有錯字和口語，請改成通順的書面語，但不要改變老師的意思。
- 如果逐字稿裡沒有提到領袖挑戰，「【領袖挑戰】」後面寫「（逐字稿未提到本週挑戰，請老師補上）」。${challengeHint ? `\n- 老師補充的本週挑戰：${challengeHint}` : ''}
- 學生的名字、班級一律不能出現；老師的名字可以出現。

【語氣範例 1】
${MEETING_EXAMPLES[0]}

【語氣範例 2】
${MEETING_EXAMPLES[1]}

【語氣範例 3】
${MEETING_EXAMPLES[2]}

【本週逐字稿】
${transcript}`;
  return [{ text }];
}

// ---------- 4. AI 批改問卷答案 ----------
export const GRADE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          verdict: { type: 'STRING', enum: ['對', '部分對', '錯', '無法判斷'] },
          reason: { type: 'STRING', description: '15 字以內，說明哪裡對或錯' },
        },
        required: ['id', 'verdict', 'reason'],
      },
    },
  },
  required: ['results'],
};

/** answers：[{id:'S1', answer:'…'}]，只有代號，沒有學生名字 */
export function gradePrompt({ question, reference, gradeBand, answers, kind }) {
  if (kind === 'self') return selfQuestionPrompt({ question, gradeBand, answers });
  const text = `你是國小老師的批改助理，學生是${gradeBand || '國小'}的孩子。請判斷每位學生這一題的答案對不對。

【題目】
${question}

【參考答案】
${reference ? reference : '（老師沒有給參考答案。請依題目判斷答案是否正確、合理；如果這題是問感想、沒有標準答案，只要有認真回答題目就算「對」。）'}

【判斷規則】
- 「對」：意思正確就算對。錯字、注音、口語、同義的說法都可以接受（孩子年紀小，要寬鬆）。
- 「部分對」：只答對一部分，或方向對但不完整。
- 「錯」：意思錯誤、答非所問、亂寫。
- 「無法判斷」：看不懂、或題目本身無法判斷。
- 選擇題（參考答案是選項）就要選項相同才算對。
- reason 用 15 字以內、老師一眼看得懂的話，例如「說出分類號的用途」「把焚化廠講成回收場」。
- 每個 id 都要回答，不要漏掉，也不要自己加 id。

【學生答案】（S 開頭是代號）
${answers.map(a => `${a.id}：${a.answer}`).join('\n')}`;
  return [{ text }];
}

/** 學生「自己出題、自己回答」：判斷題目合不合理、答案對不對 */
function selfQuestionPrompt({ question, gradeBand, answers }) {
  const text = `你是國小老師的批改助理，學生是${gradeBand || '國小'}的孩子。這一欄是學生「自己出題、自己回答」，題目和答案可能寫在同一格裡。

【這一欄的說明】
${question}

【判斷規則】
- 「對」：有認真出一題（和這次的學習有關、看得懂），而且自己寫的答案是正確的。
- 「部分對」：題目或答案只有一半正確，或答案不完整。
- 「錯」：答案是錯的、題目和答案對不起來、亂寫、或只寫題目沒寫答案。
- 「無法判斷」：看不懂，或沒辦法確定答案對不對（例如需要查資料才知道）。
- 錯字、注音、口語都可以接受（孩子年紀小，要寬鬆）。
- reason 用 15 字以內、老師一眼看得懂的話，例如「題目清楚答案正確」「答案和題目不符」。
- 每個 id 都要回答，不要漏掉，也不要自己加 id。

【學生寫的內容】（S 開頭是代號）
${answers.map(a => `${a.id}：${a.answer}`).join('\n')}`;
  return [{ text }];
}

// ---------- 5. 週會錄音轉逐字稿 ----------
export const TRANSCRIBE_SCHEMA = {
  type: 'OBJECT',
  properties: { transcript: { type: 'STRING' } },
  required: ['transcript'],
};

export function transcribePrompt() {
  return `請把這段錄音逐字轉成文字（逐字稿），給國小老師整理週會內容用。

【規則】
- 使用台灣繁體中文，照講話的內容寫，不要摘要、不要改寫、不要加評論。
- 經文和人名照聽到的寫；不確定的字，寫最可能的，並在後面加「（？）」。
- 完全聽不清楚的地方寫「（聽不清楚）」，不要自己編。
- 如果聽到學生的名字，一律改寫成「某位同學」。老師的名字可以保留。
- 不用標時間，也不用標是誰在說話。
- 沒有人說話或只有雜音，就回傳空字串。`;
}

// ---------- 6. 從舊檔案找出踏查地點（PDF、Word、Excel、照片…） ----------
export const PLACES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    places: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: '地點名稱，照文件寫的' },
          dates: { type: 'ARRAY', items: { type: 'STRING' }, description: '去這個地點的日期，西元 YYYY-MM-DD；文件沒寫或推算不出來就空陣列' },
          type: { type: 'STRING', enum: ['indoor', 'outdoor', 'mixed', 'unknown'] },
          typeFromDoc: { type: 'BOOLEAN', description: '室內／室外是不是文件上寫的（true）還是你推測的（false）' },
          transport: { type: 'STRING', enum: ['捷運', '專車', 'unknown'] },
          season: { type: 'STRING', enum: ['summer', 'winter', 'unknown'] },
          theme: { type: 'STRING', description: '文件寫的領域／主題，沒寫就空字串' },
          access: { type: 'STRING', description: '文件寫的交通方式說明，沒寫就空字串' },
          desc: { type: 'STRING', description: '文件寫的特色、參訪內容，沒寫就空字串' },
          source: { type: 'STRING', description: '出自哪一個檔案（照【檔案】後面的名字）' },
          quote: { type: 'STRING', description: '文件裡出現這個地點的那一小段原文（30 字以內），人名改成○○' },
        },
        required: ['name', 'dates', 'type', 'typeFromDoc', 'source', 'quote'],
      },
    },
    skipped: { type: 'ARRAY', items: { type: 'STRING' }, description: '看到但不算踏查地點的（校內活動、停課、放假…）' },
  },
  required: ['places'],
};

export function placesExtractPrompt({ docs = [], binarySource = '' } = {}) {
  const head = `你是幫國小老師整理「戶外踏查地點」的小幫手。下面是學校以前的踏查行程表、地點資料${binarySource ? '（附件是掃描檔或照片）' : '（PDF、Word、Excel 轉出來的文字，排版可能很亂，表格的一列會用「 | 」隔開）'}。
請找出每一個「戶外踏查去參訪的地點」，和去的日期。

【規則】
1. 只能用文件裡寫的內容，不可以自己編地點、日期或介紹。文件沒寫的欄位就留空字串（或 unknown）。
2. 不要抄任何人名、電話、班級、座號、名單（例如禁足名單、學生名字、聯絡人）。quote 裡如果有人名，改成「○○」。文件裡已經被遮掉的「○○」「（電話）」不用管它。
3. 校內活動（講座、演練、校內課程）、停課、放假、只寫「待定」的，不算地點，寫進 skipped。
4. 日期一律寫成西元 YYYY-MM-DD。民國年＋1911＝西元年（例如 110/9/28 → 2021-09-28）。
   只寫「11/17」沒寫年的，用文件標題的學年度推算：X 學年度＝民國 X 年 8 月到民國 X+1 年 7 月（8～12 月是民國 X 年，1～7 月是民國 X+1 年）。推算不出來就不要寫這個日期。
5. 同一個地點在文件裡出現很多次，只寫一筆，dates 放所有日期。名字寫法稍微不同但明顯是同一個地方（例如「總圖」和「高雄市立圖書館總館」），用文件裡比較完整的名字，寫一筆就好。
6. 同一天有兩個地點（例如 A 團、B 團分開去），兩個地點都要寫，日期一樣。
7. type：文件有寫室內／室外，就照寫，typeFromDoc=true；文件沒寫但很明顯（博物館、圖書館＝indoor；公園、步道＝outdoor；園區、植物園＝mixed），可以填，typeFromDoc=false；不確定就 unknown。
8. transport：文件有寫捷運、輕軌就填「捷運」；有寫專車、遊覽車就填「專車」；沒寫就 unknown。season：文件寫夏季／第一、四學季填 summer，秋冬／第二、三學季填 winter，沒寫 unknown。
9. source 寫這個地點出自哪一個檔案（照【檔案】後面的名字抄）。quote 抄原文裡這個地點出現的那一小段，讓老師可以對照。`;
  if (binarySource) return `${head}\n\n【檔案】${binarySource}\n（內容在附件）`;
  return `${head}\n\n${docs.map(d => `【檔案】${d.label || d.source}\n${d.text}`).join('\n\n')}`;
}
