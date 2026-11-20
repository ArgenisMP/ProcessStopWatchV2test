/* Process Timer Pro — app.js
   Core state, timer, cycle-aware templates, storage, stats, IE time-study math, and view rendering.
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
let laps = [];
let currentTemplate = null;
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
        currentCycleNum: document.getElementById('currentCycleNum'),
        cycleStatusWrap: document.getElementById('cycleStatusWrap'),
        cycleStatusDot: document.getElementById('cycleStatusDot'),
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
   MIGRATION
   ========================================================= */
function defaultEstimator() {
    return { ttdH: 8, ttdM: 0, performancePct: 100, allowancePct: 10, demandUnits: 0 };
}
function migrateRecord(s) {
    s.laps = (s.laps || []).map((l, i) => ({
        lapNum: l.lapNum ?? (i + 1),
        cycleNum: l.cycleNum ?? null,
        stepNumInCycle: l.stepNumInCycle ?? null,
        cycleComplete: l.cycleComplete === true,
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
    s.template = s.template || null;
    s.estimator = Object.assign(defaultEstimator(), s.estimator || {});
    return s;
}
function migrateAll() {
    savedSessions = savedSessions.map(migrateRecord);
}

/* =========================================================
   TIMER DISPLAY
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
   STOPWATCH
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
   STEPS / TEMPLATE & AUTOMATIC CYCLES
   ========================================================= */
function getActiveCycleInfo() {
    if (!currentTemplate || !currentTemplate.steps || currentTemplate.steps.length === 0) {
        return null;
    }
    const len = currentTemplate.steps.length;
    const stepIdx = currentStepIndex % len;
    const cycleNum = Math.floor(currentStepIndex / len) + 1;
    return {
        cycleNum,
        stepNumInCycle: stepIdx + 1,
        totalStepsInCycle: len,
        step: currentTemplate.steps[stepIdx],
        isLastStepInCycle: stepIdx === len - 1
    };
}

function updateStepLabel() {
    if (!el.currentStepName) return;
    const info = getActiveCycleInfo();
    if (info) {
        if (el.cycleStatusWrap) el.cycleStatusWrap.classList.remove('hidden');
        if (el.cycleStatusDot) el.cycleStatusDot.classList.remove('hidden');
        if (el.currentCycleNum) el.currentCycleNum.textContent = String(info.cycleNum);
        el.currentStepName.textContent = `(${info.stepNumInCycle}/${info.totalStepsInCycle}) ${info.step.name}`;
    } else {
        if (el.cycleStatusWrap) el.cycleStatusWrap.classList.add('hidden');
        if (el.cycleStatusDot) el.cycleStatusDot.classList.add('hidden');
        el.currentStepName.textContent = `Lap ${laps.length + 1}`;
    }
    if (el.currentTemplateLabel) {
        el.currentTemplateLabel.textContent = currentTemplate
            ? `${currentTemplate.name} (${currentTemplate.steps.length} steps/cycle)`
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
    const info = getActiveCycleInfo();
    const stepObj = info ? info.step : { name: `Lap ${lapNumber}`, type: null };

    const lapData = {
        lapNum: lapNumber,
        cycleNum: info ? info.cycleNum : null,
        stepNumInCycle: info ? info.stepNumInCycle : null,
        cycleComplete: info ? info.isLastStepInCycle : false,
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

    if (info) {
        currentStepIndex += 1; // Advances continuously so Cycle 1 -> Cycle 2 on step 1 rollover
    }

    renderLapsTable();
    updateStepLabel();
    if (window.lucide) lucide.createIcons();

    if (info && info.isLastStepInCycle) {
        const cycleLaps = laps.filter(l => l.cycleNum === info.cycleNum);
        const cycleTotalMs = cycleLaps.reduce((acc, l) => acc + l.lapDurationMs, 0);
        showToast(`Cycle ${info.cycleNum} closed (${fmtMs(cycleTotalMs)}) — Cycle ${info.cycleNum + 1} started`, 'success');
    } else if (info) {
        showToast(`C${info.cycleNum} • Step ${info.stepNumInCycle}/${info.totalStepsInCycle} (${lapData.stepName}): ${lapData.formattedLap}`, 'info');
    } else {
        showToast(`Step ${lapNumber} (${lapData.stepName}) recorded: ${lapData.formattedLap}`, 'info');
    }
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
        const cycleBadge = lap.cycleNum != null
            ? `<span class="mr-1.5 text-[10px] px-1.5 py-0.5 rounded ${lap.cycleComplete ? 'bg-indigo-900/80 text-indigo-200 border border-indigo-700' : 'bg-slate-800 text-slate-300 border border-slate-700'}">C${lap.cycleNum}</span>`
            : '';
        const typeBadge = lap.stepType
            ? `<span class="ml-1 text-[9px] px-1 rounded ${lap.stepType === 'VA' ? 'bg-emerald-950 text-emerald-400 border border-emerald-900' : lap.stepType === 'NVAN' ? 'bg-amber-950 text-amber-400 border border-amber-900' : 'bg-rose-950 text-rose-400 border border-rose-900'}">${lap.stepType}</span>`
            : '';
        const cycleEndNote = lap.cycleComplete ? `<span class="ml-1 text-[9px] text-indigo-400 font-sans">✓ Cycle ${lap.cycleNum} end</span>` : '';
        return `<tr class="${lap.cycleComplete ? 'border-t-2 border-indigo-500/40' : ''} hover:bg-slate-800/40 transition-colors">
            <td class="py-2 px-2 font-semibold text-slate-400">#${String(lap.lapNum).padStart(2, '0')}</td>
            <td class="py-2 px-2 text-slate-300">${cycleBadge}${escapeHtml(lap.stepName)}${typeBadge}${cycleEndNote}</td>
            <td class="py-2 px-2 ${cls}">${lap.formattedLap}${tag}</td>
            <td class="py-2 px-2 text-right text-slate-400">${lap.formattedTotal}</td>
            <td class="py-2 px-2 text-center whitespace-nowrap">
                <button onclick="toggleLapExcluded(${lap.lapNum})" title="Toggle exclude" class="p-1 text-slate-500 hover:text-amber-400">${lap.excluded ? '↺' : '⊘'}</button>
            </td>
        </tr>`;
    }).join('');
    if (included.length > 0) {
        el.currentSessionStats.classList.remove('hidden');
        const st = computeStats(laps, elapsedTime, currentTemplate);
        document.getElementById('statFastest').textContent = fmtMs(st.min);
        document.getElementById('statAverage').textContent = fmtMs(st.avg);
        document.getElementById('statSlowest').textContent = fmtMs(st.max);
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
            renderLapsTable();
            closeTemplateMenu();
            showToast(`Template "${t.name}" applied (${t.steps.length} steps = 1 cycle)`, 'success');
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
    renderLapsTable();
    showToast('Template cleared', 'info');
}
function createNewTemplate() {
    const name = prompt('Template name (e.g. "Assembly Station 1"):', 'Manual Assembly');
    if (!name) return;
    const raw = prompt('Steps separated by comma, optionally with type like "Pick:VA, Fasten:VA, Inspect:NVAN, Dispose:NVA":', 'Pick:VA, Fasten:VA, Inspect:NVAN, Dispose:NVA');
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
    renderLapsTable();
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
        showToast('Could not load saved records.', 'error');
    }
}
function saveSessionsToStorage() {
    try { localStorage.setItem('process_timer_records', JSON.stringify(savedSessions)); }
    catch (e) { console.error(e); showToast('Failed to save to storage.', 'error'); }
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
        template: currentTemplate ? { name: currentTemplate.name, steps: currentTemplate.steps.map(st => ({ ...st })) } : null,
        laps: laps.map(l => ({ ...l })),
        meta: {},
        estimator: getLiveEstimatorState()
    };
    savedSessions.unshift(record);
    saveSessionsToStorage();
    renderSavedRecords();
    showToast(`Session "${name}" saved`, 'success');
    openRecordDetail(record.id);
}
function deleteRecord(id) {
    if (!confirm('Delete this recorded session?')) return;
    savedSessions = savedSessions.filter(s => s.id !== id);
    expandedIds.delete(id);
    saveSessionsToStorage();
    renderSavedRecords();
    showToast('Record deleted', 'info');
}
function clearAllHistory() {
    if (savedSessions.length === 0) return;
    if (!confirm('Delete ALL saved records? This cannot be undone.')) return;
    savedSessions = [];
    expandedIds.clear();
    saveSessionsToStorage();
    renderSavedRecords();
    showToast('All records cleared', 'info');
}

/* =========================================================
   STATISTICS & IE TIME-STUDY MATH (CYCLE-AWARE)
   ========================================================= */
function computeStats(lapArr, totalMs, templateObj) {
    const allLaps = lapArr || [];
    const stepsPerCycle = templateObj && Array.isArray(templateObj.steps) ? templateObj.steps.length : 0;
    const hasCycleTags = allLaps.some(l => l.cycleNum != null);

    // When a template/cycle structure is used, group steps into full cycles for cycle-time stats
    if (stepsPerCycle > 0 && hasCycleTags) {
        const byCycle = new Map();
        allLaps.forEach(l => {
            if (l.cycleNum == null) return;
            if (!byCycle.has(l.cycleNum)) byCycle.set(l.cycleNum, []);
            byCycle.get(l.cycleNum).push(l);
        });

        const validCycleDurations = [];
        let excludedCycles = 0;
        let inProgressCycles = 0;

        byCycle.forEach(group => {
            if (group.length < stepsPerCycle) {
                inProgressCycles++;
                return;
            }
            if (group.some(l => l.excluded)) {
                excludedCycles++;
                return;
            }
            const cycleMs = group.reduce((sum, l) => sum + (l.lapDurationMs || 0), 0);
            validCycleDurations.push(cycleMs);
        });

        if (validCycleDurations.length > 0) {
            const n = validCycleDurations.length;
            const avg = validCycleDurations.reduce((a, b) => a + b, 0) / n;
            const variance = n > 1 ? validCycleDurations.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1) : 0;
            const std = Math.sqrt(variance);
            return {
                mode: 'cycles',
                n,
                excludedN: excludedCycles,
                inProgressN: inProgressCycles,
                basisIsTotal: false,
                avg,
                min: Math.min(...validCycleDurations),
                max: Math.max(...validCycleDurations),
                std,
                cv: avg > 0 ? (std / avg) * 100 : 0
            };
        }
    }

    // Standard flat-lap mode (when no template is used or before Cycle 1 finishes)
    const included = allLaps.filter(l => !l.excluded);
    const d = included.map(l => l.lapDurationMs);
    if (d.length === 0) {
        return { mode: 'laps', n: 0, excludedN: allLaps.length, inProgressN: 0, basisIsTotal: true, avg: totalMs, min: totalMs, max: totalMs, std: 0, cv: 0 };
    }
    const n = d.length;
    const avg = d.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? d.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1) : 0;
    const std = Math.sqrt(variance);
    return { mode: 'laps', n, excludedN: allLaps.length - n, inProgressN: 0, basisIsTotal: false, avg, min: Math.min(...d), max: Math.max(...d), std, cv: avg > 0 ? (std / avg) * 100 : 0 };
}

