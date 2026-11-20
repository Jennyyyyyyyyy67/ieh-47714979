# 🚌 踏查文案小幫手

把每週二的「戶外踏查」和「週會」整理成家長 LINE 訊息、FB/IG 貼文、問卷題目和教學紀錄。

## 系統做了什麼

| 頁面 | 功能 |
|---|---|
| 🚌 踏查 | 行程表／學習單 → 挑照片（自動縮小）→ AI 看照片，老師核對 → 問卷連結 → 產生文案 → 發布前檢查清單 → 一鍵複製 |
| ⛪ 週會 | 貼上逐字稿 → AI 照範例格式整理成 300 字內的家長信 |
| 📤 本週發送 | 照 LINE 的順序排好：週會 → 踏查 → 照片；顯示「每週二 17:00」發送倒數；打開 LINE 官方帳號後台／Business Suite 的按鈕 |
| 📊 問卷檢查 | 上傳 Google 表單回覆 CSV＋學生名單 → 找出未交、遲交、重複交、名字打錯，並批改答案（名單不儲存） |
| 🗂️ 紀錄 | 以前的踏查和週會可以重新打開或刪除；**7 天後自動刪除**（清容量，可在設定改）；可下載文字備份 |
| ⚙️ 設定 | Gemini 鑰匙、模型、預設分享老師、發送時間、紀錄保留天數 |

### 安全規則（寫在程式裡，不用每次提醒 AI）
- 照片**不儲存**：只在畫面上使用，關掉就消失。縮小時也會去掉 GPS 等隱藏資訊。
- 上傳照片前要先勾「每位學生都有肖像同意」。
- AI 不辨認照片中的人；文案不可以出現學生姓名、班級、座號。系統會自動掃描並標紅色提醒。
- 事實以行程表／學習單為準，AI 會列出每件事的來源讓老師核對。
- 發布前的檢查清單（肖像同意、沒有個資、內容屬實、活動結束後才發）4 項都勾了，複製按鈕才會亮。

---

## 第一次設定（約 20 分鐘）

### 1. 打開網站（GitHub Pages）
1. 到這個儲存庫的 **Settings（設定）→ Pages**。
2. 「Source」選 **Deploy from a branch**，Branch 選 **main**、資料夾選 **/(root)**，按 Save。
3. 等 1～2 分鐘，上面會出現網址，例如 `https://你的帳號.github.io/ieh-47714979/`。

這時候網站已經可以用了，不過是「🧪 本機試用模式」：資料只存在那台裝置的瀏覽器裡。

### 2. 設定 Firebase（正式版：換手機也看得到資料）
1. 用 Google 帳號打開 https://console.firebase.google.com ，按「建立專案」。名字隨便取，Google Analytics 可以關掉。
2. **不要升級付費方案**，用免費的 Spark 方案就好。
3. 左邊選單 **Build → Authentication → 開始使用 → Email/密碼 → 啟用 → 儲存**。
4. 左邊選單 **Build → Firestore Database → 建立資料庫**，地區選 `asia-east1（台灣）`，選「正式版模式」。
5. 在 Firestore 的 **規則（Rules）** 分頁，把內容換成這個儲存庫的 `firestore.rules` 檔案內容，按「發布」。
   > 這一步很重要，它讓每位老師只能看到自己的資料。
6. 回到專案首頁，按「</>（網頁）」圖示新增網頁應用程式，會出現一段 `firebaseConfig = { apiKey: ..., ... }`。
7. 把那幾個值貼到這個儲存庫的 `firebase-config.js` 裡（可以直接在 GitHub 網頁上按鉛筆圖示修改）。
8. **Authentication → 設定 → 授權網域**，按「新增網域」，加入 `你的帳號.github.io`。

> 💡 `firebase-config.js` 裡的 apiKey 本來就會出現在網頁裡，放在公開儲存庫是正常的。真正保護資料的是第 5 步的規則。

### 3. 設定 Gemini 鑰匙
1. 打開 https://aistudio.google.com/apikey ，按 **Create API key**。
2. 登入網站 → ⚙️ 設定 → 貼上鑰匙 → 按「檢查鑰匙」→「儲存設定」。

⚠️ **注意**：Gemini 免費版的資料，Google 可能拿去改進產品。只上傳有肖像同意的照片；鑰匙就像密碼，不要給別人，也不要寫進程式碼。

---

## 檔案說明

```
index.html            網頁入口
css/style.css         外觀（手機、電腦都適用，支援深色模式）
firebase-config.js    Firebase 設定（要自己貼）
firestore.rules       Firebase 資料規則（每位老師的資料分開）
js/app.js             登入、分頁切換
js/store.js           資料存放（Firebase 或本機試用模式）
js/gemini.js          呼叫 Gemini
js/prompts.js         給 AI 的指令和範例（想改語氣就改這裡）
js/utils.js           小工具：照片縮小、CSV、民國日期、個資檢查、問卷檢查
js/views/*.js         各個頁面
tests/e2e.mjs         自動測試（用假的 AI 回覆）
```

## 自動測試

```bash
python3 -m http.server 8765
```

```bash
node tests/e2e.mjs
```

（需要先安裝 Playwright。測試用的是假的 Gemini 回覆，不會花到額度。）

## 之後要做（第 2 階段）
- 老師按確認後，自動發送到 LINE 官方帳號（Messaging API）和 FB 粉專。
- IG 規定一定要附照片，而系統不保存照片，所以 IG 維持「一鍵複製」。
