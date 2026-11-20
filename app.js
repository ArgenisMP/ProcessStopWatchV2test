/* Process Timer Pro — app.js
   Core state, timer, storage, stats, and view rendering.
   Requires: export.js (loaded after), lucide, tailwind. */
'use strict';

/* =========================================================
   STATE
   ========================================================= */
let startTime = 0;
let elapsedTime = 0;
let timerInterval = null;
let isRunning = false;

let lapStartTime = 0;
let lapElapsedTime = 0;
let laps = [];              // newest-first
let currentTemplate = null; // { name, steps: [{name, type}] }
let currentStepIndex = 0;

let savedSessions = [];
let activeView = 'timer';
const expandedIds = new Set();

/* =========================================================
   DOM refs
   ========================================================= */
let el = {};
function cacheEls() {
    el = {
        hDisplay: document.getElementById('hDisplay'),
        mDisplay: document.getElementById('mDisplay'),
        sDisplay: document.getElementById('sDisplay'),
        msDisplay: document.getElementById('msDisplay'),
        currentLapDisplay: document.getElementById('currentLapDisplay'),
        currentStepName: document.getElementById('currentStepName'),
        lapCounterTag: document.getElementById('lapCounterTag'),
        processName: document.getElementById('processName'),
        processCategory: document.getElementById('processCategory'),
        startPauseBtn: document.getElementById('startPauseBtn'),
        lapBtn: document.getElementById('lapBtn'),
        resetBtn: document.getElementById('resetBtn'),
        saveBtn: document.getElementById('saveBtn'),
        lapsTableBody: document.getElementById('lapsTableBody'),
        sessionStatusTag: document.getElementById('sessionStatusTag'),
        statusAccent: document.getElementById('statusAccent'),
        currentSessionStats: document.getElementById('currentSessionStats'),
        currentTemplateLabel: document.getElementById('currentTemplateLabel'),
    };
}

/* =========================================================
   INIT
   ========================================================= */
window.addEventListener('DOMContentLoaded', () => {
    cacheEls();
    applyTabStyles();
    loadSessionsFromStorage();
    migrateAll();
    renderSavedRecords();
    setupKeyboardShortcuts();
    initPWA();
    initTaktAndOEE();
    renderStudyView();
    renderCompareView();
    renderLapsTable();
    updateStepLabel();
    if (window.lucide) lucide.createIcons();
});

/* =========================================================
   PWA
   ========================================================= */
let deferredPrompt = null;
let installHandlerAttached = false;

function initPWA() {
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) {
        const t = document.getElementById('appStateText');
        if (t) t.textContent = "App Mode";
    }
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW failed:', err));
    }
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        const btn = document.getElementById('pwaInstallBtn');
        if (!btn) return;
        btn.classList.remove('hidden');
        btn.classList.add('flex');
        if (!installHandlerAttached) {
            installHandlerAttached = true;
            btn.addEventListener('click', async () => {
                if (!deferredPrompt) return;
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') showToast('Thanks for installing!', 'success');
                deferredPrompt = null;
                btn.classList.add('hidden');
                btn.classList.remove('flex');
            });
        }
    });
    window.addEventListener('appinstalled', () => {
        showToast('App installed successfully!', 'success');
        const t = document.getElementById('appStateText');
        if (t) t.textContent = "Installed";
    });
}

/* =========================================================
   FORMAT HELPERS
   ========================================================= */
const pad = (n, d = 2) => String(n).padStart(d, '0');
function fmtParts(ms) {
    ms = Math.max(0, Math.round(ms));
    const milliseconds = ms % 1000;
    const totalSeconds = Math.floor(ms / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return { h: pad(hours), m: pad(minutes), s: pad(seconds), ms: pad(milliseconds, 3) };
}
function fmtMs(ms) {
    const t = fmtParts(ms);
    return `${t.h}:${t.m}:${t.s}.${t.ms}`;
}
function fmtSec(ms) { return (ms / 1000).toFixed(3) + ' s'; }
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;').replace(/`/g, '&#096;');
}
function slugify(text) {
    return String(text ?? '').toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-').replace(/^-+/, '').replace(/-+$/, '') || 'process-record';
}

/* =========================================================
   MIGRATION — additive, old records stay valid
   ========================================================= */
function migrateRecord(s) {
    s.laps = (s.laps || []).map((l, i) => ({
        lapNum: l.lapNum ?? (i + 1),
        lapDurationMs: l.lapDurationMs ?? 0,
        totalTimeMs: l.totalTimeMs ?? 0,
        formattedLap: l.formattedLap ?? fmtMs(l.lapDurationMs || 0),
        formattedTotal: l.formattedTotal ?? fmtMs(l.totalTimeMs || 0),
        stepName: l.stepName ?? `Lap ${l.lapNum ?? (i + 1)}`,
        stepType: l.stepType ?? null,
        excluded: l.excluded === true,
        note: l.note ?? ''
    }));
    s.meta = s.meta || {};
    s.study = s.study || { performanceRating: 1.0, allowancesPct: 12, basis: 'observed' };
    s.oee = s.oee || null;
    return s;
}
function migrateAll() {
    savedSessions = savedSessions.map(migrateRecord);
}

/* =========================================================
   TIME FORMATTING for display (uses pre-split spans)
   ========================================================= */
function paintTimer(ms) {
    if (!el.hDisplay) return;
    const t = fmtParts(ms);
    el.hDisplay.textContent = t.h;
    el.mDisplay.textContent = t.m;
    el.sDisplay.textContent = t.s;
    el.msDisplay.textContent = t.ms;
}

/* =========================================================
   STOPWATCH CONTROL
   ========================================================= */
function toggleStartPause() {
    if (isRunning) pauseStopwatch();
    else startStopwatch();
}

function startStopwatch() {
    if (isRunning) return;
    isRunning = true;
    const now = performance.now();
    startTime = now - elapsedTime;
    lapStartTime = now - lapElapsedTime;
    timerInterval = requestAnimationFrame(updateTimer);

    el.startPauseBtn.innerHTML = `<i data-lucide="pause" class="w-5 h-5 fill-current"></i><span>Pause</span>`;
    el.startPauseBtn.className = "flex-1 min-w-[130px] py-3.5 px-6 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 active:scale-95 text-white transition-all shadow-lg glow-amber";
    el.lapBtn.disabled = false;
    el.resetBtn.disabled = false;
    el.saveBtn.disabled = false;

    el.sessionStatusTag.textContent = "Running";
    el.sessionStatusTag.className = "text-xs font-mono text-emerald-400 font-medium";
    el.statusAccent.className = "absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 transition-all duration-300";
    updateRunningIndicator();
    if (window.lucide) lucide.createIcons();
}

