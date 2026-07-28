// ═══════════════════════════════════════════════════════
//  theme.js — Dark / Light / Auto theme switcher (suite standard)
//
//  Storage key: 'scan-log-theme'  →  'dark' | 'light' | 'auto'
//  Applied by setting <html data-theme="dark|light"> attribute.
//  Loaded synchronously in <head> so the very first paint is correct.
//
//  Exposes: window.AntTheme = { get, set, cycle, attach, effective }
// ═══════════════════════════════════════════════════════
(function () {
'use strict';

const KEY    = 'scan-log-theme';
const VALID  = ['dark', 'light', 'auto'];
const ICON   = { dark: '🌙', light: '☀️', auto: '🖥️' };
const LABEL  = { dark: 'Dark', light: 'Light', auto: 'System' };

let _media = null;
let _onMediaChange = null;

function getStored() {
    const v = localStorage.getItem(KEY);
    return VALID.includes(v) ? v : 'auto';
}

function effective(mode) {
    if (mode !== 'auto') return mode;
    const m = window.matchMedia?.('(prefers-color-scheme: dark)');
    return m && m.matches ? 'dark' : 'light';
}

function apply(mode) {
    const eff = effective(mode);
    document.documentElement.setAttribute('data-theme', eff);
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
    }
    meta.content = eff === 'dark' ? '#0f1117' : '#f5f7fb';

    document.querySelectorAll('.theme-opt').forEach(b => {
        b.classList.toggle('active', b.dataset.themeOpt === mode);
    });
}

function set(mode) {
    if (!VALID.includes(mode)) mode = 'auto';
    localStorage.setItem(KEY, mode);
    apply(mode);
    bindMedia(mode);
    window.dispatchEvent(new CustomEvent('ant-theme-change', { detail: { mode, effective: effective(mode) } }));
}

function get() { return getStored(); }

function cycle() {
    const cur = get();
    const next = cur === 'dark' ? 'light' : cur === 'light' ? 'auto' : 'dark';
    set(next);
    return next;
}

function bindMedia(mode) {
    if (!_media) _media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!_media) return;
    if (_onMediaChange) {
        _media.removeEventListener('change', _onMediaChange);
        _onMediaChange = null;
    }
    if (mode === 'auto') {
        _onMediaChange = () => {
            apply('auto');
            window.dispatchEvent(new CustomEvent('ant-theme-change', { detail: { mode: 'auto', effective: effective('auto') } }));
        };
        _media.addEventListener('change', _onMediaChange);
    }
}

function onStorage(e) {
    if (e.key === KEY) {
        apply(getStored());
    }
}

function attach() {
    document.querySelectorAll('.theme-opt').forEach(b => {
        b.addEventListener('click', () => set(b.dataset.themeOpt));
    });
    apply(get());
    window.addEventListener('storage', onStorage);
}

apply(get());
bindMedia(get());

window.AntTheme = { get, set, cycle, attach, effective: () => effective(get()) };
})();
