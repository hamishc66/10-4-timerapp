/**
 * 10-4 Timer — app.js
 *
 * ┌─ Architecture overview ──────────────────────────────────────────────────┐
 * │  State      → single `state` object, mutated via helpers                 │
 * │  Rendering  → lightweight DOM updates (no framework)                     │
 * │  Storage    → localStorage for sessions + settings + sync queue          │
 * │  Audio      → Web Audio API (no external files)                          │
 * │  Wake Lock  → Screen Wake Lock API (keeps display on while running)      │
 * │  Sync       → configurable HTTP POST, with retry queue                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * NOTE — Background audio on mobile:
 *   iOS Safari and Android Chrome suspend JavaScript (and therefore Web Audio)
 *   when the browser tab is backgrounded or the screen is locked.  This is a
 *   browser security restriction; a Service Worker alone cannot bypass it for
 *   audio.  The best practice is to keep the screen on (handled via Wake Lock
 *   when available) and keep the tab visible.
 */

'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════════════════════════════ */

const PRESETS = {
  focus:    { label: 'Focus',    minutes: 25, seconds: 0 },
  study:    { label: 'Study',    minutes: 50, seconds: 0 },
  pomodoro: { label: 'Pomodoro', minutes: 25, seconds: 0 },
  custom:   { label: 'Custom',   minutes: 10, seconds: 0 },
};

const STORAGE_KEYS = {
  SESSIONS:  'tenfour_sessions',
  SETTINGS:  'tenfour_settings',
  SYNC_Q:    'tenfour_sync_queue',
};

const DEFAULT_SETTINGS = {
  defaultPreset:  'focus',
  pomoWorkMins:   25,
  pomoBreakMins:  5,
  muted:          false,
  lightTheme:     false,
  syncEndpoint:   '',
};

/* ════════════════════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════════════════════ */

const state = {
  // Timer engine
  mode:           'countdown',   // 'countdown' | 'countup'
  preset:         'focus',
  totalSeconds:   25 * 60,
  remainingSeconds: 25 * 60,
  elapsedSeconds: 0,
  running:        false,
  intervalId:     null,
  sessionStartTs: null,

  // Pomodoro
  pomoPhase:      'work',        // 'work' | 'break'
  pomoCycle:      1,
  pomoWorkSecs:   25 * 60,
  pomoBreakSecs:  5  * 60,

  // Audio
  audioCtx:       null,
  alarmPlaying:   false,
  alarmSource:    null,
  alarmGain:      null,

  // Wake Lock
  wakeLock:       null,

  // Settings
  settings:       { ...DEFAULT_SETTINGS },

  // Data
  sessions:       [],
  syncQueue:      [],
};

/* ════════════════════════════════════════════════════════════════════════════
   STORAGE HELPERS
════════════════════════════════════════════════════════════════════════════ */

function loadStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SESSIONS);
    state.sessions = raw ? JSON.parse(raw).sessions || [] : [];
  } catch { state.sessions = []; }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    state.settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch { state.settings = { ...DEFAULT_SETTINGS }; }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SYNC_Q);
    state.syncQueue = raw ? JSON.parse(raw) : [];
  } catch { state.syncQueue = []; }
}

function saveSessions() {
  localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify({ sessions: state.sessions }));
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
}

function saveSyncQueue() {
  localStorage.setItem(STORAGE_KEYS.SYNC_Q, JSON.stringify(state.syncQueue));
}

/* ════════════════════════════════════════════════════════════════════════════
   TIMER ENGINE
════════════════════════════════════════════════════════════════════════════ */

function setPreset(preset, { apply = true } = {}) {
  state.preset = preset;

  const cfg = PRESETS[preset];
  if (!cfg) return;

  // Pomodoro uses its own durations
  if (preset === 'pomodoro') {
    state.totalSeconds = state.settings.pomoWorkMins * 60;
    state.pomoPhase    = 'work';
    state.pomoCycle    = 1;
    state.pomoWorkSecs = state.settings.pomoWorkMins * 60;
    state.pomoBreakSecs= state.settings.pomoBreakMins * 60;
  } else if (preset === 'custom') {
    const m = parseInt(el('customMins').value, 10) || 0;
    const s = parseInt(el('customSecs').value, 10) || 0;
    state.totalSeconds = m * 60 + s;
  } else {
    state.totalSeconds = cfg.minutes * 60 + cfg.seconds;
  }

  if (apply) {
    resetTimer();
  }

  updatePresetUI();
}