function pauseStopwatch() {
    if (!isRunning) return;
    isRunning = false;
    // Capture exact values at the pause moment (rAF could be up to 16 ms stale)
    const now = performance.now();
    elapsedTime = now - startTime;
    lapElapsedTime = now - lapStartTime;
    cancelAnimationFrame(timerInterval);
    paintTimer(elapsedTime);
    if (el.currentLapDisplay) el.currentLapDisplay.textContent = fmtMs(lapElapsedTime);

    el.startPauseBtn.innerHTML = `<i data-lucide="play" class="w-5 h-5 fill-current"></i><span>Resume</span>`;
    el.startPauseBtn.className = "flex-1 min-w-[130px] py-3.5 px-6 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white transition-all shadow-lg glow-indigo";

    el.sessionStatusTag.textContent = "Paused";
    el.sessionStatusTag.className = "text-xs font-mono text-amber-400 font-medium";
    el.statusAccent.className = "absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-500 transition-all duration-300";
    updateRunningIndicator();
    if (window.lucide) lucide.createIcons();
}

function updateTimer(timestamp) {
    if (!isRunning) return;
    elapsedTime = timestamp - startTime;
    lapElapsedTime = timestamp - lapStartTime;
    paintTimer(elapsedTime);
    if (el.currentLapDisplay) el.currentLapDisplay.textContent = fmtMs(lapElapsedTime);
    timerInterval = requestAnimationFrame(updateTimer);
}

/* =========================================================
   TEMPLATE + STEP LOGIC
   ========================================================= */
function updateStepLabel() {
    if (!el.currentStepName) return;
    if (currentTemplate && currentTemplate.steps.length > 0) {
        const step = currentTemplate.steps[currentStepIndex % currentTemplate.steps.length];
        el.currentStepName.textContent = step.name;
    } else {
        el.currentStepName.textContent = `Lap ${laps.length + 1}`;
    }
    if (el.currentTemplateLabel) {
        el.currentTemplateLabel.textContent = currentTemplate
            ? `${currentTemplate.name} (${currentTemplate.steps.length} steps)`
            : 'None (simple laps)';
    }
}

function recordLap() {
    if (elapsedTime === 0) return;
    const now = performance.now();
    const currentLapDuration = isRunning ? (now - lapStartTime) : lapElapsedTime;
    const currentTotalTime = isRunning ? (now - startTime) : elapsedTime;

    lapStartTime = now;
    lapElapsedTime = 0;

    const lapNumber = laps.length + 1;
    const stepObj = (currentTemplate && currentTemplate.steps.length > 0)
        ? currentTemplate.steps[currentStepIndex % currentTemplate.steps.length]
        : { name: `Lap ${lapNumber}`, type: null };

    const lapData = {
        lapNum: lapNumber,
        lapDurationMs: currentLapDuration,
        totalTimeMs: currentTotalTime,
        formattedLap: fmtMs(currentLapDuration),
        formattedTotal: fmtMs(currentTotalTime),
        stepName: stepObj.name,
        stepType: stepObj.type,
        excluded: false,
        note: ''
    };
    laps.unshift(lapData);
    el.lapCounterTag.textContent = laps.length;
    if (currentTemplate) currentStepIndex = (currentStepIndex + 1) % currentTemplate.steps.length;

    renderLapsTable();
    updateStepLabel();
    if (window.lucide) lucide.createIcons();
    showToast(`Step ${lapNumber} (${lapData.stepName}) recorded: ${lapData.formattedLap}`, 'info');
}

function resetStopwatch() {
    pauseStopwatch();
    startTime = 0; elapsedTime = 0; lapStartTime = 0; lapElapsedTime = 0;
    laps = []; currentStepIndex = 0;
    paintTimer(0);
    if (el.currentLapDisplay) el.currentLapDisplay.textContent = '00:00:00.000';
    el.lapCounterTag.textContent = '0';

    el.startPauseBtn.innerHTML = `<i data-lucide="play" class="w-5 h-5 fill-current"></i><span>Start</span>`;
    el.startPauseBtn.className = "flex-1 min-w-[130px] py-3.5 px-6 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white transition-all shadow-lg glow-indigo";
    el.lapBtn.disabled = true;
    el.resetBtn.disabled = true;
    el.saveBtn.disabled = true;

    el.sessionStatusTag.textContent = "Ready";
    el.sessionStatusTag.className = "text-xs font-mono text-slate-500 font-normal";
    el.statusAccent.className = "absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-slate-700 via-indigo-500 to-slate-700 transition-all duration-300";
    updateRunningIndicator();
    renderLapsTable();
    updateStepLabel();
    if (window.lucide) lucide.createIcons();
}

/* =========================================================
   LAPS TABLE
   ========================================================= */
function renderLapsTable() {
    const tbody = el.lapsTableBody;
    if (!tbody) return;
    if (laps.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-10 text-center text-slate-500 italic font-sans">No steps recorded. Press <strong>Next Step</strong> to record a split.</td></tr>`;
        el.currentSessionStats.classList.add('hidden');
        renderLiveEstimator();
        return;
    }
    const included = laps.filter(l => !l.excluded);
    let fastestMs = Infinity, slowestMs = -1;
    included.forEach(l => { if (l.lapDurationMs < fastestMs) fastestMs = l.lapDurationMs; if (l.lapDurationMs > slowestMs) slowestMs = l.lapDurationMs; });

    tbody.innerHTML = laps.map(lap => {
        const isFast = included.length > 1 && lap.lapDurationMs === fastestMs && !lap.excluded;
        const isSlow = included.length > 1 && lap.lapDurationMs === slowestMs && !lap.excluded;
        const cls = lap.excluded ? 'text-slate-600 line-through' : isFast ? 'text-emerald-400 font-bold' : isSlow ? 'text-rose-400 font-bold' : 'text-slate-200';
        const tag = lap.excluded ? `<span class="ml-1 text-[10px] px-1 rounded bg-slate-800 text-slate-500">excl</span>` : isFast ? `<span class="ml-1 text-[10px] px-1 rounded bg-emerald-950 border border-emerald-800 text-emerald-400 font-sans">Fast</span>` : isSlow ? `<span class="ml-1 text-[10px] px-1 rounded bg-rose-950 border border-rose-800 text-rose-400 font-sans">Slow</span>` : '';
        const typeBadge = lap.stepType
            ? `<span class="ml-1 text-[9px] px-1 rounded ${lap.stepType === 'VA' ? 'bg-emerald-950 text-emerald-400 border border-emerald-900' : lap.stepType === 'NVAN' ? 'bg-amber-950 text-amber-400 border border-amber-900' : 'bg-rose-950 text-rose-400 border border-rose-900'}">${lap.stepType}</span>`
            : '';
        return `<tr class="hover:bg-slate-800/40 transition-colors">
            <td class="py-2 px-2 font-semibold text-slate-400">#${String(lap.lapNum).padStart(2, '0')}</td>
            <td class="py-2 px-2 text-slate-300">${escapeHtml(lap.stepName)}${typeBadge}</td>
            <td class="py-2 px-2 ${cls}">${lap.formattedLap}${tag}</td>
            <td class="py-2 px-2 text-right text-slate-400">${lap.formattedTotal}</td>
            <td class="py-2 px-2 text-center whitespace-nowrap">
                <button onclick="toggleLapExcluded(${lap.lapNum})" title="Toggle exclude" class="p-1 text-slate-500 hover:text-amber-400">${lap.excluded ? '↺' : '⊘'}</button>
            </td>
        </tr>`;
    }).join('');

    if (included.length > 0) {
        el.currentSessionStats.classList.remove('hidden');
        const sum = included.reduce((a, c) => a + c.lapDurationMs, 0);
        const avg = sum / included.length;
        document.getElementById('statFastest').textContent = fmtMs(Math.min(...included.map(l => l.lapDurationMs)));
        document.getElementById('statAverage').textContent = fmtMs(avg);
        document.getElementById('statSlowest').textContent = fmtMs(Math.max(...included.map(l => l.lapDurationMs)));
    }
    renderLiveEstimator();
}

