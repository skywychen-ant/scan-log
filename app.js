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

// Levenshtein distance ≤ max? (early-exit DP — cheap for short IDs)
function editDistLe(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                              prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > max) return false;
        prev = cur;
    }
    return prev[b.length] <= max;
}

function addRecord(mode, label, value) {
    const now = new Date();
    const date = todayStr(now);
    if ($('#chk-dedupe').checked) {
        const todays = records.filter(r => r.date === date);
        if (todays.some(r => r.value === value)) {
            toast('⚠ 今日已有相同內容，未重複記錄');
            return false;
        }
        // OCR fuzzy dedupe: a long value differing from an existing one
        // by ≤2 chars is almost certainly the SAME document with a
        // one-character misread (e.g. 5 → S) — skip it.
        if (mode === 'ocr' && value.length >= 8) {
            const near = todays.find(r =>
                r.mode === 'ocr' && editDistLe(r.value, value, 2));
            if (near) {
                toast(`⚠ 與今日記錄「${near.value}」高度相似，視為重複已跳過`, 3500);
                return false;
            }
        }
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
// crop=true → only the centre band (around the dashed guide box).
// The frame is scaled TOWARDS a target width before OCR:
// - big frames shrink (recognition time scales with pixel count)
// - small frames from low-res cameras UPSCALE up to 2× — Tesseract
//   needs ~20–30 px text height; too few pixels-on-text = misreads
//   even when the on-screen preview looks perfectly sharp.
// Crop band tracks the visual guide (42–58%) with a small tolerance —
// a WIDE band swallows neighbouring lines (CJK text poisons the eng
// engine) when a whole page is in frame.
const OCR_TARGET_W_CROP = 1300, OCR_TARGET_W_FULL = 1400;
function grabFrame(v, crop) {
    let sx, sy, sw, sh;
    if (crop) {
        sx = Math.floor(v.videoWidth  * 0.04);
        sy = Math.floor(v.videoHeight * 0.37);
        sw = Math.floor(v.videoWidth  * 0.92);
        sh = Math.floor(v.videoHeight * 0.26);
    } else {
        sx = 0; sy = 0; sw = v.videoWidth; sh = v.videoHeight;
    }
    // Crop band: PRESERVE native pixels up to 2000px wide — users scan
    // whole pages at a distance, where the ID is only ~10px tall; any
    // downscale kills it. Only tiny sources upscale, huge ones cap.
    let scale;
    if (crop) {
        scale = sw < OCR_TARGET_W_CROP ? Math.min(2, OCR_TARGET_W_CROP / sw)
              : sw > 2000              ? 2000 / sw
              : 1;
    } else {
        scale = Math.min(1.5, OCR_TARGET_W_FULL / sw);
    }
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Grayscale + contrast boost: faster AND more accurate on printed
    // documents (silently ignored where ctx.filter is unsupported).
    try { ctx.filter = 'grayscale(1) contrast(1.25)'; } catch { /* optional */ }
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
}

// restore prefs
if (prefs.ocrLabel) $('#ocr-label').value = prefs.ocrLabel;
if (prefs.ocrScope) $('#ocr-scope').value = prefs.ocrScope;
if (prefs.ocrMode)   $('#ocr-mode').value   = prefs.ocrMode;
if (prefs.ocrFormat) $('#ocr-format').value = prefs.ocrFormat;
if (prefs.ocrTarget) $('#ocr-target').value = prefs.ocrTarget;
$('#ocr-label').addEventListener('change', () => {
    prefs.ocrLabel = $('#ocr-label').value; savePrefs(prefs);
});
$('#ocr-scope').addEventListener('change', () => {
    prefs.ocrScope = $('#ocr-scope').value; savePrefs(prefs);
});
$('#ocr-format').addEventListener('change', () => {
    prefs.ocrFormat = $('#ocr-format').value; savePrefs(prefs);
});
$('#ocr-target').addEventListener('change', () => {
    prefs.ocrTarget = $('#ocr-target').value; savePrefs(prefs);
    applyOcrTarget();
});

// Report ID preset hides the custom keyword / scope / format rows
function applyOcrTarget() {
    const custom = $('#ocr-target').value === 'custom';
    $('#ocr-custom-row').hidden = !custom;
    $('#ocr-scope-row').hidden = !custom;
    $('#ocr-format-row').hidden = !custom;
}

function targetLabel() {
    return $('#ocr-target').value === 'report-id'
        ? 'Report ID' : $('#ocr-label').value.trim();
}

// Unified extraction for both capture paths.
// Returns { value, via: 'label'|'format', formatFail: string|null }
function extractValue(raw) {
    if ($('#ocr-target').value === 'report-id') {
        return { value: extractReportId(raw), via: 'label', formatFail: null };
    }
    let value = extractAfterLabel(raw, targetLabel(), $('#ocr-scope').value);
    let formatFail = null, via = 'label';
    if (value && !valueFormatOk(value)) { formatFail = value; value = null; }
    if (!value) {
        const fb = fallbackValue(raw);
        if (fb) { value = fb; via = 'format'; }
    }
    if (value) value = normalizeValue(value);
    return { value, via, formatFail };
}

// Optional value-format gate: rejects OCR misreads containing chars
// the real ID can't have (e.g. hex ID misread "…BE0S" — S isn't hex).
function valueFormatOk(v) {
    switch ($('#ocr-format').value) {
        case 'hex':    return /^[0-9A-Fa-f]+$/.test(v);
        case 'alnum':  return /^[0-9A-Za-z]+$/.test(v);
        case 'digits': return /^[0-9]+$/.test(v);
        default:       return true;
    }
}

// Hex IDs are recorded uppercase for consistent dedupe/export.
function normalizeValue(v) {
    return $('#ocr-format').value === 'hex' ? v.toUpperCase() : v;
}

// ── Dedicated Report ID detector (the tool's primary use case) ──
// Finds a 20-char hex run ANYWHERE in the band — no label needed, so
// it survives the two-column layout where Tesseract splits label and
// value into separate lines. Hardened against real-world OCR faults:
// - values broken by spaces (lines are compacted before matching)
// - 0→O / 1→l / 5→S style misreads INSIDE the value (a repair pass
//   maps confusables to hex; raw matches take precedence)
// - label tail merged onto the value when the colon is dropped
//   ("…ReportID480F…" → 21-26 run → take the trailing 20 chars)
// - CJK-noise garbage: candidates must LOOK like an ID (≥5 digits and
//   ≥3 a-f letters — a random 20-hex has ~12 digits / ~7 letters)
function extractReportId(text) {
    const looksLikeId = c =>
        (c.match(/[0-9]/g) || []).length >= 5 &&
        (c.match(/[A-Fa-f]/g) || []).length >= 3;
    const collect = (line, set) => {
        for (const run of line.match(/[0-9A-Fa-f]+/g) || []) {
            let cand = null;
            if (run.length === 20) cand = run;
            else if (run.length >= 21 && run.length <= 26) cand = run.slice(-20);
            if (cand && looksLikeId(cand)) set.add(cand.toUpperCase());
        }
    };
    const MAP = { O:'0', o:'0', Q:'0', I:'1', l:'1', i:'1', '|':'1', '!':'1', S:'5', s:'5', Z:'2', z:'2' };
    const raw = new Set(), repaired = new Set();
    for (const line0 of text.split(/\r?\n/)) {
        const compact = line0.replace(/\s+/g, '');
        collect(compact, raw);
        collect(compact.replace(/[OoQIli|!SsZz]/g, ch => MAP[ch]), repaired);
    }
    if (raw.size === 1) return [...raw][0];
    if (raw.size === 0 && repaired.size === 1) return [...repaired][0];
    return null;
}

// ── Two-stage refinement: locate the "Report ID" label via the word
// bounding boxes from the first OCR pass, then re-OCR ONLY the value
// zone (right of the label) magnified 2–4× in single-line mode.
// This is what rescues far/whole-page scans: the label is bold enough
// to read, the value is not — until it's blown up.
function reportIdRoi(blocks, W, H) {
    const lines = [];
    for (const b of blocks || []) {
        for (const p of b.paragraphs || []) {
            for (const l of p.lines || []) lines.push(l);
        }
    }
    const clean = w => ((w && w.text) || '').replace(/[^A-Za-z0-9]/g, '');
    let bb = null;
    for (const l of lines) {
        const ws = l.words || [];
        for (let i = 0; i < ws.length && !bb; i++) {
            const t = clean(ws[i]);
            // "Report" followed by "ID", or merged "ReportID"
            if (/^Rep[o0]rt$/i.test(t) && /^[I1l|!][DO0]?$/i.test(clean(ws[i + 1]))) {
                bb = (ws[i + 1].bbox) || ws[i].bbox;
            } else if (/^Rep[o0]rt[I1l|!][DO0]$/i.test(t)) {
                bb = ws[i].bbox;
            }
        }
        if (bb) break;
    }
    if (!bb) return null;
    const lineH = Math.max(8, bb.y1 - bb.y0);
    const x = Math.min(bb.x1 + 2, W - 20);
    const y = Math.max(0, bb.y0 - lineH * 0.7);
    const h = Math.min(H, bb.y1 + lineH * 0.7) - y;
    const w = W - x;
    return (w < 40 || h < 8) ? null : { x, y, w, h };
}

async function refineReportId(worker, canvas, blocks) {
    try {
        const roi = reportIdRoi(blocks, canvas.width, canvas.height);
        if (!roi) return null;
        const scale = Math.min(4, Math.max(2, 1200 / roi.w));
        const c2 = document.createElement('canvas');
        c2.width = Math.round(roi.w * scale);
        c2.height = Math.round(roi.h * scale);
        const ctx = c2.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        try { ctx.filter = 'grayscale(1) contrast(1.4)'; } catch { /* optional */ }
        ctx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, c2.width, c2.height);
        await setPsm(worker, '7');            // single text line
        const { data } = await worker.recognize(c2);
        await setPsm(worker, '6');
        return extractReportId(data.text || '');
    } catch { return null; }
}

// Label-free FALLBACK: when a value format is set, a long
// format-matching token in the band IS the value even if the label
// itself was garbled by OCR ("Rcport I0 :" etc.). Requires ≥12 chars
// including a digit, and must be unambiguous (single distinct match).
function fallbackValue(text) {
    if ($('#ocr-format').value === 'any') return null;
    const cands = new Set();
    for (const tok0 of text.split(/\s+/)) {
        const tok = tok0.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, '');
        if (tok.length < 12 || !/[0-9]/.test(tok)) continue;
        if (valueFormatOk(tok)) cands.add(normalizeValue(tok));
    }
    return cands.size === 1 ? [...cands][0] : null;
}
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
        // Ask for the camera's best resolution (weak cameras deliver
        // their max; strong ones cap near 2560) — OCR quality depends
        // on pixels-on-text, not on how sharp the preview looks.
        ocrStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } },
            audio: false
        });
    } catch (err) {
        toast('⚠ 無法啟動相機：' + (err?.message || err), 4000);
        return;
    }
    // Prefer continuous autofocus where the platform allows it
    // (reduces focus hunting on document text)
    try {
        await ocrStream.getVideoTracks()[0]
            .applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch { /* unsupported — camera default behaviour */ }
    setupZoom();
    const v = $('#ocr-video');
    v.srcObject = ocrStream;
    v.hidden = false;
    await v.play();
    $('#ocr-placeholder').hidden = true;
    $('#ocr-guide').hidden = false;
    $('#btn-ocr-start').hidden = true;
    $('#btn-ocr-stop').hidden = false;
    // Diagnostic: the resolution actually delivered (OCR quality
    // depends on it; helps debug weak-camera reports)
    toast(`相機解析度 ${v.videoWidth}×${v.videoHeight}`, 1800);
    applyOcrMode();
    // Pre-warm the OCR engine in the background (auto mode's loop
    // awaits ensureTesseract itself)
    ensureTesseract().catch(() => {});
}
// Hardware zoom buttons — real optical/sensor zoom adds actual pixels
// on the text (unlike digital upscaling). Shown only when the camera
// exposes a zoom capability (Android Chrome mostly; iOS Safari: none).
function setupZoom() {
    const row = $('#ocr-zoom-row');
    row.hidden = true;
    if (!ocrStream) return;
    const track = ocrStream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.zoom || !(caps.zoom.max > 1)) return;
    row.hidden = false;
    row.querySelectorAll('.zoom-opt').forEach(b => {
        const z = parseFloat(b.dataset.zoom);
        b.hidden = z > caps.zoom.max;
        b.classList.toggle('primary', z === 1);
        b.onclick = async () => {
            try {
                await track.applyConstraints({ advanced: [{ zoom: z }] });
                row.querySelectorAll('.zoom-opt').forEach(x =>
                    x.classList.toggle('primary', x === b));
            } catch { toast('此相機不支援此變焦倍率'); }
        };
    });
}