function startTimer() {
  if (state.running) return;
  state.running = true;
  state.sessionStartTs = state.sessionStartTs || Date.now();

  state.intervalId = setInterval(tick, 1000);
  acquireWakeLock();
  updateControlsUI();
}

function pauseTimer() {
  if (!state.running) return;
  state.running = false;
  clearInterval(state.intervalId);
  state.intervalId = null;
  releaseWakeLock();
  updateControlsUI();
}

function resetTimer() {
  pauseTimer();
  stopAlarm();

  if (state.mode === 'countdown') {
    state.remainingSeconds = state.totalSeconds;
  }
  state.elapsedSeconds  = 0;
  state.sessionStartTs  = null;

  // Reset Pomo phase if resetting from pomodoro
  if (state.preset === 'pomodoro') {
    state.pomoPhase = 'work';
    state.pomoCycle = 1;
    state.remainingSeconds = state.pomoWorkSecs;
    state.totalSeconds     = state.pomoWorkSecs;
    updatePomoBadge();
  } else {
    state.remainingSeconds = state.totalSeconds;
  }

  updateTimerDisplay();
  updateControlsUI();
  updateTopoFill(0);
}

function tick() {
  if (state.mode === 'countdown') {
    state.remainingSeconds--;
    state.elapsedSeconds++;

    if (state.remainingSeconds <= 0) {
      state.remainingSeconds = 0;
      onCountdownComplete();
      return;
    }
  } else {
    // Count-up stopwatch
    state.elapsedSeconds++;
    state.remainingSeconds = state.elapsedSeconds;
  }

  updateTimerDisplay();
  updateTopoFill();
}

function onCountdownComplete() {
  clearInterval(state.intervalId);
  state.intervalId = null;
  state.running = false;
  releaseWakeLock();

  if (state.preset === 'pomodoro') {
    handlePomoPhaseComplete();
  } else {
    completeSession(true);
  }
}

function handlePomoPhaseComplete() {
  const wasWork = state.pomoPhase === 'work';

  if (wasWork) {
    // Completed a work phase — save session
    completeSession(true, { skipOverlay: true });
    // Switch to break
    state.pomoPhase = 'break';
    state.remainingSeconds = state.pomoBreakSecs;
    state.totalSeconds     = state.pomoBreakSecs;
  } else {
    // Completed a break phase — move to next cycle
    state.pomoCycle++;
    state.pomoPhase = 'work';
    state.remainingSeconds = state.pomoWorkSecs;
    state.totalSeconds     = state.pomoWorkSecs;
  }

  updatePomoBadge();
  updateTimerDisplay();
  updateTopoFill(0);
  playAlarmBriefly();

  // Auto-start next phase
  state.sessionStartTs = Date.now();
  state.running = true;
  state.intervalId = setInterval(tick, 1000);
  acquireWakeLock();
  updateControlsUI();
}

/* ════════════════════════════════════════════════════════════════════════════
   SESSION MANAGEMENT
════════════════════════════════════════════════════════════════════════════ */

function completeSession(completed, { skipOverlay = false } = {}) {
  pauseTimer();
  stopAlarm();

  const durationSecs = state.elapsedSeconds;
  const durationMins = Math.round(durationSecs / 60);

  const session = {
    date:             new Date().toISOString().slice(0, 10),
    duration_minutes: durationMins,
    type:             getSessionTypeLabel(),
    completed:        completed,
  };

  state.sessions.push(session);
  // Keep only last 200 sessions
  if (state.sessions.length > 200) state.sessions = state.sessions.slice(-200);
  saveSessions();

  // Queue sync
  queueSync(session);
  // Attempt sync immediately
  attemptSync();

  if (!skipOverlay) {
    showCompletionOverlay(session);
    if (!state.settings.muted) playAlarm();
  }

  state.elapsedSeconds  = 0;
  state.sessionStartTs  = null;
}

