// ═══════════════════════════════════════════════════════
//  ScanLog v1.0 — QR / Barcode + OCR keyword capture, daily lists
//  Pure client-side. Data persisted in localStorage.
// ═══════════════════════════════════════════════════════
(function () {
'use strict';

const STORE_KEY = 'scan-log-records';
const PREF_KEY  = 'scan-log-prefs';

// ───────── Storage ─────────
// record: { ts, date:'YYYY-MM-DD', time:'HH:MM:SS', mode:'qr'|'ocr', label, value }
function loadRecords() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
    catch { return []; }
}
function saveRecords(recs) {
    localStorage.setItem(STORE_KEY, JSON.stringify(recs));
}
let records = loadRecords();

function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; }
    catch { return {}; }
}
function savePrefs(p) { localStorage.setItem(PREF_KEY, JSON.stringify(p)); }
const prefs = loadPrefs();

function todayStr(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function timeStr(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function addRecord(mode, label, value) {
    const now = new Date();
    const date = todayStr(now);
    if ($('#chk-dedupe').checked &&
        records.some(r => r.date === date && r.value === value)) {
        toast('⚠ 今日已有相同內容，未重複記錄');
        return false;
    }
    records.push({ ts: now.getTime(), date, time: timeStr(now), mode, label, value });
    saveRecords(records);
    updateTodayBadge();
    if (currentTab === 'records') renderRecords();
    return true;
}

// ───────── Helpers ─────────
const $ = s => document.querySelector(s);
let toastTimer = null;
function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
let audioCtx = null;
function beep() {
    try {
        // Shared AudioContext: created on first (user-initiated) beep and
        // reused — required for reliable sound in the auto-OCR loop, where
        // later beeps happen outside a direct user gesture.
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
        osc.connect(g); g.connect(audioCtx.destination);
        osc.frequency.value = 1200; g.gain.value = 0.15;
        osc.start(); osc.stop(audioCtx.currentTime + 0.15);
    } catch { /* audio unavailable */ }
    // Note: iOS Safari has no web vibration API — Android only.
    if (navigator.vibrate) navigator.vibrate(200);
}

function updateTodayBadge() {
    const n = records.filter(r => r.date === todayStr()).length;
    const b = $('#today-count-badge');
    b.textContent = n;
    b.hidden = n === 0;
}

// ───────── Tabs ─────────
let currentTab = 'scan';
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
function switchTab(tab) {
    if (tab === currentTab) return;
    // stop cameras when leaving camera tabs
    if (currentTab === 'scan') stopScanner();
    if (currentTab === 'ocr') stopOcrCamera();
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p =>
        p.classList.toggle('active', p.id === 'tab-' + tab));
    if (tab === 'records') renderRecords();
}

// ═══════════ Tab 1: QR / Barcode scanning ═══════════
let qrScanner = null;
let scannerRunning = false;
let lastScan = { text: null, at: 0 };

async function startScanner() {
    if (scannerRunning) return;
    if (!window.isSecureContext) {
        toast('⚠ 需要 HTTPS 才能使用相機（請参考 README 部署）', 4000);
        return;
    }
    $('#scan-placeholder').hidden = true;
    if (!qrScanner) qrScanner = new Html5Qrcode('qr-reader');
    try {
        await qrScanner.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: (w, h) => {
                const size = Math.floor(Math.min(w, h) * 0.75);
                return { width: size, height: Math.floor(size * 0.7) };
            } },
            onScanSuccess,
            () => {} // per-frame decode misses — ignore
        );
        scannerRunning = true;
        $('#btn-scan-start').hidden = true;
        $('#btn-scan-stop').hidden = false;
    } catch (err) {
        $('#scan-placeholder').hidden = false;
        toast('⚠ 無法啟動相機：' + (err?.message || err), 4000);
    }
}
async function stopScanner() {
    if (!scannerRunning || !qrScanner) return;
    try { await qrScanner.stop(); qrScanner.clear(); } catch { /* already stopped */ }
    scannerRunning = false;
    $('#btn-scan-start').hidden = false;
    $('#btn-scan-stop').hidden = true;
    $('#scan-placeholder').hidden = false;
}