function toggleLapExcluded(lapNum) {
    const lap = laps.find(l => l.lapNum === lapNum);
    if (!lap) return;
    lap.excluded = !lap.excluded;
    renderLapsTable();
    if (window.lucide) lucide.createIcons();
}

/* =========================================================
   TEMPLATE MENU
   ========================================================= */
const TEMPLATE_KEY = 'process_timer_templates';

function loadTemplates() {
    try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY)) || []; } catch { return []; }
}
function saveTemplates(list) {
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(list)); } catch {}
}

function openTemplateMenu(event) {
    event.stopPropagation();
    closeTemplateMenu();
    const templates = loadTemplates();
    const menu = document.createElement('div');
    menu.id = 'templateMenu';
    menu.className = 'fixed z-50 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-2 text-xs text-slate-200';
    const items = templates.map((t, i) =>
        `<button data-t="${i}" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-left">
            <i data-lucide="layers" class="w-3.5 h-3.5 text-indigo-400"></i>
            <span class="flex-1">${escapeHtml(t.name)} <span class="text-slate-500">(${t.steps.length})</span></span>
            <span data-del="${i}" class="text-rose-400 hover:text-rose-300 px-1" title="Delete">✕</span>
        </button>`).join('');
    menu.innerHTML = `
        <div class="px-2 py-1 text-[10px] uppercase text-slate-500 font-semibold">Templates</div>
        ${items || '<div class="px-3 py-2 text-slate-500 italic">No templates yet.</div>'}
        <hr class="my-1 border-slate-700">
        <button id="newTemplateBtn" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-left text-indigo-300">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i> New template...
        </button>`;
    document.body.appendChild(menu);
    const r = event.currentTarget.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 296, r.left)) + 'px';
    menu.style.top = (r.bottom + 6) + 'px';

    menu.addEventListener('click', (ev) => {
        const del = ev.target.closest('[data-del]');
        if (del) {
            ev.stopPropagation();
            const i = +del.dataset.del;
            const list = loadTemplates();
            list.splice(i, 1);
            saveTemplates(list);
            closeTemplateMenu();
            openTemplateMenu({ stopPropagation: () => {}, currentTarget: event.currentTarget });
            return;
        }
        const btn = ev.target.closest('button[data-t]');
        if (btn) {
            const t = templates[+btn.dataset.t];
            currentTemplate = t;
            currentStepIndex = 0;
            updateStepLabel();
            closeTemplateMenu();
            showToast(`Template "${t.name}" applied`, 'success');
            return;
        }
        if (ev.target.closest('#newTemplateBtn')) {
            closeTemplateMenu();
            createNewTemplate();
        }
    });
    setTimeout(() => {
        document.addEventListener('click', closeTemplateMenu);
        if (window.lucide) lucide.createIcons();
    }, 0);
}
function closeTemplateMenu() {
    const m = document.getElementById('templateMenu');
    if (m) m.remove();
    document.removeEventListener('click', closeTemplateMenu);
}
function clearTemplate() {
    currentTemplate = null;
    currentStepIndex = 0;
    updateStepLabel();
    showToast('Template cleared', 'info');
}
function createNewTemplate() {
    const name = prompt('Template name (e.g. "CNC cycle"):', 'My process');
    if (!name) return;
    const raw = prompt('Steps separated by comma, optionally with type like "Load:VA, Machine:NVAN, Unload:NVA":', 'Load:VA, Machine:NVAN, Unload:NVA');
    if (!raw) return;
    const steps = raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const [n, t] = s.split(':').map(x => x.trim());
        const type = ['VA', 'NVAN', 'NVA'].includes((t || '').toUpperCase()) ? t.toUpperCase() : null;
        return { name: n || 'Step', type };
    });
    if (steps.length === 0) return;
    const list = loadTemplates();
    list.push({ name, steps });
    saveTemplates(list);
    currentTemplate = { name, steps };
    currentStepIndex = 0;
    updateStepLabel();
    showToast(`Template "${name}" saved and applied`, 'success');
}

/* =========================================================
   STORAGE
   ========================================================= */
function loadSessionsFromStorage() {
    try {
        const stored = localStorage.getItem('process_timer_records');
        savedSessions = stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error('load failed', e);
        savedSessions = [];
        showToast('Could not load saved records — storage may be corrupted.', 'error');
    }
}
function saveSessionsToStorage() {
    try { localStorage.setItem('process_timer_records', JSON.stringify(savedSessions)); }
    catch (e) { console.error(e); showToast('Failed to save to browser storage.', 'error'); }
}

/* =========================================================
   SAVE / DELETE
   ========================================================= */
function saveCurrentSession() {
    if (elapsedTime === 0) return;
    const name = (el.processName.value || '').trim() || `Process Session #${savedSessions.length + 1}`;
    const category = (el.processCategory.value || '').trim() || 'General';
    const recordDate = new Date();
    if (isRunning) pauseStopwatch();

    const record = {
        id: 'proc_' + Date.now(),
        name, category,
        timestamp: recordDate.toISOString(),
        formattedDate: recordDate.toLocaleString(),
        totalDurationMs: elapsedTime,
        formattedTotalDuration: fmtMs(elapsedTime),
        laps: laps.map(l => ({ ...l })),
        meta: {},
        study: { performanceRating: 1.0, allowancesPct: 12, basis: 'observed' },
        oee: null
    };
    savedSessions.unshift(record);
    saveSessionsToStorage();
    renderSavedRecords();
    refreshStudyAndCompareSelectors();
    showToast(`Session "${name}" saved`, 'success');
    openRecordDetail(record.id);
}

function deleteRecord(id) {
    if (!confirm('Delete this recorded session?')) return;
    savedSessions = savedSessions.filter(s => s.id !== id);
    expandedIds.delete(id);
    saveSessionsToStorage();
    renderSavedRecords();
    refreshStudyAndCompareSelectors();
    showToast('Record deleted', 'info');
}
function clearAllHistory() {
    if (savedSessions.length === 0) return;
    if (!confirm('Delete ALL saved records? This cannot be undone.')) return;
    savedSessions = [];
    expandedIds.clear();
    saveSessionsToStorage();
    renderSavedRecords();
    refreshStudyAndCompareSelectors();
    showToast('All records cleared', 'info');
}