function bailOut() {
  const durationSecs = state.elapsedSeconds;
  if (durationSecs > 0) {
    completeSession(false);
  } else {
    pauseTimer();
  }
  // Open Spotify
  window.open('https://open.spotify.com', '_blank', 'noopener');
}

function getSessionTypeLabel() {
  if (state.preset === 'pomodoro') return 'Pomodoro';
  const cfg = PRESETS[state.preset];
  return cfg ? cfg.label : 'Custom';
}

/* ════════════════════════════════════════════════════════════════════════════
   SYNC
════════════════════════════════════════════════════════════════════════════ */

function queueSync(session) {
  state.syncQueue.push(session);
  saveSyncQueue();
  updateSyncQueueLabel();
}

async function attemptSync() {
  const endpoint = state.settings.syncEndpoint?.trim();
  if (!endpoint || state.syncQueue.length === 0) return;

  try {
    const body = JSON.stringify({ sessions: state.syncQueue });
    const res  = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.ok) {
      state.syncQueue = [];
      saveSyncQueue();
      updateSyncQueueLabel();
    }
    // If not ok, leave queue intact for next retry
  } catch {
    // Silently fail — data stays in queue
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   AUDIO — Web Audio API radio squelch sound (no external files)
════════════════════════════════════════════════════════════════════════════ */

function getAudioCtx() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.audioCtx;
}

/**
 * Generate a radio squelch / beep sound.
 * Layers:
 *   1. A burst of pink noise (squelch/static)
 *   2. Two tones (characteristic radio beep pattern)
 * Returns an AudioBufferSourceNode connected to destination.
 */
function createSquelchBuffer(ctx) {
  const sampleRate = ctx.sampleRate;
  const duration   = 1.4; // seconds per beep cycle
  const length     = Math.floor(sampleRate * duration);
  const buffer     = ctx.createBuffer(1, length, sampleRate);
  const data       = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let sample = 0;

    // Pink-ish noise burst at the start (0–0.12 s)
    if (t < 0.12) {
      sample += (Math.random() * 2 - 1) * 0.6 * Math.max(0, 1 - t / 0.12);
    }

    // Tone 1 — 880 Hz beep (0.15–0.55 s)
    if (t >= 0.15 && t <= 0.55) {
      const env = Math.min((t - 0.15) / 0.03, 1) * Math.min((0.55 - t) / 0.03, 1);
      sample += Math.sin(2 * Math.PI * 880 * t) * 0.5 * env;
    }

    // Tone 2 — 1100 Hz beep (0.65–1.05 s)
    if (t >= 0.65 && t <= 1.05) {
      const env = Math.min((t - 0.65) / 0.03, 1) * Math.min((1.05 - t) / 0.03, 1);
      sample += Math.sin(2 * Math.PI * 1100 * t) * 0.5 * env;
    }

    // End squelch burst (1.1–1.4 s)
    if (t >= 1.1) {
      const frac = (t - 1.1) / 0.3;
      sample += (Math.random() * 2 - 1) * 0.5 * (1 - frac);
    }

    data[i] = sample;
  }

  return buffer;
}

function playAlarm() {
  if (state.settings.muted || state.alarmPlaying) return;

  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  const buffer = createSquelchBuffer(ctx);
  const gain   = ctx.createGain();
  gain.gain.value = 0.85;
  gain.connect(ctx.destination);

  state.alarmGain = gain;

  function playLoop() {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    src.onended = () => {
      if (state.alarmPlaying) playLoop();
    };
    src.start();
    state.alarmSource = src;
  }

  state.alarmPlaying = true;
  playLoop();
}

function playAlarmBriefly() {
  if (state.settings.muted) return;
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  const buffer = createSquelchBuffer(ctx);
  const gain   = ctx.createGain();
  gain.gain.value = 0.5;
  gain.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(gain);
  src.start();
}

function stopAlarm() {
  state.alarmPlaying = false;
  if (state.alarmSource) {
    try { state.alarmSource.stop(); } catch { /* already stopped */ }
    state.alarmSource = null;
  }
  if (state.alarmGain) {
    try { state.alarmGain.disconnect(); } catch { /* ignore */ }
    state.alarmGain = null;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   WAKE LOCK
════════════════════════════════════════════════════════════════════════════ */

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
      // Re-acquire if timer is still running (e.g. page visibility change)
      if (state.running) acquireWakeLock();
    });
  } catch { /* Wake Lock not available */ }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release();
    state.wakeLock = null;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   DOM HELPERS