function onScanSuccess(text, result) {
    const now = Date.now();
    // Debounce: same code within 3 s = one scan
    if (text === lastScan.text && now - lastScan.at < 3000) return;
    lastScan = { text, at: now };

    const fmt = result?.result?.format?.formatName || 'code';
    const added = addRecord('qr', fmt, text);
    beep();
    $('#scan-result').hidden = false;
    $('#scan-result-text').textContent = text;
    $('#scan-result-meta').textContent =
        `${fmt} · ${timeStr()}` + (added ? ' · ✔ 已記錄' : ' · 未記錄（重複）');
}

$('#btn-scan-start').addEventListener('click', startScanner);
$('#btn-scan-stop').addEventListener('click', stopScanner);

// ═══════════ Tab 2: OCR keyword capture ═══════════
let ocrStream = null;
let tesseractWorker = null;
let tesseractLoading = null;
let pendingOcrValue = null;
let autoRunning = false;
let lastAuto = { value: null, at: 0 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Grab the current video frame onto a canvas.
// crop=true → only the centre band (around the dashed guide box):
// smaller image = noticeably faster OCR per frame in auto mode.
function grabFrame(v, crop) {
    const canvas = document.createElement('canvas');
    if (crop) {
        const sx = Math.floor(v.videoWidth  * 0.04);
        const sy = Math.floor(v.videoHeight * 0.30);
        const sw = Math.floor(v.videoWidth  * 0.92);
        const sh = Math.floor(v.videoHeight * 0.40);
        canvas.width = sw; canvas.height = sh;
        canvas.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
    } else {
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        canvas.getContext('2d').drawImage(v, 0, 0);
    }
    return canvas;
}

// restore prefs
if (prefs.ocrLabel) $('#ocr-label').value = prefs.ocrLabel;
if (prefs.ocrScope) $('#ocr-scope').value = prefs.ocrScope;
if (prefs.ocrMode)  $('#ocr-mode').value  = prefs.ocrMode;
$('#ocr-label').addEventListener('change', () => {
    prefs.ocrLabel = $('#ocr-label').value; savePrefs(prefs);
});
$('#ocr-scope').addEventListener('change', () => {
    prefs.ocrScope = $('#ocr-scope').value; savePrefs(prefs);
});
$('#ocr-mode').addEventListener('change', () => {
    prefs.ocrMode = $('#ocr-mode').value; savePrefs(prefs);
    applyOcrMode();
});
if (prefs.ocrStable === false) $('#chk-ocr-stable').checked = false;
$('#chk-ocr-stable').addEventListener('change', () => {
    prefs.ocrStable = $('#chk-ocr-stable').checked; savePrefs(prefs);
});

async function startOcrCamera() {
    if (ocrStream) return;
    if (!window.isSecureContext) {
        toast('⚠ 需要 HTTPS 才能使用相機（請参考 README 部署）', 4000);
        return;
    }
    try {
        ocrStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false
        });
    } catch (err) {
        toast('⚠ 無法啟動相機：' + (err?.message || err), 4000);
        return;
    }
    const v = $('#ocr-video');
    v.srcObject = ocrStream;
    v.hidden = false;
    await v.play();
    $('#ocr-placeholder').hidden = true;
    $('#ocr-guide').hidden = false;
    $('#btn-ocr-start').hidden = true;
    $('#btn-ocr-stop').hidden = false;
    applyOcrMode();
    // Pre-warm the OCR engine in the background (auto mode's loop
    // awaits ensureTesseract itself)
    ensureTesseract().catch(() => {});
}
function stopOcrCamera() {
    autoRunning = false;
    if (ocrStream) {
        ocrStream.getTracks().forEach(t => t.stop());
        ocrStream = null;
    }
    const v = $('#ocr-video');
    v.srcObject = null; v.hidden = true;
    $('#ocr-placeholder').hidden = false;
    $('#ocr-guide').hidden = true;
    $('#btn-ocr-start').hidden = false;
    $('#btn-ocr-capture').hidden = true;
    $('#btn-ocr-stop').hidden = true;
    $('#ocr-status').hidden = true;
}