/* =========================================================
   STATISTICS
   ========================================================= */
function computeStats(lapArr, totalMs) {
    const included = (lapArr || []).filter(l => !l.excluded);
    const d = included.map(l => l.lapDurationMs);
    if (d.length === 0) {
        return { n: 0, excludedN: (lapArr || []).length, basisIsTotal: true, avg: totalMs, min: totalMs, max: totalMs, std: 0, cv: 0, included: [] };
    }
    const n = d.length;
    const avg = d.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? d.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1) : 0;
    const std = Math.sqrt(variance);
    return { n, excludedN: (lapArr || []).length - n, basisIsTotal: false, avg, min: Math.min(...d), max: Math.max(...d), std, cv: avg > 0 ? (std / avg) * 100 : 0, included };
}

/* =========================================================
   TABS
   ========================================================= */
const TAB_BASE = 'tab-btn flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ';
const TAB_ON = 'text-white border-indigo-500';
const TAB_OFF = 'text-slate-400 border-transparent hover:text-slate-200';

function applyTabStyles() {
    const map = {
        timer:   ['tabTimerBtn', 'viewTimer'],
        records: ['tabRecordsBtn', 'viewRecords'],
        study:   ['tabStudyBtn', 'viewStudy'],
        compare: ['tabCompareBtn', 'viewCompare']
    };
    Object.entries(map).forEach(([key, [btnId, viewId]]) => {
        const btn = document.getElementById(btnId);
        const view = document.getElementById(viewId);
        if (btn) btn.className = TAB_BASE + (activeView === key ? TAB_ON : TAB_OFF);
        if (view) view.classList.toggle('hidden', activeView !== key);
    });
    updateRunningIndicator();
    if (window.lucide) lucide.createIcons();
}
function setTab(name) {
    activeView = name;
    applyTabStyles();
    if (name === 'records') renderRecordsView();
    if (name === 'study') renderStudyView();
    if (name === 'compare') renderCompareView();
    window.scrollTo({ top: 0 });
}
function updateRunningIndicator() {
    const dot = document.getElementById('tabRunningDot');
    if (dot) dot.classList.toggle('hidden', !isRunning);
}

/* =========================================================
   SAVED RECORDS LIST (side panel)
   ========================================================= */