function stopOcrCamera() {
    autoRunning = false;
    if (ocrStream) {
        ocrStream.getTracks().forEach(t => t.stop());
        ocrStream = null;
    }
    $('#ocr-zoom-row').hidden = true;
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
            preserve_interword_spaces: '1',
            // Documents are dark-text-on-light: skip the inverted-image
            // second pass Tesseract tries by default (~2x per-frame cost)
            tessedit_do_invert: '0'
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
// Show exactly what OCR sees (ground truth for "is the text big
// enough?"). Updated only while the debug panel is expanded (toDataURL
// is not free), or forced for one-shot manual captures.
function updateBandPreview(canvas, force) {
    const wrap = $('#ocr-raw-wrap');
    if (!force && !wrap.open) return;
    $('#ocr-band-info').textContent =
        `OCR 實際收到的影像：${canvas.width}×${canvas.height}px（文字高度需 ≥20px 才易辨識）`;
    const img = $('#ocr-band-preview');
    img.src = canvas.toDataURL('image/jpeg', 0.7);
    img.hidden = false;
}

function setOcrStatus(msg) {
    const el = $('#ocr-status');
    // Keep the element in flow (nbsp) while the camera runs — toggling
    // its height every frame made the whole camera view jitter.
    el.textContent = msg || '\u00A0';
    el.hidden = !msg && !ocrStream;
}

async function captureAndRecognize() {
    const v = $('#ocr-video');
    if (!ocrStream || !v.videoWidth) { toast('相機尚未就緒'); return; }
    const label = targetLabel();
    if (!label) { toast('請先輸入目標關鍵字'); return; }

    $('#btn-ocr-capture').disabled = true;
    try {
        const canvas = grabFrame(v, false);   // full frame in manual mode
        updateBandPreview(canvas, true);
        const worker = await ensureTesseract();
        await setPsm(worker, '3');
        setOcrStatus('⏳ 辨識中…');
        const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
        setOcrStatus('');

        const raw = data.text || '';
        $('#ocr-raw').textContent = raw.trim() || '(無辨識結果)';
        $('#ocr-raw-wrap').hidden = false;

        let { value, via, formatFail } = extractValue(raw);
        if (!value && $('#ocr-target').value === 'report-id') {
            setOcrStatus('⏳ 放大值區域再辨識…');
            const refined = await refineReportId(worker, canvas, data.blocks);
            setOcrStatus('');
            if (refined) value = refined;
        }
        if (value) {
            beep();
            pendingOcrValue = value;
            $('#ocr-result-label').textContent =
                via === 'label' ? '擷取結果' : '擷取結果（格式直抓，未讀到關鍵字）';
            $('#ocr-result-text').textContent = value;
            $('#ocr-result-actions').hidden = false;
            $('#ocr-result').hidden = false;
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (formatFail) {
            toast(`找到關鍵字，但「${formatFail}」不符值格式，已拒絕`, 3500);
        } else if ($('#ocr-target').value === 'report-id') {
            toast('未偵測到 20 碼 Report ID，請靠近讓該行填滿畫面再試', 3000);
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
// Multi-frame consensus: exact-match confirmation deadlocks when OCR
// flickers between two VALID readings (e.g. 8↔B are both hex). Instead,
// cluster recent readings that are within edit distance 3 of the
// latest, then take a per-position majority vote (ties → latest frame).
function consensusValue(buf) {
    if (buf.length < 2) return null;
    const last = buf[buf.length - 1];
    const close = buf.filter(v => v.length === last.length && editDistLe(v, last, 3));
    if (close.length < 2) return null;
    let out = '';
    for (let i = 0; i < last.length; i++) {
        const freq = {};
        for (const v of close) freq[v[i]] = (freq[v[i]] || 0) + 1;
        let best = last[i];
        for (const [ch, n] of Object.entries(freq)) {
            if (n > freq[best]) best = ch;
        }
        out += best;
    }
    return out;
}

async function autoLoop() {
    if (autoRunning) return;                  // already looping
    autoRunning = true;
    let votes = [];                           // recent readings { value, at }
    try {
        const worker = await ensureTesseract();
        await setPsm(worker, '6');
        const v = $('#ocr-video');
        while (autoRunning && ocrStream && $('#ocr-mode').value === 'auto') {
            if (!v.videoWidth) { await sleep(300); continue; }
            const label = targetLabel();
            if (!label) { setOcrStatus('請先輸入目標關鍵字'); await sleep(800); continue; }

            if (!votes.length) setOcrStatus('🔍 自動辨識中… 將關鍵字對準虛線框');
            let raw = '', blocks = null, frame = null;
            try {
                frame = grabFrame(v, true);
                updateBandPreview(frame, false);
                const res = await worker.recognize(frame, {}, { blocks: true, text: true });
                raw = res.data.text || '';
                blocks = res.data.blocks;
            } catch { /* skip bad frame */ }
            if (!autoRunning) break;

            $('#ocr-raw').textContent = raw.trim() || '(無辨識結果)';
            $('#ocr-raw-wrap').hidden = false;

            let { value, via, formatFail } = extractValue(raw);
            // Two-stage rescue: label located but value unreadable →
            // re-OCR the magnified value zone
            if (!value && frame && blocks && $('#ocr-target').value === 'report-id') {
                const refined = await refineReportId(worker, frame, blocks);
                if (refined) value = refined;
                if (!autoRunning) break;
            }
            if (!value && formatFail) {
                setOcrStatus(`⚠ 找到關鍵字，值「${formatFail}」不符格式 — 繼續辨識…`);
            } else if (!value && $('#ocr-target').value === 'report-id' &&
                       /R[e3]p[o0q]r?[t7]/i.test(raw.replace(/\s+/g, ''))) {
                // The label IS visible but no valid 20-hex value emerged —
                // almost always means the text is too small to read.
                setOcrStatus('👀 看得到 Report ID 標籤，但值太小讀不清 — 請靠近一點');
            }
            if (value) {
                // Stability gate: multi-frame consensus (when enabled).
                // Similar-but-not-identical readings VOTE per character
                // instead of requiring an exact repeat.
                if ($('#chk-ocr-stable').checked) {
                    const nowV = Date.now();
                    votes = votes.filter(x => nowV - x.at < 6000);
                    votes.push({ value, at: nowV });
                    const consensus = consensusValue(votes.map(x => x.value));
                    if (!consensus) {
                        setOcrStatus(`👀 偵測到 ${value} — 確認中…`);
                        await sleep(60);
                        continue;
                    }
                    value = consensus;
                    votes = [];
                }
                const now = Date.now();
                // Debounce: same value within 6 s = the same document
                if (!(value === lastAuto.value && now - lastAuto.at < 6000)) {
                    lastAuto = { value, at: now };
                    const added = addRecord('ocr', label, value);
                    beep();
                    const viaTag = via === 'format' ? '（格式直抓）' : '';
                    $('#ocr-result-label').textContent =
                        added ? `自動擷取${viaTag} · ✔ 已記錄` : `自動擷取${viaTag} · 重複未記錄`;
                    $('#ocr-result-text').textContent = value;
                    $('#ocr-result-actions').hidden = true;
                    $('#ocr-result').hidden = false;
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    await sleep(800);         // brief pause after a hit
                }
            }
            // Note: a missed frame does NOT reset the vote buffer —
            // entries expire by age (6 s) instead.
            await sleep(120);                 // yield between frames
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

// Common OCR character confusions — each label letter also matches the
// glyphs OCR typically mistakes it for (case handled by the 'i' flag).
const OCR_CONFUSE = {
    o: 'oO0Q', i: 'iIl1|!', l: 'lI1|!i', e: 'eE', s: 'sS5$',
    b: 'bB8', g: 'gG9', z: 'zZ2', t: 'tT7', d: 'dDO0',
    a: 'aA4', q: 'qQ9', u: 'uUvV', v: 'vVuU'
};

// Find `label` in OCR text (tolerating OCR noise) and return what follows.
function extractAfterLabel(text, label, scope) {
    // Build a whitespace-tolerant, case-insensitive regex from the label:
    // each char can be followed by optional spaces; letters expand to
    // their OCR-confusable set; ':' matches ';./,' too and is OPTIONAL
    // (OCR sometimes drops it entirely).
    const esc = c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = label.split('').map(ch => {
        if (/\s/.test(ch)) return '\\s*';
        if (ch === ':' || ch === '：') return '[:;：.,]?';
        const conf = OCR_CONFUSE[ch.toLowerCase()];
        const cls = conf ? '[' + conf.split('').map(esc).join('') + ']' : esc(ch);
        return cls + '\\s*';
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
    const added = addRecord('ocr', targetLabel(), pendingOcrValue);
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

// Selected range as { from, to } (inclusive, YYYY-MM-DD), or null if
// the custom range is incomplete.
function currentRange() {
    const scope = $('#rec-scope').value;
    const today = todayStr();
    if (scope === 'day') {
        const d = $('#rec-date').value || today;
        return { from: d, to: d };
    }
    if (scope === 'all') return { from: '0000-01-01', to: '9999-12-31' };
    if (scope === 'custom') {
        const f = $('#rec-from').value, t = $('#rec-to').value;
        if (!f || !t) return null;
        return f <= t ? { from: f, to: t } : { from: t, to: f };
    }
    const days = parseInt(scope, 10);          // '7' or '30'
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    return { from: todayStr(d), to: today };
}

function rangeRecords() {
    const rng = currentRange();
    if (!rng) return [];
    return records
        .filter(r => r.date >= rng.from && r.date <= rng.to)
        .sort((a, b) => a.ts - b.ts);
}

// Human label + filename tag for the current range
function rangeDesc() {
    const scope = $('#rec-scope').value;
    const rng = currentRange();
    if (!rng) return { label: '（範圍未設定）', tag: 'range' };
    if (scope === 'day') return { label: rng.from, tag: rng.from };
    if (scope === 'all') return { label: '全部記錄', tag: 'all' };
    return { label: `${rng.from} ~ ${rng.to}`, tag: `${rng.from}_to_${rng.to}` };
}

function renderRecords() {
    const sel = $('#rec-date');
    const keep = sel.value;
    const dates = datesWithRecords();
    sel.innerHTML = dates.map(d =>
        `<option value="${d}">${d}${d === todayStr() ? '（今天）' : ''}</option>`).join('');
    sel.value = dates.includes(keep) ? keep : dates[0];
    const scope = $('#rec-scope').value;
    $('#rec-date').hidden = scope !== 'day';
    $('#rec-range').hidden = scope !== 'custom';
    renderList();
}

function renderList() {
    const list = rangeRecords();
    const rng = currentRange();
    const multiDay = !rng || rng.from !== rng.to;
    const ul = $('#rec-list');
    ul.innerHTML = '';
    $('#rec-empty').hidden = list.length > 0;
    $('#rec-count').textContent = list.length ? `共 ${list.length} 筆` : '';
    list.forEach((r, i) => {
        const li = document.createElement('li');
        li.className = 'rec-item';
        const modeIcon = r.mode === 'ocr' ? '🔤' : '📷';
        const when = multiDay ? `${r.date} ${r.time}` : r.time;
        li.innerHTML =
            `<span class="idx">${i + 1}</span>` +
            `<div class="body"><div class="val"></div>` +
            `<div class="meta">${modeIcon} ${escapeHtml(r.label || '')} · ${when}</div></div>` +
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
$('#rec-scope').addEventListener('change', renderRecords);
$('#rec-from').addEventListener('change', renderList);
$('#rec-to').addEventListener('change', renderList);
// custom-range defaults: today
$('#rec-from').value = todayStr();
$('#rec-to').value = todayStr();

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
    const list = rangeRecords();
    if (!list.length) { toast('此範圍沒有記錄'); return; }
    download(`scanlog_${rangeDesc().tag}.txt`,
        list.map(r => r.value).join('\n') + '\n', 'text/plain;charset=utf-8');
});

$('#btn-export-csv').addEventListener('click', () => {
    const list = rangeRecords();
    if (!list.length) { toast('此範圍沒有記錄'); return; }
    const q = s => '"' + String(s).replace(/"/g, '""') + '"';
    const rows = ['date,time,mode,label,value'];
    list.forEach(r => rows.push([r.date, r.time, r.mode, q(r.label || ''), q(r.value)].join(',')));
    // BOM so Excel opens UTF-8 correctly
    download(`scanlog_${rangeDesc().tag}.csv`,
        '\uFEFF' + rows.join('\n') + '\n', 'text/csv;charset=utf-8');
});

$('#btn-copy-list').addEventListener('click', async () => {
    const list = rangeRecords();
    if (!list.length) { toast('此範圍沒有記錄'); return; }
    try {
        await navigator.clipboard.writeText(list.map(r => r.value).join('\n'));
        toast(`✔ 已複製 ${list.length} 筆到剪貼簿`);
    } catch {
        toast('⚠ 複製失敗，請改用匯出');
    }
});

$('#btn-clear-day').addEventListener('click', () => {
    const list = rangeRecords();
    if (!list.length) { toast('此範圍沒有記錄'); return; }
    const desc = rangeDesc().label;
    if (!confirm(`確定刪除 ${desc} 的全部 ${list.length} 筆記錄？此動作無法復原。`)) return;
    const ids = new Set(list.map(r => r.ts));
    records = records.filter(r => !ids.has(r.ts));
    saveRecords(records);
    updateTodayBadge();
    renderRecords();
    toast('已清除');
});

// ───────── Init ─────────
AntTheme.attach();
updateTodayBadge();
applyOcrTarget();

// PWA service worker (offline caching of app shell)
if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Release cameras when app goes to background
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopScanner(); stopOcrCamera(); }
});

})();