════════════════════════════════════════════════════════════════════════════ */

function el(id) { return document.getElementById(id); }

function fmt(secs) {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/* ════════════════════════════════════════════════════════════════════════════
   UI UPDATE FUNCTIONS
════════════════════════════════════════════════════════════════════════════ */

function updateTimerDisplay() {
  const disp = el('timeDisplay');
  const secs = state.mode === 'countdown' ? state.remainingSeconds : state.elapsedSeconds;
  const newText = fmt(secs);

  if (disp.textContent !== newText) {
    disp.textContent = newText;
    // Tick animation
    disp.classList.remove('tick');
    void disp.offsetWidth; // reflow
    disp.classList.add('tick');
  }

  // Label
  let label = getSessionTypeLabel();
  if (state.preset === 'pomodoro') {
    label = state.pomoPhase === 'work' ? 'Work' : 'Break';
  }
  el('timeLabel').textContent = label;
}

function updateTopoFill(forceProgress) {
  const fillRect = el('fillRect');
  const washRect = el('washRect');
  if (!fillRect || !washRect) return;

  let progress; // 0 = empty, 1 = full
  if (typeof forceProgress === 'number') {
    progress = forceProgress;
  } else if (state.mode === 'countdown') {
    const total = state.totalSeconds || 1;
    progress = (total - state.remainingSeconds) / total;
  } else {
    // Count-up: fills based on elapsed vs some reference (e.g. 25 min)
    const ref = Math.max(state.totalSeconds, 25 * 60);
    progress = Math.min(state.elapsedSeconds / ref, 1);
  }

  // SVG viewBox height is 320, fill from bottom → top
  const svgH   = 320;
  const fillH  = progress * svgH;
  const fillY  = svgH - fillH;

  fillRect.setAttribute('y', fillY);
  fillRect.setAttribute('height', fillH);
  washRect.setAttribute('y', fillY);
  washRect.setAttribute('height', fillH);
}

function updateControlsUI() {
  const btn  = el('playPauseBtn');
  const icon = btn.querySelector('.btn-icon');
  const text = btn.querySelector('.btn-text');

  if (state.running) {
    icon.textContent = '⏸';
    text.textContent = 'Pause';
    btn.setAttribute('aria-label', 'Pause timer');
  } else {
    icon.textContent = '▶';
    text.textContent = state.elapsedSeconds > 0 ? 'Resume' : 'Start';
    btn.setAttribute('aria-label', 'Start timer');
  }
}

function updatePresetUI() {
  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach((b) => {
    const active = b.dataset.preset === state.preset;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });

  // Custom inputs
  el('customInputs').classList.toggle('hidden', state.preset !== 'custom');

  // Pomo badge
  el('pomoBadge').classList.toggle('hidden', state.preset !== 'pomodoro');
  if (state.preset === 'pomodoro') updatePomoBadge();
}

function updatePomoBadge() {
  el('pomoPhaseLabel').textContent  = state.pomoPhase === 'work' ? 'Work 🎯' : 'Break ☕';
  el('pomoCycleCount').textContent  = `Cycle ${state.pomoCycle}`;
}

function updateMuteUI() {
  const waves = document.querySelectorAll('.sound-waves');
  const line  = document.querySelector('.mute-line');
  if (state.settings.muted) {
    waves.forEach(w => (w.style.display = 'none'));
    line.style.display = '';
  } else {
    waves.forEach(w => (w.style.display = ''));
    line.style.display = 'none';
  }
  el('soundToggle').checked = !state.settings.muted;
}

function updateThemeUI() {
  document.body.dataset.theme = state.settings.lightTheme ? 'light' : 'dark';
  el('lightThemeToggle').checked = state.settings.lightTheme;
}

function updateSyncQueueLabel() {
  const n = state.syncQueue.length;
  el('syncQueueLabel').textContent = `Queue: ${n} pending`;
}

/* ════════════════════════════════════════════════════════════════════════════
   COMPLETION OVERLAY
════════════════════════════════════════════════════════════════════════════ */

function showCompletionOverlay(session) {
  el('sumType').textContent     = session.type;
  el('sumDuration').textContent = session.duration_minutes < 1
    ? '< 1 min'
    : `${session.duration_minutes} min`;
  el('sumDate').textContent     = session.date;

  el('completionOverlay').classList.remove('hidden');
}

function hideCompletionOverlay() {
  stopAlarm();
  el('completionOverlay').classList.add('hidden');
  // Reset timer for next session
  setPreset(state.preset);
}

/* ════════════════════════════════════════════════════════════════════════════
   STATS
════════════════════════════════════════════════════════════════════════════ */

function renderStats() {
  const sessions = state.sessions;

  // ── Summary stats ──────────────────────────────────────────────
  // This week (Mon–Sun)
  const today = new Date();
  const dayOfWeek = (today.getDay() + 6) % 7; // Mon = 0
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - dayOfWeek);
  weekStart.setHours(0, 0, 0, 0);

  const thisWeekMins = sessions
    .filter(s => new Date(s.date) >= weekStart)
    .reduce((acc, s) => acc + (s.duration_minutes || 0), 0);

  const longestMins = sessions.reduce((m, s) => Math.max(m, s.duration_minutes || 0), 0);

  const totalSessions = sessions.length;

  // Streak: consecutive days with at least one completed session
  const streak = calcStreak(sessions);

  el('statWeekHours').textContent = (thisWeekMins / 60).toFixed(1) + 'h';
  el('statLongest').textContent   = longestMins + 'm';
  el('statStreak').textContent    = streak;
  el('statTotal').textContent     = totalSessions;

  // ── Chart ──────────────────────────────────────────────────────
  renderChart(sessions);

  // ── Session history ────────────────────────────────────────────
  renderSessionList(sessions);
}

