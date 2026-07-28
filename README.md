# ScanLog 掃碼記錄 v1.0

手機掃描工具（PWA 網頁應用程式），三大功能：

1. **📷 掃碼** — 用手機相機掃 QR Code / Barcode（Code 128 / 39、EAN、
   UPC、Data Matrix、PDF417 等），讀取文字內容並記錄。
2. **🔤 文字擷取（OCR）** — 設定目標關鍵字（例如 `Report ID:`），
   對準文件按「擷取辨識」，自動抓取關鍵字後面的字串。
   可選「至空白為止」或「整行」兩種擷取範圍。
3. **📋 每日記錄清單** — 掃描結果依日期分組，可匯出 TXT / CSV、
   一鍵複製到剪貼簿、單筆刪除或整日清除。

資料全部存在手機瀏覽器的 `localStorage`，不會上傳任何伺服器。

## 技術架構

- 純 HTML / CSS / JS，無後端（與本 workspace 其他工具同一技術路線；
  因為要在手機上跑，所以是 PWA 而不是 pywebview 桌面包裝）
- 條碼解碼：`lib/html5-qrcode.min.js`（v2.3.8，已本地打包，離線可用）
- OCR：`tesseract.js` v5（首次使用 OCR 時才從 CDN 延遲載入，
  需要網路；之後瀏覽器會快取）
- PWA：`manifest.json` + `sw.js`，可「加入主畫面」安裝、
  掃碼功能離線可用

## ⚠ 部署重點：相機需要 HTTPS

瀏覽器規定 `getUserMedia`（相機）只能在 **安全來源（HTTPS 或
localhost）** 使用。手機直接開 `file://` 或 `http://192.168.x.x`
都拿不到相機。部署選項：

### 選項 A：GitHub Pages（✅ 已部署，正式網址）

**https://skywychen-ant.github.io/scan-log/**

Repo: https://github.com/skywychen-ant/scan-log
（main branch 根目錄直接發佈；改版後 `git push` 即自動更新，
約 1 分鐘生效。）

（注意：GitHub Pages 為公開網址，內容僅為靜態工具頁面、不含資料，
掃描記錄只存在使用者手機本機。）

### 選項 B：內部網頁伺服器

放到任何公司內部支援 HTTPS 的靜態網站空間即可，整個資料夾拷貝上去。

### 選項 C：電腦本機測試（開發用）

```powershell
cd scan-log
python -m http.server 8000
# 電腦瀏覽器開 http://localhost:8000 （localhost 視同安全來源）
```

手機測試需 HTTPS，可用 `ngrok http 8000` 之類的隧道工具產生
臨時 HTTPS 網址。

## 手機安裝（加入主畫面）

- **iPhone (Safari)**：分享 → 加入主畫面
- **Android (Chrome)**：選單 ⋮ → 加入主畫面 / 安裝應用程式

安裝後以獨立視窗開啟，外觀如原生 App。

## 使用說明

### 掃碼
「開始掃描」→ 對準條碼 → 嗶聲 + 震動即記錄成功。
同一條碼 3 秒內不重複；「今日相同內容不重複記錄」勾選時，
當日重複內容自動跳過。

### 文字擷取
1. 輸入關鍵字（預設 `Report ID:`，會記住上次設定）
2. 「啟動相機」→ 將文件文字對準畫面中間虛線框
3. 「📸 擷取辨識」→ OCR 完成後顯示擷取結果
4. 確認無誤按「✔ 加入記錄」

比對容忍 OCR 雜訊：大小寫不拘、字元間空白、`：`/`;` 誤認為 `:` 等。
若沒抓到，可展開「OCR 原始辨識文字」檢查辨識品質，調整距離 / 光線再試。

### 記錄
選日期 → 匯出 TXT（一行一筆值）或 CSV（date,time,mode,label,value，
含 BOM 可直接用 Excel 開）→ 或「📋 複製」貼到其他 App。

## 檔案結構

```
scan-log/
├── index.html            # 單頁 App（三個分頁）
├── style.css             # 行動優先樣式 + 標準三段式主題切換
├── app.js                # 掃碼 / OCR / 記錄邏輯
├── manifest.json         # PWA 安裝設定
├── sw.js                 # Service worker（離線快取 app shell）
├── icon.svg              # App 圖示
└── lib/
    ├── html5-qrcode.min.js   # 條碼解碼引擎（本地打包）
    └── theme.js              # 套件標準主題切換引擎
```

## 已知限制

- OCR 首次使用需網路下載 tesseract.js 引擎與英文語言資料（約 15 MB，
  之後由瀏覽器快取）；純掃碼功能完全離線可用。
- OCR 語言目前為英文（`eng`），適合 Report ID 這類英數字串；
  若需辨識中文可改 `createWorker('eng+chi_tra')`（語言檔較大）。
- iOS Safari 對 PWA 的 localStorage 有「7 天未使用可能清除」政策；
  若記錄重要，建議每天匯出。
- 記錄僅存於該手機瀏覽器，不跨裝置同步。