function renderSavedRecords() {
    const listEl = document.getElementById('savedRecordsList');
    if (!listEl) return;
    const searchVal = (document.getElementById('searchRecordsInput')?.value || '').toLowerCase();
    const filtered = savedSessions.filter(s =>
        s.name.toLowerCase().includes(searchVal) ||
        (s.category || '').toLowerCase().includes(searchVal));
    const badge = document.getElementById('recordsCountBadge');
    if (badge) badge.textContent = savedSessions.length;
    const tabBadge = document.getElementById('tabRecordsCount');
    if (tabBadge) tabBadge.textContent = savedSessions.length;

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="text-center py-12 text-slate-500 font-sans">
            <i data-lucide="folder-open" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
            <p class="text-xs">${savedSessions.length === 0 ? 'No saved sessions yet.' : 'No matching records.'}</p>
        </div>`;
        if (window.lucide) lucide.createIcons();
        return;
    }
    listEl.innerHTML = filtered.map(s => `
        <div class="bg-slate-950/70 border border-slate-800/80 hover:border-slate-700 rounded-xl p-3.5 transition-all">
            <div class="flex items-start justify-between gap-2">
                <div class="flex-1 min-w-0">
                    <h3 class="font-semibold text-xs sm:text-sm text-slate-100 truncate">${escapeHtml(s.name)}</h3>
                    <p class="text-[11px] text-slate-500 font-mono mt-0.5">${escapeHtml(s.formattedDate)}</p>
                    ${s.category ? `<span class="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-950 border border-indigo-800/80 text-indigo-300">${escapeHtml(s.category)}</span>` : ''}
                </div>
                <div class="flex items-center gap-1">
                    <button onclick="openRecordDetail('${s.id}')" title="View details" class="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-slate-800 rounded-lg"><i data-lucide="bar-chart-3" class="w-3.5 h-3.5"></i></button>
                    <button onclick="openExportMenu(event, '${s.id}')" title="Export" class="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-slate-800 rounded-lg"><i data-lucide="download" class="w-3.5 h-3.5"></i></button>
                    <button onclick="deleteRecord('${s.id}')" title="Delete" class="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded-lg"><i data-lucide="trash" class="w-3.5 h-3.5"></i></button>
                </div>
            </div>
            <div class="mt-3 flex items-center justify-between pt-2 border-t border-slate-800/60 font-mono text-xs">
                <span class="text-slate-200 font-bold">${s.formattedTotalDuration}</span>
                <span class="text-slate-500 text-[11px]">Laps: <span class="text-slate-300">${s.laps.length}</span></span>
            </div>
        </div>`).join('');
    if (window.lucide) lucide.createIcons();
}

/* =========================================================
   RECORDS & ANALYSIS VIEW
   ========================================================= */
function cvBadge(cv) {
    if (cv < 10) return ['Stable', 'text-emerald-400'];
    if (cv < 20) return ['Moderate', 'text-amber-400'];
    return ['Variable', 'text-rose-400'];
}
function renderRecordsView() {
    const listEl = document.getElementById('recordsAnalysisList');
    if (!listEl) return;
    const q = (document.getElementById('recordsViewSearch')?.value || '').toLowerCase();
    const sort = document.getElementById('recordsViewSort')?.value || 'newest';
    const time = s => new Date(s.timestamp).getTime() || 0;
    const sorters = {
        newest: (a, b) => time(b) - time(a),
        oldest: (a, b) => time(a) - time(b),
        name: (a, b) => a.name.localeCompare(b.name),
        longest: (a, b) => b.totalDurationMs - a.totalDurationMs,
        fastest: (a, b) => computeStats(a.laps, a.totalDurationMs).avg - computeStats(b.laps, b.totalDurationMs).avg
    };
    const filtered = savedSessions.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.category || '').toLowerCase().includes(q) ||
        Object.values(s.meta || {}).some(v => String(v).toLowerCase().includes(q)));
    const list = filtered.sort(sorters[sort] || sorters.newest);
    const shown = document.getElementById('recordsViewShown');
    if (shown) shown.textContent = savedSessions.length ? `${list.length} of ${savedSessions.length}` : '';

    if (list.length === 0) {
        listEl.innerHTML = `<div class="text-center py-16 text-slate-500">
            <i data-lucide="folder-open" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
            <p class="text-xs">${savedSessions.length === 0 ? 'No saved sessions yet.' : 'No matching records.'}</p>
        </div>`;
        if (window.lucide) lucide.createIcons();
        return;
    }
    listEl.innerHTML = list.map(s => {
        const st = computeStats(s.laps, s.totalDurationMs);
        const open = expandedIds.has(s.id);
        return `<div id="rec-${s.id}" class="bg-slate-950/70 border ${open ? 'border-indigo-800/70' : 'border-slate-800/80'} rounded-xl scroll-mt-32">
            <button onclick="toggleRecord('${s.id}')" aria-expanded="${open}" class="w-full flex items-center gap-3 p-3.5 text-left hover:bg-slate-800/30 rounded-xl">
                <i data-lucide="${open ? 'chevron-down' : 'chevron-right'}" class="w-4 h-4 text-slate-400 shrink-0"></i>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h3 class="font-semibold text-sm text-slate-100 truncate">${escapeHtml(s.name)}</h3>
                        ${s.category ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950 border border-indigo-800/80 text-indigo-300">${escapeHtml(s.category)}</span>` : ''}
                    </div>
                    <p class="text-[11px] text-slate-500 font-mono mt-0.5">${escapeHtml(s.formattedDate)}</p>
                </div>
                <div class="text-right font-mono shrink-0">
                    <div class="text-sm font-bold text-slate-100">${s.formattedTotalDuration}</div>
                    <div class="text-[11px] text-slate-500">${st.n} lap${st.n === 1 ? '' : 's'}${st.n > 0 ? ' &middot; avg ' + fmtMs(st.avg) : ''}</div>
                </div>
            </button>
            ${open ? recordDetailHTML(s, st) : ''}
        </div>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
}

function toggleRecord(id) {
    if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
    renderRecordsView();
}
function openRecordDetail(id) {
    const s = savedSessions.find(x => x.id === id);
    if (!s) return;
    const st = computeStats(s.laps, s.totalDurationMs);
    const sheet = document.getElementById('detailSheet');
    const content = document.getElementById('detailSheetContent');
    if (!sheet || !content) return;
    content.innerHTML = `
        <div class="p-5 border-b border-slate-800 flex items-start justify-between gap-3 sticky top-0 bg-slate-900 z-10">
            <div class="min-w-0">
                <h2 class="font-bold text-base text-white truncate">${escapeHtml(s.name)}</h2>
                <p class="text-[11px] text-slate-500 font-mono">${escapeHtml(s.formattedDate)}${s.category ? ' • ' + escapeHtml(s.category) : ''}</p>
            </div>
            <button onclick="closeDetailSheet()" class="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        ${recordDetailHTML(s, st, true)}
        <div class="p-4 border-t border-slate-800 flex justify-end gap-2">
            <button onclick="openExportMenu(event, '${s.id}')" class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5"><i data-lucide="download" class="w-3.5 h-3.5 text-indigo-400"></i> Export</button>
            <button onclick="closeDetailSheet()" class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white">Close</button>
        </div>`;
    sheet.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}
function closeDetailSheet() {
    document.getElementById('detailSheet')?.classList.add('hidden');
}

function recordDetailHTML(s, st, inSheet) {
    const chrono = (s.laps || []).slice().reverse();
    let statsBlock;
    if (st.n === 0) {
        statsBlock = `<p class="text-xs text-slate-400">No laps recorded. Total: <span class="font-mono text-slate-200">${s.formattedTotalDuration}</span>.</p>`;
    } else {
        const [cvLabel, cvColor] = cvBadge(st.cv);
        statsBlock = `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${tile('Total', s.formattedTotalDuration, 'text-slate-100')}
            ${tile('Laps', st.n + (st.excludedN ? ` (${st.excludedN} excl)` : ''), 'text-slate-100')}
            ${tile('Fastest', fmtMs(st.min), 'text-emerald-400')}
            ${tile('Average', fmtMs(st.avg), 'text-indigo-300')}
            ${tile('Slowest', fmtMs(st.max), 'text-rose-400')}
            ${tile('Std dev', st.n > 1 ? fmtSec(st.std) : '--', 'text-slate-200')}
            ${tile('CV', st.n > 1 ? st.cv.toFixed(1) + '%' : '--', cvColor, cvLabel)}
        </div>`;
    }
    const tableBlock = chrono.length === 0 ? '' : `
        <div>
            <h4 class="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">All laps</h4>
            <div class="overflow-auto max-h-72 border border-slate-800/70 rounded-lg">
                <table class="w-full text-left text-xs font-mono">
                    <thead class="sticky top-0 bg-slate-900 text-slate-400 text-[10px] uppercase">
                        <tr><th class="py-2 px-3">#</th><th class="py-2 px-3">Step</th><th class="py-2 px-3">Duration</th><th class="py-2 px-3 hidden sm:table-cell">Cumulative</th><th class="py-2 px-3 text-right">vs avg</th></tr>
                    </thead>
                    <tbody class="divide-y divide-slate-800/60">
                        ${chrono.map(l => {
                            const diff = l.lapDurationMs - st.avg;
                            const sign = diff >= 0 ? '+' : '-';
                            const pct = st.avg > 0 ? Math.abs(diff) / st.avg * 100 : 0;
                            const cls = l.excluded ? 'text-slate-600 line-through' : 'text-slate-200';
                            return `<tr class="hover:bg-slate-800/40">
                                <td class="py-1.5 px-3 text-slate-400">#${String(l.lapNum).padStart(2,'0')}</td>
                                <td class="py-1.5 px-3 ${cls}">${escapeHtml(l.stepName || '')}${l.stepType ? ` <span class="text-[9px] px-1 rounded bg-slate-800 text-slate-400">${l.stepType}</span>` : ''}</td>
                                <td class="py-1.5 px-3 ${cls}">${l.formattedLap}</td>
                                <td class="py-1.5 px-3 text-slate-400 hidden sm:table-cell">${l.formattedTotal}</td>
                                <td class="py-1.5 px-3 text-right ${diff > 0 ? 'text-rose-300' : 'text-emerald-300'}">${sign}${(Math.abs(diff)/1000).toFixed(3)}s</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
    const actions = inSheet ? '' : `<div class="flex items-center gap-2 pt-1">
        <button onclick="openExportMenu(event, '${s.id}')" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"><i data-lucide="download" class="w-3.5 h-3.5 text-indigo-400"></i> Export</button>
        <button onclick="deleteRecord('${s.id}')" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700"><i data-lucide="trash" class="w-3.5 h-3.5"></i> Delete</button>
    </div>`;
    return `<div class="px-3.5 pb-4 pt-3 space-y-4 ${inSheet ? 'p-4' : 'border-t border-slate-800/70'}">
        ${statsBlock}
        ${tableBlock}
        ${actions}
    </div>`;
}
function tile(label, value, color, sub) {
    return `<div class="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/50 text-center">
        <div class="text-slate-500 text-[10px] uppercase">${label}</div>
        <div class="font-mono ${color} font-semibold mt-0.5 text-sm">${value}</div>
        ${sub ? `<div class="text-[10px] ${color} mt-0.5">${sub}</div>` : ''}
    </div>`;
}

/* =========================================================
   LIVE ESTIMATOR (TTD)
   ========================================================= */
const TTD_KEY = 'process_timer_ttd';
function loadTTD() {
    try { const v = JSON.parse(localStorage.getItem(TTD_KEY)); if (v && isFinite(v.h) && isFinite(v.m)) return v; } catch {}
    return { h: 8, m: 0 };
}
function saveTTD(h, m) {
    try { localStorage.setItem(TTD_KEY, JSON.stringify({ h, m })); } catch {}
}
function renderLiveEstimator() {
    const card = document.getElementById('liveEstimatorCard');
    if (!card) return;
    const included = laps.filter(l => !l.excluded);
    if (included.length === 0) { card.classList.add('hidden'); card.innerHTML = ''; return; }
    card.classList.remove('hidden');
    const st = computeStats(laps, elapsedTime);
    card.innerHTML = estimatorHTML('live', st);
    updateEstimate('live', st);
    if (window.lucide) lucide.createIcons();
}
function estimatorHTML(key, st) {
    const t = loadTTD();
    const presets = [[30, '30m'], [60, '1h'], [240, '4h'], [480, '8h'], [600, '10h'], [720, '12h']];
    const inputCls = 'w-20 bg-slate-950/80 border border-slate-800 focus:border-indigo-500 rounded-lg px-3 py-1.5 text-sm text-slate-100 outline-none font-mono';
    return `<div class="rounded-xl border border-indigo-900/60 bg-indigo-950/20 p-4 shadow-xl">
        <div class="flex items-center gap-2 mb-1">
            <i data-lucide="calculator" class="w-4 h-4 text-indigo-400"></i>
            <h3 class="font-semibold text-sm text-slate-200">Piece estimator</h3>
        </div>
        <p class="text-[11px] text-slate-400 mb-3">Pieces = available time ÷ cycle time.</p>
        <div class="flex flex-wrap items-end gap-3">
            <label class="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Hours<input type="number" min="0" step="any" id="est-h-${key}" value="${t.h}" oninput="updateEstimate('${key}')" class="${inputCls} block mt-1"></label>
            <label class="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Minutes<input type="number" min="0" step="any" id="est-m-${key}" value="${t.m}" oninput="updateEstimate('${key}')" class="${inputCls} block mt-1"></label>
            <div class="flex flex-wrap gap-1.5 pb-0.5">${presets.map(([mins,label]) => `<button type="button" onclick="setEstimatePreset('${key}', ${mins})" class="px-2 py-1 text-[11px] rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700">${label}</button>`).join('')}</div>
        </div>
        <div id="est-out-${key}" class="mt-4"></div>
    </div>`;
}
function setEstimatePreset(key, totalMin) {
    const h = document.getElementById('est-h-' + key);
    const m = document.getElementById('est-m-' + key);
    if (h) h.value = Math.floor(totalMin / 60);
    if (m) m.value = totalMin % 60;
    updateEstimate(key);
}
function updateEstimate(key, st) {
    const hEl = document.getElementById('est-h-' + key);
    const mEl = document.getElementById('est-m-' + key);
    const out = document.getElementById('est-out-' + key);
    if (!hEl || !mEl || !out) return;
    const h = Math.max(0, parseFloat(hEl.value) || 0);
    const m = Math.max(0, parseFloat(mEl.value) || 0);
    saveTTD(h, m);
    st = st || getStatsForKey(key);
    out.innerHTML = st ? estimateResultHTML(st, (h * 60 + m) * 60000) : '';
}
function getStatsForKey(key) {
    if (key === 'live') return laps.length ? computeStats(laps, elapsedTime) : null;
    const s = savedSessions.find(x => x.id === key);
    return s ? computeStats(s.laps, s.totalDurationMs) : null;
}
function estimateResultHTML(st, availMs) {
    if (availMs <= 0) return '<p class="text-xs text-slate-500 italic">Enter available time.</p>';
    if (!(st.avg > 0)) return '<p class="text-xs text-slate-500 italic">Cycle time is zero.</p>';
    const calc = c => ({ pcs: Math.floor(availMs / c), perHour: 3600000 / c, leftover: availMs - Math.floor(availMs / c) * c });
    const exp = calc(st.avg);
    const totalMin = Math.round(availMs / 60000);
    const availLabel = `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
    return `<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="bg-slate-950/60 border border-slate-800/60 rounded-xl p-3 text-center">
            <div class="text-[10px] uppercase text-slate-500">Expected pieces in ${availLabel}</div>
            <div class="font-mono text-4xl font-bold text-indigo-300 mt-1">${exp.pcs.toLocaleString()}</div>
            <div class="text-[11px] text-slate-400 mt-1">≈ ${exp.perHour.toFixed(1)} / hour</div>
        </div>
        <div class="sm:col-span-2 bg-slate-950/60 border border-slate-800/60 rounded-xl p-3 overflow-x-auto">
            <table class="w-full text-xs font-mono">
                <thead class="text-slate-500 text-[10px] uppercase"><tr><th class="text-left py-1 pr-2">Scenario</th><th class="text-left py-1 pr-2">Cycle</th><th class="text-right py-1 pr-2">Pieces</th></tr></thead>
                <tbody class="divide-y divide-slate-800/60">
                    ${st.n > 1 ? `<tr><td class="py-1.5 pr-2 text-emerald-400">Best</td><td class="py-1.5 pr-2">${fmtMs(st.min)}</td><td class="py-1.5 text-right font-bold text-emerald-400">${calc(st.min).pcs.toLocaleString()}</td></tr>
                        <tr><td class="py-1.5 pr-2 text-indigo-300">Expected</td><td class="py-1.5 pr-2">${fmtMs(st.avg)}</td><td class="py-1.5 text-right font-bold text-indigo-300">${exp.pcs.toLocaleString()}</td></tr>
                        <tr><td class="py-1.5 pr-2 text-rose-400">Worst</td><td class="py-1.5 pr-2">${fmtMs(st.max)}</td><td class="py-1.5 text-right font-bold text-rose-400">${calc(st.max).pcs.toLocaleString()}</td></tr>`
                    : `<tr><td class="py-1.5 pr-2 text-indigo-300" colspan="2">${st.basisIsTotal ? 'Total (no laps)' : 'Single lap'}</td><td class="py-1.5 text-right font-bold text-indigo-300">${exp.pcs.toLocaleString()}</td></tr>`}
                </tbody>
            </table>
        </div>
    </div>
    <p class="text-[11px] text-slate-500 mt-3">Leftover at expected rate: <span class="font-mono text-slate-300">${fmtMs(exp.leftover)}</span>. Assumes no breaks/downtime.${st.basisIsTotal ? ' <span class="text-amber-400">No laps recorded — total treated as one piece.</span>' : ''}</p>`;
}

/* =========================================================
   STUDY VIEW — Standard time, Takt, OEE
   ========================================================= */
function refreshStudyAndCompareSelectors() {
    const studySel = document.getElementById('studyRecordSelect');
    const aSel = document.getElementById('compareA');
    const bSel = document.getElementById('compareB');
    const opts = savedSessions.map(s => `<option value="${s.id}">${escapeHtml(s.name)} — ${s.formattedDate}</option>`).join('');
    if (studySel) {
        const cur = studySel.value;
        studySel.innerHTML = opts || '<option value="">No records yet</option>';
        if (cur && savedSessions.find(s => s.id === cur)) studySel.value = cur;
    }
    [aSel, bSel].forEach(sel => {
        if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = opts || '<option value="">No records yet</option>';
        if (cur && savedSessions.find(s => s.id === cur)) sel.value = cur;
    });
    if (aSel && !aSel.value && savedSessions[0]) aSel.value = savedSessions[0].id;
    if (bSel && !bSel.value && savedSessions[1]) bSel.value = savedSessions[1].id;
    else if (bSel && !bSel.value && savedSessions[0]) bSel.value = savedSessions[0].id;
}
function initTaktAndOEE() {
    refreshStudyAndCompareSelectors();
    renderTaktContent();
    renderOEEContent();
}
function currentStudyRecord() {
    const sel = document.getElementById('studyRecordSelect');
    return savedSessions.find(s => s.id === sel.value) || null;
}
function renderStudyView() {
    refreshStudyAndCompareSelectors();
    const container = document.getElementById('studyContent');
    if (!container) return;
    const s = currentStudyRecord();
    if (!s) {
        container.innerHTML = '<p class="text-xs text-slate-500 italic">Save a record first, then come back to run the standard-time study.</p>';
        return;
    }
    const st = computeStats(s.laps, s.totalDurationMs);
    const study = s.study || { performanceRating: 1.0, allowancesPct: 12, basis: 'observed' };
    const observed = st.avg;
    const normal = observed * study.performanceRating;
    const standard = normal * (1 + study.allowancesPct / 100);
    container.innerHTML = `
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <label class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">Performance rating (0.8–1.2)
                <input type="number" step="0.01" min="0.5" max="1.5" id="studyPR" value="${study.performanceRating}"
                       oninput="updateStudy('${s.id}', 'performanceRating', this.value)"
                       class="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 font-mono text-slate-100">
            </label>
            <label class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">Allowances (% of normal)
                <input type="number" step="0.1" min="0" max="100" id="studyAllow" value="${study.allowancesPct}"
                       oninput="updateStudy('${s.id}', 'allowancesPct', this.value)"
                       class="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 font-mono text-slate-100">
            </label>
            <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
                <div class="text-[10px] uppercase text-slate-500">Basis</div>
                <div class="mt-1 text-slate-200 font-mono">${st.n} laps</div>
                <div class="text-[11px] text-slate-500">${st.excludedN} excluded</div>
            </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            ${tile('Observed (avg)', fmtMs(observed), 'text-slate-200')}
            ${tile('Normal (observed × PR)', fmtMs(normal), 'text-indigo-300')}
            ${tile('Standard (normal + allowance)', fmtMs(standard), 'text-emerald-400')}
        </div>
        <div class="text-[11px] text-slate-500">Standard time = observed × PR × (1 + allowances%). Use this as the basis for planning and takt.</div>`;
    if (window.lucide) lucide.createIcons();
}
function updateStudy(sessionId, field, value) {
    const s = savedSessions.find(x => x.id === sessionId);
    if (!s) return;
    s.study = s.study || { performanceRating: 1.0, allowancesPct: 12, basis: 'observed' };
    s.study[field] = parseFloat(value) || 0;
    saveSessionsToStorage();
    renderStudyView();
}

/* Takt time */
const TAKT_KEY = 'process_timer_takt';
function loadTakt() {
    try { const v = JSON.parse(localStorage.getItem(TAKT_KEY)); if (v) return v; } catch {}
    return { shiftHours: 8, breaksMin: 30, demand: 100 };
}
function saveTakt(v) { try { localStorage.setItem(TAKT_KEY, JSON.stringify(v)); } catch {} }
function renderTaktContent() {
    const c = document.getElementById('taktContent');
    if (!c) return;
    const t = loadTakt();
    const s = currentStudyRecord();
    let cycle = 0, standard = 0;
    if (s) {
        const st = computeStats(s.laps, s.totalDurationMs);
        const study = s.study || { performanceRating: 1.0, allowancesPct: 12 };
        cycle = st.avg;
        standard = cycle * study.performanceRating * (1 + study.allowancesPct / 100);
    }
    const availMin = t.shiftHours * 60 - t.breaksMin;
    const taktMs = t.demand > 0 ? (availMin * 60000) / t.demand : 0;
    const meetsObserved = cycle > 0 && taktMs > 0 && cycle <= taktMs;
    const meetsStandard = standard > 0 && taktMs > 0 && standard <= taktMs;
    const stations = cycle > 0 && taktMs > 0 ? Math.ceil(cycle / taktMs) : 0;
    c.innerHTML = `
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs mb-3">
            <label class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">Shift (hours)
                <input type="number" step="0.5" min="0" id="taktShift" value="${t.shiftHours}" oninput="updateTakt('shiftHours', this.value)"
                       class="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 font-mono text-slate-100">
            </label>
            <label class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">Breaks / planned downtime (min)
                <input type="number" step="5" min="0" id="taktBreaks" value="${t.breaksMin}" oninput="updateTakt('breaksMin', this.value)"
                       class="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 font-mono text-slate-100">
            </label>
            <label class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">Customer demand (pieces / shift)
                <input type="number" step="1" min="0" id="taktDemand" value="${t.demand}" oninput="updateTakt('demand', this.value)"
                       class="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 font-mono text-slate-100">
            </label>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${tile('Available time', `${availMin} min`, 'text-slate-200')}
            ${tile('Takt time', fmtMs(taktMs), 'text-indigo-300')}
            ${tile('Observed cycle', cycle ? fmtMs(cycle) : '--', meetsObserved ? 'text-emerald-400' : 'text-rose-400', meetsObserved ? 'Meets' : 'Misses')}
            ${tile('Standard cycle', standard ? fmtMs(standard) : '--', meetsStandard ? 'text-emerald-400' : 'text-rose-400', meetsStandard ? 'Meets' : 'Misses')}
        </div>
        <p class="text-[11px] text-slate-500 mt-3">Stations needed ≈ <span class="font-mono text-slate-200">${stations || '--'}</span> (upper bound, un-balanced). Takt &lt; cycle means you cannot meet demand with the current process.</p>`;
    if (window.lucide) lucide.createIcons();
}
function updateTakt(field, value) {
    const t = loadTakt();
    t[field] = parseFloat(value) || 0;
    saveTakt(t);
    renderTaktContent();
}

/* OEE */
function renderOEEContent() {
    const c = document.getElementById('oeeContent');
    if (!c) return;
    const s = currentStudyRecord();
    if (!s) { c.innerHTML = '<p class="text-xs text-slate-500 italic">Select a record in the Study panel above.</p>'; return; }
    const st = computeStats(s.laps, s.totalDurationMs);
    const oee = s.oee || { plannedMin: 480, runMin: 450, totalCount: 0, goodCount: 0 };
    const planned = oee.plannedMin;
    const run = Math.min(oee.runMin, planned);
    const total = oee.totalCount;
    const good = Math.min(oee.goodCount, total);
    const idealCycle = st.avg || 1;
    const availability = planned > 0 ? run / planned : 0;
    const performance = run > 0 ? (idealCycle * total) / (run * 60000) : 0;
    const quality = total > 0 ? good / total : 0;
    const oeeVal = availability * performance * quality * 100;
    c.innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
            <label class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">Planned production (min)
                <input type="number" min="0" id="oeePlanned" value="${planned}" oninput="updateOEE('plannedMin', this.value)" class="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 font-mono text-slate-100">
            </label>
            <label class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">Actual run (min)
                <input type="number" min="0" id="oeeRun" value="${run}" oninput="updateOEE('runMin', this.value)" class="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 font-mono text-slate-100">
            </label>
            <label class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">Total count
                <input type="number" min="0" id="oeeTotal" value="${total}" oninput="updateOEE('totalCount', this.value)" class="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 font-mono text-slate-100">
            </label>
            <label class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">Good count
                <input type="number" min="0" id="oeeGood" value="${good}" oninput="updateOEE('goodCount', this.value)" class="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 font-mono text-slate-100">
            </label>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${tile('Availability', (availability*100).toFixed(1) + '%', 'text-slate-200')}
            ${tile('Performance', (performance*100).toFixed(1) + '%', 'text-slate-200')}
            ${tile('Quality', (quality*100).toFixed(1) + '%', 'text-slate-200')}
            ${tile('OEE', oeeVal.toFixed(1) + '%', oeeVal > 60 ? 'text-emerald-400' : oeeVal > 40 ? 'text-amber-400' : 'text-rose-400')}
        </div>
        <p class="text-[11px] text-slate-500 mt-3">Realistic good pieces per shift ≈ <span class="font-mono text-slate-200">${Math.floor((planned * 60000 / idealCycle) * availability * quality).toLocaleString()}</span> (using observed cycle as ideal).</p>`;
    if (window.lucide) lucide.createIcons();
}
function updateOEE(field, value) {
    const s = currentStudyRecord();
    if (!s) return;
    s.oee = s.oee || { plannedMin: 480, runMin: 450, totalCount: 0, goodCount: 0 };
    s.oee[field] = parseFloat(value) || 0;
    saveSessionsToStorage();
    renderOEEContent();
}

/* =========================================================
   COMPARE VIEW
   ========================================================= */
function renderCompareView() {
    refreshStudyAndCompareSelectors();
    const aSel = document.getElementById('compareA');
    const bSel = document.getElementById('compareB');
    const c = document.getElementById('compareContent');
    if (!c) return;
    const a = savedSessions.find(s => s.id === aSel.value);
    const b = savedSessions.find(s => s.id === bSel.value);
    if (!a || !b) { c.innerHTML = '<p class="text-xs text-slate-500 italic">Need at least two records.</p>'; return; }
    const sa = computeStats(a.laps, a.totalDurationMs);
    const sb = computeStats(b.laps, b.totalDurationMs);
    const diff = sa.avg - sb.avg;
    const pct = sb.avg > 0 ? (diff / sb.avg) * 100 : 0;
    const diffCls = diff > 0 ? 'text-rose-400' : diff < 0 ? 'text-emerald-400' : 'text-slate-300';
    c.innerHTML = `
        <div class="grid grid-cols-2 gap-3 mb-3">
            <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
                <div class="text-[10px] uppercase text-slate-500">A: ${escapeHtml(a.name)}</div>
                <div class="mt-1 font-mono text-sm text-slate-200">avg ${fmtMs(sa.avg)}</div>
                <div class="text-[11px] text-slate-500">n=${sa.n} total ${a.formattedTotalDuration}</div>
            </div>
            <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
                <div class="text-[10px] uppercase text-slate-500">B: ${escapeHtml(b.name)}</div>
                <div class="mt-1 font-mono text-sm text-slate-200">avg ${fmtMs(sb.avg)}</div>
                <div class="text-[11px] text-slate-500">n=${sb.n} total ${b.formattedTotalDuration}</div>
            </div>
        </div>
        <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-3 text-center">
            <div class="text-[10px] uppercase text-slate-500">A vs B (avg difference)</div>
            <div class="font-mono text-2xl font-bold ${diffCls} mt-1">${diff > 0 ? '+' : ''}${fmtMs(Math.abs(diff))} ${diff > 0 ? '(A slower)' : diff < 0 ? '(A faster)' : ''}</div>
            <div class="text-[11px] ${diffCls} mt-0.5">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</div>
        </div>`;
    if (window.lucide) lucide.createIcons();
}

/* =========================================================
   KEYBOARD SHORTCUTS
   ========================================================= */
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (activeView !== 'timer') return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
        if (e.code === 'Space') { e.preventDefault(); toggleStartPause(); }
        else if (e.code === 'KeyL') { e.preventDefault(); if (!el.lapBtn.disabled) recordLap(); }
        else if (e.code === 'KeyR') { e.preventDefault(); if (!el.resetBtn.disabled) resetStopwatch(); }
    });
}

