# AI Search Sandbox（搜尋行為研究沙盒系統）

這是一個以 **Node.js (Express)** 建置的仿 Google 搜尋沙盒實驗系統，整合 **OpenRouter 即時網頁搜尋（Web Search）**、**多輪追問上下文**、**量化行為側錄（停留時間、超連結點擊）** 與 **質化轉折點紀錄（轉為實體原因）**，並支援同步寫入本地 CSV 與 **Google 試算表（Google Apps Script）**。

---

## 檔案結構

```text
.
├── server.js          # Express 後端伺服器與 API 路由
├── package.json       # 專案相依套件與啟動腳本
├── .env.example       # 環境變數範本
├── .gitignore         # Git 忽略清單（排除 .env、node_modules、*.csv）
├── gas/
│   └── Code.gs        # Google Apps Script 試算表接收腳本
└── public/
    ├── index.html     # 仿 Google 搜尋首頁、多輪對話串與「轉為實體」彈窗
    ├── styles.css     # 介面與引用膠囊樣式
    └── app.js         # 匿名 ID/Session、停留時間、點擊追蹤與追問邏輯
```

---

## API 路由與資料欄位

### 1. `POST /api/search`
- **用途**：接收受試者提問與對話脈絡，呼叫 OpenRouter API（啟用即時網頁搜尋），並強制以繁體中文整理摘要與引用來源。
- **Request Body**：
  ```json
  {
    "query": "台北101的高度是多少",
    "history": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "..." }
    ]
  }
  ```
- **Response**：`{ query, summary, sources }`

### 2. `POST /api/log-action`（量化行為側錄）
- **寫入目標**：本地 `search_logs.csv`（含 UTF-8 BOM）＋ 同步轉傳至 Google 試算表 `search_logs` 分頁（若有設定 `GAS_WEBHOOK_URL`）。
- **記錄欄位**：
  `timestamp`, `participant_id`, `session_id`, `turn`, `query`, `dwell_time_ms`, `clicked`, `click_count`, `clicked_urls`
- **觸發時機**：送出下一輪追問、點擊「轉為實體」，或頁面關閉/離開時（`pagehide` + `navigator.sendBeacon`）。

### 3. `POST /api/log-terminate`（質化轉折點）
- **寫入目標**：本地 `termination_study.csv` ＋ 同步轉傳至 Google 試算表 `termination_study` 分頁。
- **記錄欄位**：
  `timestamp`, `participant_id`, `session_id`, `last_query`, `reason`

---

## 本地啟動步驟

1. 安裝套件：
   ```bash
   npm install
   ```
2. 複製環境變數範本並填入金鑰：
   ```bash
   cp .env.example .env
   ```
   編輯 `.env`：
   ```env
   OPENROUTER_API_KEY=你的_OPENROUTER_API_KEY
   OPENROUTER_MODEL=google/gemini-2.5-flash-lite
   PORT=3000
   GAS_WEBHOOK_URL=你的_GAS_WEB_APP_URL
   ```
3. 啟動伺服器：
   ```bash
   npm start
   ```
4. 開啟瀏覽器前往 `http://localhost:3000`。

---

## Google 試算表同步設定（Google Apps Script）

1. 開啟一份新的 **Google 試算表** → 上方選單「**擴充功能**」→「**Apps Script**」。
2. 將 `gas/Code.gs` 完整貼入並儲存。
3. 點擊右上角「**部署**」→「**新增部署作業**」→ 類型選「**網頁應用程式（Web app）**」：
   - **執行身分**：我（Me）
   - **誰可以存取**：所有人（Anyone）
4. 完成授權後，將產生的 `/exec` 網址填入 `.env`（或正式主機環境變數）的 `GAS_WEBHOOK_URL`。

---

## 部署至 Railway

1. 將程式碼推上 GitHub（確認不含 `.env`、`node_modules/`、`*.csv`）。
2. 於 Railway 建立專案：**New Project → Deploy from GitHub repo**。
3. 在服務的 **Variables** 設定：
   - `OPENROUTER_API_KEY`
   - `OPENROUTER_MODEL`（建議 `google/gemini-2.5-flash-lite`）
   - `GAS_WEBHOOK_URL`
   - `PORT=3000`
4. 於 **Settings → Networking → Generate Domain**（Port 填 `3000`）產生公開網址即可分享給受試者使用。