function calcStreak(sessions) {
  const completed = sessions
    .filter(s => s.completed)
    .map(s => s.date)
    .sort()
    .reverse();

  if (completed.length === 0) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const days  = [...new Set(completed)]; // unique days

  // Check if today or yesterday is in the list (streak can still be alive)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  if (days[0] !== today && days[0] !== yesterdayStr) return 0;

  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    const curr = new Date(days[i - 1]);
    const prev = new Date(days[i]);
    const diff = (curr - prev) / (1000 * 60 * 60 * 24);
    if (Math.round(diff) === 1) streak++;
    else break;
  }
  return streak;
}

function renderChart(sessions) {
  const canvas  = el('patrolChart');
  const ctx     = canvas.getContext('2d');
  const W       = canvas.width;
  const H       = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Last 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  // Sum minutes per day
  const minutesPerDay = days.map(day =>
    sessions
      .filter(s => s.date === day)
      .reduce((acc, s) => acc + (s.duration_minutes || 0), 0)
  );

  const maxMins = Math.max(...minutesPerDay, 60); // minimum axis of 60 min

  // Resolve CSS variables for colours
  const style     = getComputedStyle(document.body);
  const cPrimary  = style.getPropertyValue('--c-primary').trim() || '#FF4F00';
  const cText3    = style.getPropertyValue('--c-text-3').trim()  || '#7a9464';
  const cBorder   = style.getPropertyValue('--c-border').trim()  || 'rgba(255,255,255,0.1)';

  const padL = 36, padR = 12, padT = 12, padB = 32;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  // Grid lines
  ctx.strokeStyle = cBorder;
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + chartH - (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + chartW, y);
    ctx.stroke();

    // Y-axis label
    ctx.fillStyle  = cText3;
    ctx.font       = '10px Inter, sans-serif';
    ctx.textAlign  = 'right';
    ctx.fillText(Math.round((i / 4) * maxMins / 60 * 10) / 10 + 'h', padL - 4, y + 4);
  }

  // Bars / dots
  const slotW = chartW / 7;
  days.forEach((day, i) => {
    const mins = minutesPerDay[i];
    const x    = padL + i * slotW + slotW / 2;
    const barH = (mins / maxMins) * chartH;
    const y    = padT + chartH - barH;

    // Bar
    if (mins > 0) {
      ctx.fillStyle   = cPrimary + '44';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x - slotW * 0.3, y, slotW * 0.6, barH, 4);
      } else {
        ctx.rect(x - slotW * 0.3, y, slotW * 0.6, barH);
      }
      ctx.fill();

      // Dot at top
      ctx.fillStyle = cPrimary;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, 2 * Math.PI);
      ctx.fill();
    } else {
      ctx.fillStyle = cText3 + '88';
      ctx.beginPath();
      ctx.arc(x, padT + chartH, 3, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Parse day as UTC noon to avoid timezone-drift day-shift issues
    const dayLabel = new Date(day + 'T12:00:00Z').toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' });
    ctx.fillStyle  = cText3;
    ctx.font       = '10px Inter, sans-serif';
    ctx.textAlign  = 'center';
    ctx.fillText(dayLabel, x, H - 6);
  });
}