/* =========================================================
   DEBOUNCE
   ========================================================= */
let _rsT, _rrT;
function debouncedRenderSaved() { clearTimeout(_rsT); _rsT = setTimeout(renderSavedRecords, 120); }
function debouncedRenderRecords() { clearTimeout(_rrT); _rrT = setTimeout(renderRecordsView, 120); }

/* =========================================================
   TOASTS
   ========================================================= */
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    let bgClass = 'bg-slate-800 border-slate-700 text-slate-100';
    let iconName = 'info';
    if (type === 'success') { bgClass = 'bg-emerald-950/90 border-emerald-800/80 text-emerald-200'; iconName = 'check-circle'; }
    else if (type === 'error') { bgClass = 'bg-rose-950/90 border-rose-800/80 text-rose-200'; iconName = 'alert-circle'; }
    toast.className = `pointer-events-auto px-4 py-2.5 rounded-xl border shadow-xl flex items-center gap-2.5 text-xs font-medium backdrop-blur-md transform transition-all duration-300 translate-y-2 opacity-0 ${bgClass}`;
    toast.innerHTML = `<i data-lucide="${iconName}" class="w-4 h-4 shrink-0"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    if (window.lucide) lucide.createIcons();
    setTimeout(() => toast.classList.remove('translate-y-2', 'opacity-0'), 10);
    setTimeout(() => { toast.classList.add('opacity-0', 'translate-y-2'); setTimeout(() => toast.remove(), 300); }, 3000);
}