function computeIEStudy(st, est) {
    const ratingPct = Math.max(1, Math.min(250, Number(est.performancePct) || 100));
    const allowancePct = Math.max(0, Math.min(200, Number(est.allowancePct) || 0));
    const ttdH = Math.max(0, Number(est.ttdH) || 0);
    const ttdM = Math.max(0, Number(est.ttdM) || 0);
    const demandUnits = Math.max(0, Number(est.demandUnits) || 0);

    const totalMinutes = ttdH * 60 + ttdM;
    const availMs = totalMinutes * 60000;
    const ratingFactor = ratingPct / 100;
    const allowanceFactor = 1 + (allowancePct / 100);

    const observedMs = Math.max(0, st.avg || 0);
    const normalMs = observedMs * ratingFactor;
    const standardMs = normalMs * allowanceFactor;

    const stdPerHour = standardMs > 0 ? 3600000 / standardMs : null;
    const stdPerTTD = (standardMs > 0 && availMs > 0) ? Math.floor(availMs / standardMs) : null;
    const stdPer8h = standardMs > 0 ? Math.floor((480 * 60000) / standardMs) : null;

    const taktMs = (demandUnits > 0 && availMs > 0) ? (availMs / demandUnits) : null;
    const taktGapMs = (taktMs != null && standardMs > 0) ? (standardMs - taktMs) : null;
    const bottleneckVsTakt = taktGapMs != null ? (taktGapMs > 0 ? 'OVER_TAKT' : 'WITHIN_TAKT') : null;

    const scenarioMs = (rawMs) => (Math.max(0, rawMs) * ratingFactor) * allowanceFactor;

    return {
        ttdH, ttdM, totalMinutes, availMs,
        availLabel: `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`,
        ratingPct, allowancePct, demandUnits,
        observedMs, normalMs, standardMs,
        stdPerHour, stdPerTTD, stdPer8h,
        taktMs, taktGapMs, bottleneckVsTakt,
        bestStdMs: scenarioMs(st.min),
        worstStdMs: scenarioMs(st.max),
        bestPerHour: scenarioMs(st.min) > 0 ? 3600000 / scenarioMs(st.min) : null,
        bestPerTTD: (scenarioMs(st.min) > 0 && availMs > 0) ? Math.floor(availMs / scenarioMs(st.min)) : null,
        worstPerHour: scenarioMs(st.max) > 0 ? 3600000 / scenarioMs(st.max) : null,
        worstPerTTD: (scenarioMs(st.max) > 0 && availMs > 0) ? Math.floor(availMs / scenarioMs(st.max)) : null
    };
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
        records: ['tabRecordsBtn', 'viewRecords']
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
    if (!['timer', 'records'].includes(name)) name = 'timer';
    activeView = name;
    applyTabStyles();
    if (name === 'records') renderRecordsView();
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
    listEl.innerHTML = filtered.map(s => {
        const st = computeStats(s.laps, s.totalDurationMs, s.template);
        const countLabel = st.mode === 'cycles'
            ? `Cycles: <span class="text-indigo-300">${st.n}</span> (${s.laps.length} steps)`
            : `Laps: <span class="text-slate-300">${s.laps.length}</span>`;
        return `<div class="bg-slate-950/70 border border-slate-800/80 hover:border-slate-700 rounded-xl p-3.5 transition-all">
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
                <span class="text-slate-500 text-[11px]">${countLabel}</span>
            </div>
        </div>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
}

/* =========================================================
   RECORDS & ANALYSIS
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
        fastest: (a, b) => computeStats(a.laps, a.totalDurationMs, a.template).avg - computeStats(b.laps, b.totalDurationMs, b.template).avg
    };
    const filtered = savedSessions.filter(s =>
        s.name.toLowerCase().includes(q) || (s.category || '').toLowerCase().includes(q));
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
        const st = computeStats(s.laps, s.totalDurationMs, s.template);
        const ie = computeIEStudy(st, getEstimator(s));
        const open = expandedIds.has(s.id);
        const unitWord = st.mode === 'cycles' ? 'cycle' : 'lap';
        const taktPill = ie.bottleneckVsTakt === 'OVER_TAKT'
            ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-950 border border-rose-800/80 text-rose-300 font-sans">ST &gt; Takt</span>`
            : ie.bottleneckVsTakt === 'WITHIN_TAKT'
                ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-800/80 text-emerald-300 font-sans">ST &le; Takt</span>`
                : '';
        return `<div id="rec-${s.id}" class="bg-slate-950/70 border ${open ? 'border-indigo-800/70' : 'border-slate-800/80'} rounded-xl scroll-mt-32">
            <button onclick="toggleRecord('${s.id}')" aria-expanded="${open}" class="w-full flex items-center gap-3 p-3.5 text-left hover:bg-slate-800/30 rounded-xl">
                <i data-lucide="${open ? 'chevron-down' : 'chevron-right'}" class="w-4 h-4 text-slate-400 shrink-0"></i>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h3 class="font-semibold text-sm text-slate-100 truncate">${escapeHtml(s.name)}</h3>
                        ${s.category ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950 border border-indigo-800/80 text-indigo-300">${escapeHtml(s.category)}</span>` : ''}
                        ${taktPill}
                    </div>
                    <p class="text-[11px] text-slate-500 font-mono mt-0.5">${escapeHtml(s.formattedDate)} &bull; ST ${fmtSec(ie.standardMs)}</p>
                </div>
                <div class="text-right font-mono shrink-0">
                    <div class="text-sm font-bold text-slate-100">${s.formattedTotalDuration}</div>
                    <div class="text-[11px] text-slate-500">${st.n} ${unitWord}${st.n === 1 ? '' : 's'}${st.n > 0 ? ' &middot; avg ' + fmtMs(st.avg) : ''}</div>
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
    const st = computeStats(s.laps, s.totalDurationMs, s.template);
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
    const isCycleMode = st.mode === 'cycles';
    let statsBlock;
    if (st.n === 0) {
        statsBlock = `<p class="text-xs text-slate-400">No completed cycles/laps recorded. Total: <span class="font-mono text-slate-200">${s.formattedTotalDuration}</span>.</p>`;
    } else {
        const [cvLabel, cvColor] = cvBadge(st.cv);
        const countTileLabel = isCycleMode ? 'Completed Cycles' : 'Laps';
        const countTileVal = st.n + (st.excludedN ? ` (${st.excludedN} excl)` : '') + (st.inProgressN ? ` (+${st.inProgressN} open)` : '');
        statsBlock = `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${tile('Total', s.formattedTotalDuration, 'text-slate-100')}
            ${tile(countTileLabel, countTileVal, 'text-slate-100')}
            ${tile(isCycleMode ? 'Fastest Cycle' : 'Fastest', fmtMs(st.min), 'text-emerald-400')}
            ${tile(isCycleMode ? 'Avg Cycle (OT)' : 'Average (OT)', fmtMs(st.avg), 'text-indigo-300')}
            ${tile(isCycleMode ? 'Slowest Cycle' : 'Slowest', fmtMs(st.max), 'text-rose-400')}
            ${tile('Std dev', st.n > 1 ? fmtSec(st.std) : '--', 'text-slate-200')}
            ${tile('CV', st.n > 1 ? st.cv.toFixed(1) + '%' : '--', cvColor, cvLabel)}
        </div>`;
    }
    const tableBlock = chrono.length === 0 ? '' : `
        <div>
            <h4 class="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">All steps &amp; cycles</h4>
            <div class="overflow-auto max-h-72 border border-slate-800/70 rounded-lg">
                <table class="w-full text-left text-xs font-mono">
                    <thead class="sticky top-0 bg-slate-900 text-slate-400 text-[10px] uppercase">
                        <tr><th class="py-2 px-3">#</th><th class="py-2 px-3">Cycle / Step</th><th class="py-2 px-3">Duration</th><th class="py-2 px-3 hidden sm:table-cell">Cumulative</th><th class="py-2 px-3 text-right">${isCycleMode ? 'Step' : 'vs avg'}</th></tr>
                    </thead>
                    <tbody class="divide-y divide-slate-800/60">
                        ${chrono.map(l => {
                            const diff = l.lapDurationMs - st.avg;
                            const sign = diff >= 0 ? '+' : '-';
                            const cls = l.excluded ? 'text-slate-600 line-through' : 'text-slate-200';
                            const cTag = l.cycleNum != null ? `<span class="mr-1.5 text-[10px] px-1 rounded ${l.cycleComplete ? 'bg-indigo-900/80 text-indigo-200' : 'bg-slate-800 text-slate-400'}">C${l.cycleNum}</span>` : '';
                            const rightCell = isCycleMode
                                ? `<td class="py-1.5 px-3 text-right text-slate-400">${l.cycleComplete ? '<span class="text-indigo-300">End C' + l.cycleNum + '</span>' : (l.stepNumInCycle ? 'Step ' + l.stepNumInCycle : '')}</td>`
                                : `<td class="py-1.5 px-3 text-right ${diff > 0 ? 'text-rose-300' : 'text-emerald-300'}">${sign}${(Math.abs(diff)/1000).toFixed(3)}s</td>`;
                            return `<tr class="${l.cycleComplete ? 'border-b-2 border-indigo-500/40' : ''} hover:bg-slate-800/40">
                                <td class="py-1.5 px-3 text-slate-400">#${String(l.lapNum).padStart(2,'0')}</td>
                                <td class="py-1.5 px-3 ${cls}">${cTag}${escapeHtml(l.stepName || '')}${l.stepType ? ` <span class="text-[9px] px-1 rounded bg-slate-800 text-slate-400">${l.stepType}</span>` : ''}</td>
                                <td class="py-1.5 px-3 ${cls}">${l.formattedLap}</td>
                                <td class="py-1.5 px-3 text-slate-400 hidden sm:table-cell">${l.formattedTotal}</td>
                                ${rightCell}
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
    const estimatorBlock = inSheet ? '' : `<div class="mt-2">${estimatorHTML(s, st)}</div>`;
    const actions = inSheet ? '' : `<div class="flex items-center gap-2 pt-1">
        <button onclick="openExportMenu(event, '${s.id}')" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"><i data-lucide="download" class="w-3.5 h-3.5 text-indigo-400"></i> Export</button>
        <button onclick="deleteRecord('${s.id}')" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700"><i data-lucide="trash" class="w-3.5 h-3.5"></i> Delete</button>
    </div>`;
    return `<div class="px-3.5 pb-4 pt-3 space-y-4 ${inSheet ? 'p-4' : 'border-t border-slate-800/70'}">
        ${statsBlock}
        ${tableBlock}
        ${estimatorBlock}
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
   STANDARD TIME, RATING, ALLOWANCE & TAKT ESTIMATOR
   ========================================================= */
let liveEstimatorState = defaultEstimator();
function getLiveEstimatorState() {
    return { ...liveEstimatorState };
}
function getEstimator(s) {
    return Object.assign(defaultEstimator(), s.estimator || {});
}

function estimatorControlsHTML(idPrefix, est, onChangeExpr) {
    const inputCls = 'w-20 bg-slate-950/80 border border-slate-800 focus:border-indigo-500 rounded-lg px-2 py-1.5 text-sm text-slate-100 outline-none font-mono';
    return `<div class="flex flex-wrap items-end gap-3">
        <label class="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">TTD Hours
            <input type="number" min="0" step="any" id="est-h-${idPrefix}" value="${est.ttdH}" oninput="${onChangeExpr}" class="${inputCls} block mt-1">
        </label>
        <label class="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">TTD Minutes
            <input type="number" min="0" step="any" id="est-m-${idPrefix}" value="${est.ttdM}" oninput="${onChangeExpr}" class="${inputCls} block mt-1">
        </label>
        <label class="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Rating %
            <input type="number" min="1" max="250" step="1" id="est-p-${idPrefix}" value="${est.performancePct}" oninput="${onChangeExpr}" class="${inputCls} block mt-1">
        </label>
        <label class="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Allowance %
            <input type="number" min="0" max="200" step="0.5" id="est-a-${idPrefix}" value="${est.allowancePct}" oninput="${onChangeExpr}" class="${inputCls} block mt-1">
        </label>
        <label class="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Demand (pcs)
            <input type="number" min="0" step="1" id="est-d-${idPrefix}" value="${est.demandUnits}" oninput="${onChangeExpr}" placeholder="0" class="${inputCls} block mt-1">
        </label>
        <div class="flex flex-wrap gap-1.5 pb-0.5">
            ${[[30,'30m'],[60,'1h'],[240,'4h'],[480,'8h'],[600,'10h'],[720,'12h']].map(([m,l]) => `<button type="button" onclick="setTTDPreset('${idPrefix}', ${m})" class="px-2 py-1 text-[11px] rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700">${l}</button>`).join('')}
        </div>
    </div>`;
}

function estimatorHTML(s, st) {
    const est = getEstimator(s);
    const basisNote = st.mode === 'cycles'
        ? `Based on ${st.n} completed cycle${st.n === 1 ? '' : 's'} (${s.template.steps.length} steps/cycle).`
        : 'Normal Time = Observed × Rating %. Standard Time = Normal × (1 + Allowance %).';
    return `<div class="rounded-xl border border-indigo-900/60 bg-indigo-950/20 p-4">
        <div class="flex items-center gap-2 mb-2">
            <i data-lucide="calculator" class="w-4 h-4 text-indigo-400"></i>
            <h3 class="font-semibold text-sm text-slate-200">Standard Time &amp; Takt Estimator</h3>
        </div>
        <p class="text-[11px] text-slate-400 mb-3">${basisNote}</p>
        ${estimatorControlsHTML(s.id, est, `updateEstimator('${s.id}')`)}
        <div id="est-out-${s.id}" class="mt-4">${estimatorResultHTML(st, est)}</div>
    </div>`;
}

function setTTDPreset(idPrefix, totalMin) {
    const h = document.getElementById('est-h-' + idPrefix);
    const m = document.getElementById('est-m-' + idPrefix);
    if (h) h.value = Math.floor(totalMin / 60);
    if (m) m.value = totalMin % 60;
    if (idPrefix === 'live') updateLiveEstimator();
    else updateEstimator(idPrefix);
}

function readEstimatorInputs(idPrefix, fallback) {
    const base = Object.assign(defaultEstimator(), fallback || {});
    const hEl = document.getElementById('est-h-' + idPrefix);
    const mEl = document.getElementById('est-m-' + idPrefix);
    const pEl = document.getElementById('est-p-' + idPrefix);
    const aEl = document.getElementById('est-a-' + idPrefix);
    const dEl = document.getElementById('est-d-' + idPrefix);
    return {
        ttdH: hEl ? Math.max(0, parseFloat(hEl.value) || 0) : base.ttdH,
        ttdM: mEl ? Math.max(0, parseFloat(mEl.value) || 0) : base.ttdM,
        performancePct: pEl ? Math.max(1, Math.min(250, parseFloat(pEl.value) || 100)) : base.performancePct,
        allowancePct: aEl ? Math.max(0, Math.min(200, parseFloat(aEl.value) || 0)) : base.allowancePct,
        demandUnits: dEl ? Math.max(0, parseFloat(dEl.value) || 0) : base.demandUnits
    };
}

function updateEstimator(id) {
    const s = savedSessions.find(x => x.id === id);
    if (!s) return;
    s.estimator = readEstimatorInputs(id, s.estimator);
    saveSessionsToStorage();
    paintEstimatorResult(s);
}
function paintEstimatorResult(s) {
    const out = document.getElementById('est-out-' + s.id);
    if (!out) return;
    const st = computeStats(s.laps, s.totalDurationMs, s.template);
    out.innerHTML = estimatorResultHTML(st, s.estimator);
    if (window.lucide) lucide.createIcons();
}

function updateLiveEstimator() {
    liveEstimatorState = readEstimatorInputs('live', liveEstimatorState);
    const out = document.getElementById('est-out-live');
    if (!out) return;
    const st = computeStats(laps, elapsedTime, currentTemplate);
    out.innerHTML = estimatorResultHTML(st, liveEstimatorState);
    if (window.lucide) lucide.createIcons();
}

function estimatorResultHTML(st, est) {
    const ie = computeIEStudy(st, est);
    if (!(st.avg > 0)) return '<p class="text-xs text-slate-500 italic">Cycle time is zero.</p>';

    const summaryCards = `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3">
        <div class="bg-slate-950/60 border border-slate-800/60 rounded-xl p-3 text-center">
            <div class="text-[10px] uppercase text-slate-500">Normal Time (NT)</div>
            <div class="font-mono text-lg font-bold text-slate-200 mt-1">${fmtMs(ie.normalMs)}</div>
            <div class="text-[11px] text-slate-500 mt-0.5">@ ${ie.ratingPct}% rating</div>
        </div>
        <div class="bg-slate-950/60 border border-indigo-800/50 rounded-xl p-3 text-center">
            <div class="text-[10px] uppercase text-indigo-400">Standard Time (ST)</div>
            <div class="font-mono text-lg font-bold text-indigo-300 mt-1">${fmtMs(ie.standardMs)}</div>
            <div class="text-[11px] text-slate-400 mt-0.5">+${ie.allowancePct}% allowance</div>
        </div>
        <div class="bg-slate-950/60 border border-slate-800/60 rounded-xl p-3 text-center">
            <div class="text-[10px] uppercase text-slate-500">Std Pieces / Hour</div>
            <div class="font-mono text-lg font-bold text-emerald-300 mt-1">${ie.stdPerHour != null ? ie.stdPerHour.toFixed(1) : '--'}</div>
            <div class="text-[11px] text-slate-400 mt-0.5">${ie.stdPerTTD != null ? `${ie.stdPerTTD.toLocaleString()} in ${ie.availLabel}` : 'Enter TTD'}</div>
        </div>
        <div class="bg-slate-950/60 border border-slate-800/60 rounded-xl p-3 text-center">
            <div class="text-[10px] uppercase text-slate-500">Takt Time</div>
            <div class="font-mono text-lg font-bold ${ie.bottleneckVsTakt === 'OVER_TAKT' ? 'text-rose-400' : ie.bottleneckVsTakt === 'WITHIN_TAKT' ? 'text-emerald-400' : 'text-amber-300'} mt-1">${ie.taktMs != null ? fmtMs(ie.taktMs) : '--'}</div>
            <div class="text-[11px] mt-0.5 ${ie.bottleneckVsTakt === 'OVER_TAKT' ? 'text-rose-400' : ie.bottleneckVsTakt === 'WITHIN_TAKT' ? 'text-emerald-400' : 'text-slate-500'}">${
                ie.taktGapMs != null
                    ? (ie.taktGapMs > 0 ? `+${fmtSec(ie.taktGapMs)} over Takt` : `${fmtSec(Math.abs(ie.taktGapMs))} margin`)
                    : 'Enter TTD & demand'
            }</div>
        </div>
    </div>`;

    const scenario = (label, color, rawMs) => {
        const stdMs = (Math.max(0, rawMs) * (ie.ratingPct / 100)) * (1 + ie.allowancePct / 100);
        const pcsHr = stdMs > 0 ? (3600000 / stdMs).toFixed(1) : '--';
        const pcsTTD = (stdMs > 0 && ie.availMs > 0) ? Math.floor(ie.availMs / stdMs).toLocaleString() : '--';
        return `<tr>
            <td class="py-1.5 pr-2 ${color}">${label}</td>
            <td class="py-1.5 pr-2 text-slate-300">${fmtMs(rawMs)}</td>
            <td class="py-1.5 pr-2 text-right font-bold ${color}">${fmtMs(stdMs)}</td>
            <td class="py-1.5 pr-2 text-right text-slate-300">${pcsHr}</td>
            <td class="py-1.5 text-right text-slate-400 hidden sm:table-cell">${pcsTTD}</td>
        </tr>`;
    };

    const rows = st.n > 1
        ? scenario('Best', 'text-emerald-400', st.min) + scenario('Expected', 'text-indigo-300', st.avg) + scenario('Worst', 'text-rose-400', st.max)
        : scenario(st.basisIsTotal ? 'Total (no laps)' : (st.mode === 'cycles' ? '1 Cycle' : 'Single lap'), 'text-indigo-300', st.avg);

    const table = `<div class="bg-slate-950/60 border border-slate-800/60 rounded-xl p-3 overflow-x-auto">
        <table class="w-full text-xs font-mono">
            <thead class="text-slate-500 text-[10px] uppercase"><tr>
                <th class="text-left py-1 pr-2">Scenario</th>
                <th class="text-left py-1 pr-2">Observed</th>
                <th class="text-right py-1 pr-2">Std Time (ST)</th>
                <th class="text-right py-1 pr-2">Std Pcs / hr</th>
                <th class="text-right py-1 hidden sm:table-cell">Pcs in ${ie.availLabel}</th>
            </tr></thead>
            <tbody class="divide-y divide-slate-800/60">${rows}</tbody>
        </table>
    </div>`;

    const basisBadge = st.mode === 'cycles'
        ? `Using ${st.n} completed cycle${st.n === 1 ? '' : 's'}. `
        : (currentTemplate ? 'Complete Cycle 1 to calculate full-cycle Standard Time. ' : '');

    const note = `<p class="text-[11px] text-slate-500 mt-2">${basisBadge}Standard Time = Observed &times; (${ie.ratingPct}% &divide; 100) &times; (1 + ${ie.allowancePct}% &divide; 100).${st.basisIsTotal ? ' <span class="text-amber-400">No laps recorded — total time treated as one cycle.</span>' : ''}</p>`;

    return summaryCards + table + note;
}

/* =========================================================
   LIVE ESTIMATOR (during timing)
   ========================================================= */
function renderLiveEstimator() {
    const card = document.getElementById('liveEstimatorCard');
    if (!card) return;
    if (laps.length === 0) { card.classList.add('hidden'); card.innerHTML = ''; return; }
    card.classList.remove('hidden');
    const st = computeStats(laps, elapsedTime, currentTemplate);
    const est = getLiveEstimatorState();
    card.innerHTML = `<div class="rounded-xl border border-indigo-900/60 bg-indigo-950/20 p-4 shadow-xl">
        <div class="flex items-center gap-2 mb-2">
            <i data-lucide="calculator" class="w-4 h-4 text-indigo-400"></i>
            <h3 class="font-semibold text-sm text-slate-200">Live Standard Time &amp; Takt Estimator</h3>
        </div>
        ${estimatorControlsHTML('live', est, 'updateLiveEstimator()')}
        <div id="est-out-live" class="mt-4">${estimatorResultHTML(st, est)}</div>
    </div>`;
    if (window.lucide) lucide.createIcons();
}

/* =========================================================
   KEYBOARD
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