// Switch between manual (button) and auto (continuous) capture.
// Safe to call anytime; only acts on the UI/loop when the camera runs.
function applyOcrMode() {
    const auto = $('#ocr-mode').value === 'auto';
    const running = !!ocrStream;
    $('#btn-ocr-capture').hidden = !running || auto;
    if (!auto) {
        autoRunning = false;          // loop exits after current frame
        if (running) setOcrStatus('');
    } else if (running) {
        $('#ocr-result-actions').hidden = true;
        autoLoop();
    }
}

// Lazy-load tesseract.js from CDN only when OCR is used (≈3 MB + language data)
function ensureTesseract() {
    if (tesseractWorker) return Promise.resolve(tesseractWorker);
    if (tesseractLoading) return tesseractLoading;
    tesseractLoading = (async () => {
        if (!window.Tesseract) {
            setOcrStatus('⏳ 首次使用：下載 OCR 引擎中…');
            await new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
                s.onload = res;
                s.onerror = () => rej(new Error('OCR 引擎下載失敗（需要網路連線）'));
                document.head.appendChild(s);
            });
        }
        setOcrStatus('⏳ 初始化 OCR 引擎…');
        tesseractWorker = await Tesseract.createWorker('eng');
        // Restrict to characters that appear in labels + ID values —
        // greatly reduces noise misreads (e.g. gap texture → "|"/"~").
        await tesseractWorker.setParameters({
            tessedit_char_whitelist:
                'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' +
                '0123456789:;.,#()/_- ',
            preserve_interword_spaces: '1'
        });
        setOcrStatus('');
        return tesseractWorker;
    })();
    tesseractLoading.catch(() => { tesseractLoading = null; });
    return tesseractLoading;
}

// Page-segmentation mode: '6' (single uniform block) suits the narrow
// cropped guide band in auto mode; '3' (full auto) suits manual full-frame.
let currentPsm = null;
async function setPsm(worker, psm) {
    if (currentPsm === psm) return;
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    currentPsm = psm;
}
function setOcrStatus(msg) {
    const el = $('#ocr-status');
    el.textContent = msg;
    el.hidden = !msg;
}

async function captureAndRecognize() {
    const v = $('#ocr-video');
    if (!ocrStream || !v.videoWidth) { toast('相機尚未就緒'); return; }
    const label = $('#ocr-label').value.trim();
    if (!label) { toast('請先輸入目標關鍵字'); return; }

    $('#btn-ocr-capture').disabled = true;
    try {
        const canvas = grabFrame(v, false);   // full frame in manual mode
        const worker = await ensureTesseract();
        await setPsm(worker, '3');
        setOcrStatus('⏳ 辨識中…');
        const { data } = await worker.recognize(canvas);
        setOcrStatus('');

        const raw = data.text || '';
        $('#ocr-raw').textContent = raw.trim() || '(無辨識結果)';
        $('#ocr-raw-wrap').hidden = false;

        const value = extractAfterLabel(raw, label, $('#ocr-scope').value);
        if (value) {
            beep();
            pendingOcrValue = value;
            $('#ocr-result-label').textContent = '擷取結果';
            $('#ocr-result-text').textContent = value;
            $('#ocr-result-actions').hidden = false;
            $('#ocr-result').hidden = false;
        } else {
            toast(`未找到「${label}」，請對準後再試`, 3000);
        }
    } catch (err) {
        setOcrStatus('');
        toast('⚠ ' + (err?.message || err), 4000);
    } finally {
        $('#btn-ocr-capture').disabled = false;
    }
}