function renderSessionList(sessions) {
  const list    = el('sessionList');
  const recent  = [...sessions].reverse().slice(0, 10);

  if (recent.length === 0) {
    list.innerHTML = '<li class="session-item empty">No sessions yet — get after it! 🎯</li>';
    return;
  }

  list.innerHTML = recent.map(s => `
    <li class="session-item">
      <span class="session-badge ${s.completed ? 'completed' : 'incomplete'}">
        ${s.completed ? '✓' : '–'}
      </span>
      <div class="session-info">
        <div class="session-type">${escHtml(s.type)}</div>
        <div class="session-meta">${escHtml(s.date)} · ${s.duration_minutes}m</div>
      </div>
    </li>
  `).join('');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════════════════════════════════════
   SETTINGS PANEL
════════════════════════════════════════════════════════════════════════════ */

function applySettingsToUI() {
  el('defaultPresetSel').value = state.settings.defaultPreset;
  el('pomoWorkMins').value     = state.settings.pomoWorkMins;
  el('pomoBreakMins').value    = state.settings.pomoBreakMins;
  el('soundToggle').checked    = !state.settings.muted;
  el('lightThemeToggle').checked = state.settings.lightTheme;
  el('syncEndpoint').value     = state.settings.syncEndpoint || '';
  updateMuteUI();
  updateThemeUI();
  updateSyncQueueLabel();
}

/* ════════════════════════════════════════════════════════════════════════════
   EVENT WIRING
════════════════════════════════════════════════════════════════════════════ */

function initEvents() {

  // ── Play / Pause ────────────────────────────────────────────────
  el('playPauseBtn').addEventListener('click', () => {
    // Resume audio context on first user interaction (browser requirement)
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
    if (state.running) pauseTimer();
    else startTimer();
  });

  // ── Reset ───────────────────────────────────────────────────────
  el('resetBtn').addEventListener('click', () => resetTimer());

  // ── Bail Out ────────────────────────────────────────────────────
  el('bailBtn').addEventListener('click', bailOut);

  // ── Dismiss completion ──────────────────────────────────────────
  el('dismissBtn').addEventListener('click', hideCompletionOverlay);

  // ── Mode toggle ─────────────────────────────────────────────────
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      state.mode = mode;
      document.querySelectorAll('.mode-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === mode)
      );
      resetTimer();
    });
  });

  // ── Presets ─────────────────────────────────────────────────────
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setPreset(btn.dataset.preset);
    });
  });

  // ── Custom apply ────────────────────────────────────────────────
  el('applyCustomBtn').addEventListener('click', () => {
    setPreset('custom');
  });

  // ── Tab navigation ───────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;

      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === target);
        b.setAttribute('aria-selected', String(b.dataset.tab === target));
      });

      document.querySelectorAll('.tab-panel').forEach(panel => {
        const isActive = panel.id === `tab-${target}`;
        panel.classList.toggle('active', isActive);
        panel.classList.toggle('hidden', !isActive);
      });

      if (target === 'stats') renderStats();
    });
  });

  // ── Mute button (topbar) ────────────────────────────────────────
  el('muteBtn').addEventListener('click', () => {
    state.settings.muted = !state.settings.muted;
    if (state.settings.muted) stopAlarm();
    saveSettings();
    updateMuteUI();
  });

  // ── Theme button (topbar) ───────────────────────────────────────
  el('themeBtn').addEventListener('click', () => {
    state.settings.lightTheme = !state.settings.lightTheme;
    saveSettings();
    updateThemeUI();
  });

  // ── Settings — default preset ────────────────────────────────────
  el('defaultPresetSel').addEventListener('change', (e) => {
    state.settings.defaultPreset = e.target.value;
    saveSettings();
  });

  // ── Settings — Pomodoro work ──────────────────────────────────────
  el('pomoWorkMins').addEventListener('change', (e) => {
    state.settings.pomoWorkMins = Math.max(1, parseInt(e.target.value, 10) || 25);
    state.pomoWorkSecs = state.settings.pomoWorkMins * 60;
    saveSettings();
    if (state.preset === 'pomodoro') {
      state.totalSeconds     = state.pomoWorkSecs;
      state.remainingSeconds = state.pomoWorkSecs;
      updateTimerDisplay();
    }
  });

  // ── Settings — Pomodoro break ─────────────────────────────────────
  el('pomoBreakMins').addEventListener('change', (e) => {
    state.settings.pomoBreakMins = Math.max(1, parseInt(e.target.value, 10) || 5);
    state.pomoBreakSecs = state.settings.pomoBreakMins * 60;
    saveSettings();
  });

  // ── Settings — sound toggle ───────────────────────────────────────
  el('soundToggle').addEventListener('change', (e) => {
    state.settings.muted = !e.target.checked;
    if (state.settings.muted) stopAlarm();
    saveSettings();
    updateMuteUI();
  });

  // ── Settings — light theme ────────────────────────────────────────
  el('lightThemeToggle').addEventListener('change', (e) => {
    state.settings.lightTheme = e.target.checked;
    saveSettings();
    updateThemeUI();
  });

  // ── Settings — sync endpoint ──────────────────────────────────────
  el('syncEndpoint').addEventListener('change', (e) => {
    state.settings.syncEndpoint = e.target.value.trim();
    saveSettings();
  });

  // ── Settings — sync now ───────────────────────────────────────────
  el('syncNowBtn').addEventListener('click', async () => {
    const btn = el('syncNowBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    await attemptSync();
    btn.disabled = false;
    btn.textContent = state.syncQueue.length === 0 ? 'Synced ✓' : 'Sync Now';
    setTimeout(() => { btn.textContent = 'Sync Now'; }, 3000);
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   SERVICE WORKER REGISTRATION
════════════════════════════════════════════════════════════════════════════ */

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./service-worker.js')
        .catch(() => { /* Service Worker registration failed — not critical */ });
    });
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   ICONS — generate SVG data-URL icons so the PWA has icons even without
   real PNG files in the repo (optional PNG files override these).
════════════════════════════════════════════════════════════════════════════ */

function injectFallbackIcons() {
  // Only inject if the icons don't load (handled gracefully by the browser)
  // We patch the manifest link to point to inline SVG icons if PNG is missing.
  const svgSrc = `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
      <rect width="192" height="192" rx="40" fill="#2D4222"/>
      <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
            font-family="Inter,sans-serif" font-weight="900" font-size="88"
            fill="#FF4F00">10</text>
      <text x="50%" y="82%" dominant-baseline="middle" text-anchor="middle"
            font-family="Inter,sans-serif" font-weight="900" font-size="44"
            fill="#FF4F00">-4</text>
    </svg>`)}`;

  // Set apple-touch-icon as inline SVG fallback
  const touchIcon = document.querySelector('link[rel="apple-touch-icon"]');
  if (touchIcon) touchIcon.href = svgSrc;

  const favIcon = document.querySelector('link[rel="icon"]');
  if (favIcon) favIcon.href = svgSrc;
}

/* ════════════════════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════════════════════ */

function init() {
  loadStorage();
  applySettingsToUI();
  injectFallbackIcons();

  // Apply saved settings
  state.mode = 'countdown';
  state.pomoWorkSecs  = state.settings.pomoWorkMins  * 60;
  state.pomoBreakSecs = state.settings.pomoBreakMins * 60;

  // Load default preset from settings
  const initialPreset = (new URLSearchParams(location.search).get('preset')) ||
                         state.settings.defaultPreset || 'focus';
  setPreset(initialPreset);

  // Boot UI
  updateTimerDisplay();
  updateTopoFill(0);
  updateControlsUI();
  updateMuteUI();
  updateThemeUI();

  // Wire events
  initEvents();

  // Try to sync any queued sessions from last session
  attemptSync();

  // Register SW
  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);