// ── Auto mode: keep recognizing frames; when the keyword is found,
//    record immediately (beep confirms) — no button press needed.
async function autoLoop() {
    if (autoRunning) return;                  // already looping
    autoRunning = true;
    let candidate = { value: null, hits: 0 }; // consecutive-frame confirmation
    try {
        const worker = await ensureTesseract();
        await setPsm(worker, '6');
        const v = $('#ocr-video');
        while (autoRunning && ocrStream && $('#ocr-mode').value === 'auto') {
            if (!v.videoWidth) { await sleep(300); continue; }
            const label = $('#ocr-label').value.trim();
            if (!label) { setOcrStatus('請先輸入目標關鍵字'); await sleep(800); continue; }

            if (!candidate.value) setOcrStatus('🔍 自動辨識中… 將關鍵字對準虛線框');
            let raw = '';
            try {
                const { data } = await worker.recognize(grabFrame(v, true));
                raw = data.text || '';
            } catch { /* skip bad frame */ }
            if (!autoRunning) break;

            $('#ocr-raw').textContent = raw.trim() || '(無辨識結果)';
            $('#ocr-raw-wrap').hidden = false;

            const value = extractAfterLabel(raw, label, $('#ocr-scope').value);
            if (value) {
                // Stability gate: require the SAME value on 2 consecutive
                // frames (when enabled) — filters one-off OCR misreads.
                if ($('#chk-ocr-stable').checked && !(candidate.value === value && candidate.hits >= 1)) {
                    candidate = { value, hits: 1 };
                    setOcrStatus(`👀 偵測到 ${value} — 確認中…`);
                    await sleep(150);
                    continue;
                }
                candidate = { value: null, hits: 0 };
                const now = Date.now();
                // Debounce: same value within 6 s = the same document
                if (!(value === lastAuto.value && now - lastAuto.at < 6000)) {
                    lastAuto = { value, at: now };
                    const added = addRecord('ocr', label, value);
                    beep();
                    $('#ocr-result-label').textContent =
                        added ? '自動擷取 · ✔ 已記錄' : '自動擷取 · 重複未記錄';
                    $('#ocr-result-text').textContent = value;
                    $('#ocr-result-actions').hidden = true;
                    $('#ocr-result').hidden = false;
                    await sleep(800);         // brief pause after a hit
                }
            } else if (candidate.value) {
                candidate = { value: null, hits: 0 };   // lost it — reset
            }
            await sleep(250);                 // yield between frames
        }
    } catch (err) {
        toast('⚠ ' + (err?.message || err), 4000);
    } finally {
        autoRunning = false;
        if (ocrStream && $('#ocr-mode').value === 'auto') {
            // loop ended unexpectedly (e.g. engine error) — leave status off
            setOcrStatus('');
        }
    }
}

// Find `label` in OCR text (tolerating OCR noise) and return what follows.
function extractAfterLabel(text, label, scope) {
    // Build a whitespace-tolerant, case-insensitive regex from the label:
    // each char can be followed by optional spaces; ':' also matches ';' or '：'
    const esc = c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = label.split('').map(ch => {
        if (/\s/.test(ch)) return '\\s*';
        if (ch === ':' || ch === '：') return '[:;：]';
        return esc(ch) + '\\s*';
    }).join('');
    const re = new RegExp(pattern + '\\s*(.+)', 'i');

    for (const line of text.split(/\r?\n/)) {
        const m = line.match(re);
        if (m && m[1]) {
            // Clean up: OCR often re-reads the colon or picks up stray
            // punctuation in the wide gap between label and value
            // (e.g. "Report ID :   : C6BD…" → captured ":").
            let rest = m[1].replace(/^[\s:;：=.\-–—_|]+/, '').trim();
            if (scope === 'token') rest = rest.split(/\s+/)[0] || '';
            rest = rest.replace(/[.,;:：|]+$/, '');
            // Validity gate: a real value has at least 3 alphanumeric
            // chars — rejects lone colons / dashes / noise fragments.
            const alnum = (rest.match(/[A-Za-z0-9]/g) || []).length;
            if (rest && alnum >= 3) return rest;
        }
    }
    return null;
}

$('#btn-ocr-start').addEventListener('click', startOcrCamera);
$('#btn-ocr-stop').addEventListener('click', stopOcrCamera);
$('#btn-ocr-capture').addEventListener('click', captureAndRecognize);
$('#btn-ocr-save').addEventListener('click', () => {
    if (!pendingOcrValue) return;
    const added = addRecord('ocr', $('#ocr-label').value.trim(), pendingOcrValue);
    if (added) toast('✔ 已加入記錄');
    pendingOcrValue = null;
    $('#ocr-result').hidden = true;
});
$('#btn-ocr-discard').addEventListener('click', () => {
    pendingOcrValue = null;
    $('#ocr-result').hidden = true;
});

// ═══════════ Tab 3: Records ═══════════
function datesWithRecords() {
    const set = new Set(records.map(r => r.date));
    set.add(todayStr());
    return [...set].sort().reverse();
}

function renderRecords() {
    const sel = $('#rec-date');
    const keep = sel.value;
    const dates = datesWithRecords();
    sel.innerHTML = dates.map(d =>
        `<option value="${d}">${d}${d === todayStr() ? '（今天）' : ''}</option>`).join('');
    sel.value = dates.includes(keep) ? keep : dates[0];
    renderList();
}

function renderList() {
    const date = $('#rec-date').value;
    const list = records.filter(r => r.date === date);
    const ul = $('#rec-list');
    ul.innerHTML = '';
    $('#rec-empty').hidden = list.length > 0;
    list.forEach((r, i) => {
        const li = document.createElement('li');
        li.className = 'rec-item';
        const modeIcon = r.mode === 'ocr' ? '🔤' : '📷';
        li.innerHTML =
            `<span class="idx">${i + 1}</span>` +
            `<div class="body"><div class="val"></div>` +
            `<div class="meta">${modeIcon} ${escapeHtml(r.label || '')} · ${r.time}</div></div>` +
            `<button class="del" title="刪除">🗑</button>`;
        li.querySelector('.val').textContent = r.value;
        li.querySelector('.del').addEventListener('click', () => {
            records = records.filter(x => x.ts !== r.ts);
            saveRecords(records);
            updateTodayBadge();
            renderRecords();
        });
        ul.appendChild(li);
    });
}
function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('#rec-date').addEventListener('change', renderList);

function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

$('#btn-export-txt').addEventListener('click', () => {
    const date = $('#rec-date').value;
    const list = records.filter(r => r.date === date);
    if (!list.length) { toast('此日期沒有記錄'); return; }
    download(`scanlog_${date}.txt`, list.map(r => r.value).join('\n') + '\n', 'text/plain;charset=utf-8');
});

$('#btn-export-csv').addEventListener('click', () => {
    const date = $('#rec-date').value;
    const list = records.filter(r => r.date === date);
    if (!list.length) { toast('此日期沒有記錄'); return; }
    const q = s => '"' + String(s).replace(/"/g, '""') + '"';
    const rows = ['date,time,mode,label,value'];
    list.forEach(r => rows.push([r.date, r.time, r.mode, q(r.label || ''), q(r.value)].join(',')));
    // BOM so Excel opens UTF-8 correctly
    download(`scanlog_${date}.csv`, '\uFEFF' + rows.join('\n') + '\n', 'text/csv;charset=utf-8');
});

$('#btn-copy-list').addEventListener('click', async () => {
    const date = $('#rec-date').value;
    const list = records.filter(r => r.date === date);
    if (!list.length) { toast('此日期沒有記錄'); return; }
    try {
        await navigator.clipboard.writeText(list.map(r => r.value).join('\n'));
        toast(`✔ 已複製 ${list.length} 筆到剪貼簿`);
    } catch {
        toast('⚠ 複製失敗，請改用匯出');
    }
});

$('#btn-clear-day').addEventListener('click', () => {
    const date = $('#rec-date').value;
    const n = records.filter(r => r.date === date).length;
    if (!n) { toast('此日期沒有記錄'); return; }
    if (!confirm(`確定刪除 ${date} 的全部 ${n} 筆記錄？此動作無法復原。`)) return;
    records = records.filter(r => r.date !== date);
    saveRecords(records);
    updateTodayBadge();
    renderRecords();
    toast('已清除');
});

// ───────── Init ─────────
AntTheme.attach();
updateTodayBadge();

// PWA service worker (offline caching of app shell)
if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Release cameras when app goes to background
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopScanner(); stopOcrCamera(); }
});

})();
