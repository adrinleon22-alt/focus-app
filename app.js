// =====================================================================
// STORAGE
// Everything is saved under one key in localStorage (see PLAN.md).
// =====================================================================

const STORAGE_KEY = "studytracker.v1";

const DEFAULT_GOAL_MINUTES = 120; // 2 hours a day

// Read all data. If nothing is saved yet, start with an empty structure.
function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  const data = raw ? JSON.parse(raw) : { sessions: [], activeSession: null };
  // Daily goal history (added later, so older data may not have it yet).
  // Each entry means "from this day on, the goal is X minutes".
  // from: "" = since the very beginning.
  if (!Array.isArray(data.goals) || data.goals.length === 0) {
    data.goals = [{ from: "", minutes: DEFAULT_GOAL_MINUTES }];
  }
  // Remembered choices: Stopwatch or Timer, and the last study time used.
  data.settings = Object.assign({ mode: "stopwatch", timerMinutes: 120 }, data.settings);
  return data;
}

// Write all data back. Called right after every change.
function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// Make a unique id for a saved session, e.g. "lq3k9x2a-4f8h1".
// (We don't use crypto.randomUUID() because it doesn't work when the
// page is opened over plain http on the local network.)
function makeId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

// =====================================================================
// TIMER
// The running session looks like this while active:
//   { task, subject, start, pausedMs, pausedAt }
//   start    = when Start was tapped (ISO time string)
//   pausedMs = total milliseconds spent paused so far
//   pausedAt = when the current pause began, or null if not paused
// We never count seconds up. We always compute from timestamps,
// so the time stays correct even if the phone sleeps.
// =====================================================================

// How many milliseconds of real work the session has so far.
function elapsedMs(session) {
  // If paused right now, "now" is frozen at the moment the pause began.
  const now = session.pausedAt ? Date.parse(session.pausedAt) : Date.now();
  return now - Date.parse(session.start) - session.pausedMs;
}

// Turn milliseconds into "H:MM:SS", e.g. 3725000 -> "1:02:05"
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// =====================================================================
// TIMER MODE: count down a planned study time, with breaks in between.
//
// Planning (based on the research we looked at):
//  - focus blocks between 25 and 90 minutes, recommended ~45 minutes
//  - break length depends on the block: up to 30 min -> 5 min break,
//    up to 60 min -> 10 min, longer -> 15 min
//  - the study time you type is FOCUS time; breaks come on top
//
// While running, the active session looks like this:
//   { mode: "timer", task, plan: { focus: [40, 40, 40], breakMin: 10 },
//     phase,       // 0 = focus 1, 1 = break, 2 = focus 2, ...
//     start,       // when the CURRENT phase started
//     pausedMs, pausedAt,   // pause info for the current phase
//     studiedMs,   // focus time already saved
//     savedIds }   // ids of the focus blocks saved so far
// Every finished focus block is saved as its own session.
// =====================================================================

const MIN_BLOCK = 25; // shortest focus block we suggest
const MAX_BLOCK = 90; // longest focus block we suggest
const IDEAL_BLOCK = 45; // what the recommended option aims for

// Break length for a focus block of this many minutes.
function breakFor(blockMinutes) {
  if (blockMinutes <= 30) return 5;
  if (blockMinutes <= 60) return 10;
  return 15;
}

// Split minutes into equal whole-minute parts, e.g. 100 into 3 -> [34, 33, 33]
function splitMinutes(total, parts) {
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

// All sensible plans for a study time, e.g. 120 -> 1, 2 (recommended) or 3 breaks.
// Returns [{ breaks, focus: [..minutes], breakMin, totalMin, recommended }]
function planOptions(studyMinutes) {
  const minBreaks = Math.max(0, Math.ceil(studyMinutes / MAX_BLOCK) - 1);
  const maxBreaks = Math.max(minBreaks, Math.floor(studyMinutes / MIN_BLOCK) - 1);
  const recBreaks = Math.min(maxBreaks, Math.max(minBreaks, Math.round(studyMinutes / IDEAL_BLOCK) - 1));
  // Show at most 5 options, centred on the recommended one
  const from = Math.max(minBreaks, Math.min(recBreaks - 2, maxBreaks - 4));
  const to = Math.min(maxBreaks, from + 4);
  const options = [];
  for (let n = from; n <= to; n++) {
    const focus = splitMinutes(studyMinutes, n + 1);
    const breakMin = n === 0 ? 0 : breakFor(Math.max(...focus));
    options.push({ breaks: n, focus, breakMin, totalMin: studyMinutes + n * breakMin, recommended: n === recBreaks });
  }
  return options;
}

// The plan as a list of phases: focus, break, focus, break, ..., focus
function phasesOf(plan) {
  const phases = [];
  plan.focus.forEach((min, i) => {
    if (i > 0) phases.push({ type: "break", min: plan.breakMin });
    phases.push({ type: "focus", min: min, number: i + 1 });
  });
  return phases;
}

// Move a running timer forward through every phase that has already ended
// (also catches up if the app was closed or the phone was asleep).
// Changes `data` in place. Returns { changed, finished }.
function advanceTimer(data) {
  const t = data.activeSession;
  const phases = phasesOf(t.plan);
  let changed = false;
  while (!t.pausedAt && t.phase < phases.length) {
    const phase = phases[t.phase];
    const endsAt = Date.parse(t.start) + phase.min * 60000 + t.pausedMs;
    if (Date.now() < endsAt) break; // current phase still running
    if (phase.type === "focus") {
      // Save the finished focus block with its real start and end time
      const block = {
        id: makeId(), task: t.task, subject: "",
        start: t.start, end: new Date(endsAt).toISOString(),
        pausedMs: t.pausedMs, note: "",
      };
      data.sessions.push(block);
      t.savedIds.push(block.id);
      t.studiedMs += phase.min * 60000;
    }
    t.phase++;
    t.start = new Date(endsAt).toISOString(); // next phase starts right away
    t.pausedMs = 0;
    changed = true;
  }
  return { changed: changed, finished: t.phase >= phases.length };
}

// ---- Beep + vibrate when a phase changes, and keep the screen on ----
let audioCtx = null;
let wakeLock = null;

// Browsers only allow sound after a tap, so this runs when Start is tapped.
function unlockSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch (error) { /* no sound available: fine */ }
}

// Two short beeps and a vibration.
function signal() {
  try {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if (!audioCtx) return;
    [0, 0.25].forEach((delay) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 880; // a clear "A" tone
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + delay);
      osc.stop(audioCtx.currentTime + delay + 0.2);
    });
  } catch (error) { /* ignore */ }
}

// Ask the phone to keep the screen on while the timer runs (where supported).
async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (error) { /* not supported or not allowed: fine */ }
}

function allowScreenOff() {
  if (wakeLock) wakeLock.release();
  wakeLock = null;
}

// The timer finished all its blocks: show the summary and the note box.
function finishTimer(data) {
  const t = data.activeSession;
  data.activeSession = null;
  saveData(data);
  allowScreenOff();
  signal();
  openNoteCard(t.savedIds[t.savedIds.length - 1],
    "Done: " + t.task + " – " + formatDuration(t.studiedMs) + " in " + t.savedIds.length +
    (t.savedIds.length === 1 ? " block" : " blocks"));
  render();
}

// ---- Home screen: Stopwatch / Timer choice and the break options ----
let chosenBreaks = null; // null = use the recommended option

function setMode(mode) {
  const data = loadData();
  data.settings.mode = mode;
  saveData(data);
  render();
}

// Study minutes typed in the box (or the saved value if the box is empty/invalid)
function typedStudyMinutes() {
  const n = Math.round(Number(timerMinutesInput.value));
  return n >= 10 && n <= 600 ? n : null;
}

function renderPlanOptions() {
  planOptionsBox.innerHTML = ""; // remove the old options
  const minutes = typedStudyMinutes();
  if (!minutes) {
    const hint = document.createElement("p");
    hint.className = "muted small";
    hint.textContent = "Enter between 10 and 600 minutes.";
    planOptionsBox.appendChild(hint);
    return;
  }
  const options = planOptions(minutes);
  const chosen = options.find((o) => o.breaks === chosenBreaks) || options.find((o) => o.recommended);
  for (const o of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plan-option" + (o === chosen ? " chosen" : "");
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", o === chosen ? "true" : "false");
    const title = document.createElement("span");
    title.className = "plan-title";
    title.textContent = (o.breaks === 0 ? "No breaks" : o.breaks + (o.breaks === 1 ? " break" : " breaks")) +
      (o.recommended ? "  ⭐ recommended" : "");
    const detail = document.createElement("span");
    detail.className = "plan-detail";
    const sameLength = o.focus.every((m) => m === o.focus[0]);
    const blocks = sameLength ? o.focus.length + " × " + o.focus[0] + " min" : o.focus.join(" + ") + " min";
    detail.textContent = blocks + (o.breaks ? " · " + o.breakMin + " min breaks" : "") +
      " · " + formatAxisMinutes(o.totalMin) + " total";
    btn.append(title, detail);
    btn.addEventListener("click", () => {
      chosenBreaks = o.breaks;
      renderPlanOptions();
    });
    planOptionsBox.appendChild(btn);
  }
}

function startSession() {
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.focus(); // no task typed: put the cursor in the box instead
    return;
  }
  const data = loadData();
  const now = new Date().toISOString();

  if (data.settings.mode === "timer") {
    const minutes = typedStudyMinutes();
    if (!minutes) {
      timerMinutesInput.focus();
      return;
    }
    const options = planOptions(minutes);
    const plan = options.find((o) => o.breaks === chosenBreaks) || options.find((o) => o.recommended);
    data.settings.timerMinutes = minutes; // remember for next time
    data.activeSession = {
      mode: "timer", task: task,
      plan: { focus: plan.focus, breakMin: plan.breakMin },
      phase: 0, start: now, pausedMs: 0, pausedAt: null,
      studiedMs: 0, savedIds: [],
    };
    unlockSound();
    keepScreenOn();
  } else {
    data.activeSession = { task: task, start: now, pausedMs: 0, pausedAt: null };
  }
  saveData(data); // save immediately so a refresh loses nothing
  taskInput.value = "";
  closeNoteCard(); // hide the last "Saved / what did you get done?" card
  render();
}

// One button does both: pause if running, resume if paused.
function togglePause() {
  const data = loadData();
  const session = data.activeSession;
  if (!session) return;

  if (session.pausedAt) {
    // Resume: add the length of this pause to the total paused time.
    session.pausedMs += Date.now() - Date.parse(session.pausedAt);
    session.pausedAt = null;
  } else {
    // Pause: remember when it started.
    session.pausedAt = new Date().toISOString();
  }
  saveData(data);
  render();
}

function stopSession() {
  const data = loadData();
  const session = data.activeSession;
  if (!session) return;

  if (session.mode === "timer") {
    stopTimerEarly(data);
    return;
  }

  const now = Date.now();
  let pausedMs = session.pausedMs;
  // Stopped while paused: the current pause also counts as paused time.
  if (session.pausedAt) {
    pausedMs += now - Date.parse(session.pausedAt);
  }

  // The finished session, in the shape described in PLAN.md.
  // (Subject is no longer asked for; older sessions may still have one.
  //  note = "What did you get done?", filled in right after Stop.)
  const finished = {
    id: makeId(),
    task: session.task,
    subject: session.subject || "",
    start: session.start,
    end: new Date(now).toISOString(),
    pausedMs: pausedMs,
    note: "",
  };

  data.sessions.push(finished);
  data.activeSession = null;
  saveData(data); // session saved and timer cleared in one write

  const duration = now - Date.parse(finished.start) - finished.pausedMs;
  openNoteCard(finished.id, "Saved: " + finished.task + " – " + formatDuration(duration));
  render();
}

// Stop pressed in Timer mode: save the blocks that ended, plus the part of
// the current focus block done so far. A break that's cut short adds nothing.
function stopTimerEarly(data) {
  advanceTimer(data); // first save anything that already finished
  const t = data.activeSession;
  const phases = phasesOf(t.plan);
  const phase = phases[t.phase];
  if (phase && phase.type === "focus") {
    const now = Date.now();
    const end = t.pausedAt ? Date.parse(t.pausedAt) : now;
    const pausedMs = t.pausedMs + (t.pausedAt ? now - Date.parse(t.pausedAt) : 0);
    const worked = end - Date.parse(t.start) - t.pausedMs;
    if (worked >= 1000) { // ignore an accidental tap right after a block started
      const block = {
        id: makeId(), task: t.task, subject: "",
        start: t.start, end: new Date(now).toISOString(),
        pausedMs: pausedMs, note: "",
      };
      data.sessions.push(block);
      t.savedIds.push(block.id);
      t.studiedMs += worked;
    }
  }
  if (t.savedIds.length === 0) {
    // Nothing worth saving
    data.activeSession = null;
    saveData(data);
    allowScreenOff();
    openNoteCard(null, "Stopped – nothing saved.");
    noteForm.hidden = true; // no session to attach a note to
    render();
    return;
  }
  finishTimer(data);
}

// ---- "What did you get done?" card on the home screen, shown after Stop ----
let noteSessionId = null; // which session the note belongs to

function openNoteCard(sessionId, savedText) {
  noteSessionId = sessionId;
  savedMessage.textContent = savedText;
  noteInput.value = "";
  noteForm.hidden = false;
  noteCard.hidden = false;
}

function closeNoteCard() {
  noteSessionId = null;
  noteCard.hidden = true;
}

// Save the note into the session it belongs to, then keep only the "Saved" line.
function saveNote() {
  const text = noteInput.value.trim();
  if (text && noteSessionId) {
    const data = loadData();
    const s = data.sessions.find((x) => x.id === noteSessionId);
    if (s) {
      s.note = text;
      saveData(data);
    }
    savedMessage.textContent += " · note saved ✓";
  }
  noteForm.hidden = true; // the box goes away, the "Saved" line stays
}

// Skip: no note, just fold the box away.
function skipNote() {
  noteForm.hidden = true;
}

// The last few different tasks, newest first, for the quick-pick buttons.
function getRecentTasks(sessions, howMany) {
  const recent = [];
  const seen = new Set();
  // Walk the sessions from newest to oldest.
  for (let i = sessions.length - 1; i >= 0 && recent.length < howMany; i--) {
    const s = sessions[i];
    if (!seen.has(s.task)) {
      seen.add(s.task);
      recent.push({ task: s.task, subject: s.subject });
    }
  }
  return recent;
}

// =====================================================================
// TOTALS (used by the Today screen, and later by History)
// =====================================================================

// Work time of one saved session.
function sessionDuration(s) {
  return Date.parse(s.end) - Date.parse(s.start) - s.pausedMs;
}

// The LOCAL calendar day of a moment, as "2026-11-12".
// getFullYear/getMonth/getDate use the phone's own time zone (Berlin),
// not UTC. That's why we don't just cut the ISO string.
function localDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0"); // months start at 0
  const d = String(date.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

// Sessions that STARTED on the given local day. A session from
// 23:30 to 00:30 counts fully for the day it started (option A).
function sessionsOnDay(sessions, dayKey) {
  return sessions.filter((s) => localDayKey(new Date(s.start)) === dayKey);
}

// Add up sessions with the same task name.
// Returns [{ task, subject, ms }], most time first.
function totalsByTask(sessions) {
  const byTask = new Map();
  for (const s of sessions) {
    if (!byTask.has(s.task)) {
      byTask.set(s.task, { task: s.task, subject: s.subject, ms: 0 });
    }
    const entry = byTask.get(s.task);
    entry.ms += sessionDuration(s);
    if (s.subject) entry.subject = s.subject; // keep the latest subject used
  }
  return [...byTask.values()].sort((a, b) => b.ms - a.ms);
}

function sumDurations(sessions) {
  return sessions.reduce((total, s) => total + sessionDuration(s), 0);
}

// The goal (in minutes) that applied on a given day: the newest entry
// that started on or before that day. So changing the goal today never
// changes how past days are judged.
function goalForDay(goals, dayKey) {
  let minutes = goals[0].minutes;
  for (const g of goals) {
    if (g.from <= dayKey) minutes = g.minutes; // goals are kept sorted by date
  }
  return minutes;
}

// Change the goal from TODAY on. Past days keep their old goal.
function setGoalFromToday(minutes) {
  const data = loadData();
  const today = localDayKey(new Date());
  data.goals = data.goals.filter((g) => g.from !== today); // changed twice today: keep the last
  data.goals.push({ from: today, minutes: minutes });
  data.goals.sort((a, b) => (a.from < b.from ? -1 : 1));
  saveData(data);
}

// The first day with any session ("" if there are none). Days before it are shown blank.
function firstSessionDay(sessions) {
  let first = "";
  for (const s of sessions) {
    const key = localDayKey(new Date(s.start));
    if (first === "" || key < first) first = key;
  }
  return first;
}

// How a day did against its goal:
// "met", "missed", "today" (still in progress), "future", or "blank" (before you started).
function dayStatus(dayKey, ms, goalMinutes, today, firstDay) {
  const met = ms >= goalMinutes * 60000;
  if (dayKey > today) return "future";
  if (dayKey === today) return met ? "met" : "today";
  if (firstDay === "" || dayKey < firstDay) return "blank";
  return met ? "met" : "missed";
}

// Sort sessions into days. Returns [{ dayKey, sessions }], newest day first.
// Inside each day, sessions are in time order (earliest first).
function groupByDay(sessions) {
  const byDay = new Map();
  for (const s of sessions) {
    const key = localDayKey(new Date(s.start));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(s);
  }
  const days = [];
  for (const [dayKey, daySessions] of byDay) {
    daySessions.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    days.push({ dayKey: dayKey, sessions: daySessions });
  }
  // "2026-11-12" style keys sort correctly as plain text
  days.sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));
  return days;
}

// "2026-11-12" -> "Thu, 12 Nov" (or "Do., 12. Nov." on a German phone).
// The year is only shown for days in another year.
function formatDayKey(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const date = new Date(y, m - 1, d); // local date, not UTC
  const options = { weekday: "short", day: "numeric", month: "short" };
  if (y !== new Date().getFullYear()) options.year = "numeric";
  return date.toLocaleDateString(undefined, options);
}

// ISO time -> local clock time like "14:05"
function formatClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// "Statistik Blatt 3" plus a grey " · Statistik" if there is a subject.
// Built with textContent so task names always show as plain text.
function taskLabel(task, subject) {
  const span = document.createElement("span");
  span.textContent = task;
  if (subject) {
    const tag = document.createElement("span");
    tag.className = "muted";
    tag.textContent = " · " + subject;
    span.appendChild(tag);
  }
  return span;
}

// =====================================================================
// SCREENS
// =====================================================================

const homeScreen = document.getElementById("home-screen");
const timerScreen = document.getElementById("timer-screen");
const taskInput = document.getElementById("task-input");
const timerTask = document.getElementById("timer-task");
const timerDisplay = document.getElementById("timer-display");
const timerStatus = document.getElementById("timer-status");
const pauseBtn = document.getElementById("pause-btn");
const recentTasksBox = document.getElementById("recent-tasks");
const timerPhase = document.getElementById("timer-phase");
const dial = document.getElementById("dial");
const dialSvg = document.getElementById("dial-svg");
const waterLevel = document.getElementById("water-level");
const timerProgress = document.getElementById("timer-progress");
const modeStopwatch = document.getElementById("mode-stopwatch");
const modeTimer = document.getElementById("mode-timer");
const timerSetup = document.getElementById("timer-setup");
const timerMinutesInput = document.getElementById("timer-minutes");
const planOptionsBox = document.getElementById("plan-options");
const savedMessage = document.getElementById("saved-message");
const noteCard = document.getElementById("note-card");
const noteForm = document.getElementById("note-form");
const noteInput = document.getElementById("note-input");

const todayScreen = document.getElementById("today-screen");
const homeTodayTotal = document.getElementById("home-today-total");
const homeTodayLabel = document.getElementById("home-today-label");
const homeRing = document.getElementById("home-ring");
const todayTotal = document.getElementById("today-total");
const todayEmpty = document.getElementById("today-empty");
const todayList = document.getElementById("today-list");

const historyEmpty = document.getElementById("history-empty");
const historyList = document.getElementById("history-list");
const dayTitle = document.getElementById("day-title");
const dayTotal = document.getElementById("day-total");
const dayTimeline = document.getElementById("day-timeline");

// All screens that are not the timer, by name.
const screens = {
  home: homeScreen,
  today: todayScreen,
  history: document.getElementById("history-screen"),
  day: document.getElementById("day-screen"),
  edit: document.getElementById("edit-screen"),
  stats: document.getElementById("stats-screen"),
};

// Which screen to show when no timer is running: a name from `screens`.
// (While a session runs, the timer screen always wins.)
let currentView = "home";
// Which day the day screen shows, e.g. "2026-11-12".
let selectedDay = null;

// Going DEEPER (Home -> History -> Day -> Edit): remember the step in the
// browser history, so the phone's back gesture can undo it.
function openView(view) {
  navDepth++;
  history.pushState({ view: view, depth: navDepth }, "");
  showView(view);
}

// How many steps deep we are from Home (0 = on Home).
let navDepth = 0;
// Set when the Stats tab is tapped from somewhere other than Home:
// we first go back to Home, then open Stats.
let openStatsAfterBack = false;

// Bottom bar: jump to the main screen of a tab.
// Stats is always exactly 1 step from Home, so we can step back to it.
function goTab(tab) {
  if (tab === "home") {
    if (navDepth > 0) history.go(-navDepth);
    return;
  }
  // tab === "stats"
  if (currentView === "stats") return;
  const insideStats = ["history", "day", "edit"].includes(currentView);
  if (insideStats && navDepth > 1) {
    history.go(-(navDepth - 1)); // back to the Stats screen
  } else if (navDepth > 0) {
    openStatsAfterBack = true; // e.g. from the Today screen: Home first
    history.go(-navDepth);
  } else {
    openStats();
  }
}

// Going BACK: all Back buttons call this, exactly like the back gesture.
function goBack(steps = 1) {
  history.go(-steps);
}

// Show a screen without touching the browser history.
function showView(view) {
  // Opening a day fresh (not coming back from editing): scroll it again
  if (view === "day" && currentView !== "day" && currentView !== "edit") lastScrolledDay = null;
  currentView = view;
  window.scrollTo(0, 0);
  render();
}

// Show the right screen for the current state.
function render() {
  const data = loadData();
  const session = data.activeSession;

  // Hide every screen except the one we want.
  for (const name in screens) {
    screens[name].hidden = !!session || currentView !== name;
  }
  timerScreen.hidden = !session;

  // Bottom bar: hidden while the timer runs and on the Edit screen.
  const showNav = !session && currentView !== "edit";
  bottomNav.hidden = !showNav;
  document.body.classList.toggle("nav-visible", showNav);
  const statsTab = ["stats", "history", "day", "edit"].includes(currentView);
  navHome.classList.toggle("active", !statsTab);
  navStats.classList.toggle("active", statsTab);
  navHome.setAttribute("aria-current", statsTab ? "false" : "page");
  navStats.setAttribute("aria-current", statsTab ? "page" : "false");

  if (!session) {
    const today = sessionsOnDay(data.sessions, localDayKey(new Date()));
    if (currentView === "home") {
      const todayMs = sumDurations(today);
      const goal = goalForDay(data.goals, localDayKey(new Date()));
      homeTodayTotal.textContent = formatDuration(todayMs);
      homeTodayLabel.textContent = "Today · goal " + formatAxisMinutes(goal) +
        (todayMs >= goal * 60000 ? " ✓" : "");
      drawRing(homeRing, todayMs / (goal * 60000));
      renderRecentTasks(data.sessions);
      renderModeChoice(data);
    } else if (currentView === "today") {
      renderToday(today);
    } else if (currentView === "history") {
      renderHistory(data.sessions);
    } else if (currentView === "day") {
      renderDay(selectedDay, sessionsOnDay(data.sessions, selectedDay));
    } else if (currentView === "stats") {
      renderStats(data);
    }
    // "edit" needs nothing here: openEdit() filled the form once already.
  }

  if (session) {
    timerTask.textContent = session.task;
    pauseBtn.textContent = session.pausedAt ? "Resume" : "Pause";
    timerStatus.textContent = session.pausedAt ? "Paused" : "";
    updateTimerDisplay();
  }
}

// Home screen bits for Stopwatch / Timer mode.
function renderModeChoice(data) {
  const timerMode = data.settings.mode === "timer";
  modeStopwatch.classList.toggle("active", !timerMode);
  modeTimer.classList.toggle("active", timerMode);
  timerSetup.hidden = !timerMode;
  // Fill in the remembered study time, but never overwrite what you're typing
  if (timerMode && document.activeElement !== timerMinutesInput && !timerMinutesInput.value) {
    timerMinutesInput.value = data.settings.timerMinutes;
  }
  if (timerMode) renderPlanOptions();
}

// Fill the Today screen: big total plus one row per task.
function renderToday(todaySessions) {
  todayTotal.textContent = formatDuration(sumDurations(todaySessions));
  todayEmpty.hidden = todaySessions.length > 0;
  renderTaskTotals(todayList, todaySessions);
}

// Fill a list with one row per task: "Statistik Blatt 3 · Statistik   1:00:00".
// Used by the Today screen and the Stats screen.
function renderTaskTotals(listElement, sessions) {
  listElement.innerHTML = ""; // remove the old rows
  for (const item of totalsByTask(sessions)) {
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatDuration(item.ms);
    li.append(taskLabel(item.task, item.subject), time);
    listElement.appendChild(li);
  }
}

// Fill the "All days" screen: one tappable card per day, newest first.
function renderHistory(sessions) {
  const days = groupByDay(sessions);
  historyEmpty.hidden = days.length > 0;
  historyList.innerHTML = ""; // remove the old cards
  for (const day of days) historyList.appendChild(buildDayCard(day));
}

// One day as a tappable card: date + total, then time per task.
// Tapping it opens that day's sessions (where you can edit them).
// Used on the Stats screen (recent days) and the All days screen.
function buildDayCard(day) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "day-card";

  // Header line: date on the left, day total on the right
  const header = document.createElement("span");
  header.className = "day-card-header";
  const date = document.createElement("span");
  date.textContent = formatDayKey(day.dayKey);
  const total = document.createElement("span");
  total.className = "time";
  total.textContent = formatDuration(sumDurations(day.sessions));
  header.append(date, total);
  card.appendChild(header);

  // One small row per task
  for (const item of totalsByTask(day.sessions)) {
    const row = document.createElement("span");
    row.className = "day-card-row";
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatDuration(item.ms);
    row.append(taskLabel(item.task, item.subject), time);
    card.appendChild(row);
  }

  card.addEventListener("click", () => {
    selectedDay = day.dayKey;
    openView("day");
  });
  return card;
}

// ---- Day screen: a calendar-style timeline from 00:00 to 24:00 ----
const HOUR_PX = 96; // height of one hour on screen (5 minutes = 8px)
const MIN_BLOCK_PX = 24; // very short sessions still get a tappable block
let lastScrolledDay = null; // so we only auto-scroll when a new day is opened

// Minutes since midnight of the given day, e.g. 14:30 -> 870.
// Can be above 1440 for a session that runs past midnight.
function minutesIntoDay(iso, dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return (Date.parse(iso) - new Date(y, m - 1, d).getTime()) / 60000;
}

// Give overlapping sessions side-by-side columns (like a calendar does).
// Returns [{ session, top, bottom, col, cols }].
function layoutBlocks(daySessions, dayKey) {
  const items = daySessions
    .map((s) => ({
      session: s,
      top: Math.max(0, minutesIntoDay(s.start, dayKey)),
      bottom: Math.min(1440, minutesIntoDay(s.end, dayKey)),
    }))
    .sort((a, b) => a.top - b.top);

  // Walk through in time order; a "group" is a run of blocks that overlap.
  let group = [];
  let groupEnd = -1;
  const finishGroup = () => {
    const cols = Math.max(...group.map((it) => it.col)) + 1;
    for (const it of group) it.cols = cols;
  };
  for (const it of items) {
    if (it.top >= groupEnd && group.length) { finishGroup(); group = []; }
    // First column whose last block has already ended
    const used = group.filter((g) => g.bottom > it.top).map((g) => g.col);
    let col = 0;
    while (used.includes(col)) col++;
    it.col = col;
    group.push(it);
    groupEnd = Math.max(groupEnd, it.bottom);
  }
  if (group.length) finishGroup();
  return items;
}

// Fill the day screen: title, total, and the timeline with one block per session.
function renderDay(dayKey, daySessions) {
  dayTitle.textContent = formatDayKey(dayKey);
  dayTotal.textContent = formatDuration(sumDurations(daySessions)) + " focused";

  const sheet = document.createElement("div");
  sheet.className = "timeline-sheet";
  dayTimeline.style.setProperty("--hour", HOUR_PX + "px");

  // Hour lines with labels, and a faint line every half hour
  for (let h = 0; h < 24; h++) {
    const line = document.createElement("div");
    line.className = "tl-hour";
    line.style.top = h * HOUR_PX + "px";
    const label = document.createElement("span");
    label.textContent = String(h).padStart(2, "0") + ":00";
    line.appendChild(label);
    const half = document.createElement("div");
    half.className = "tl-half";
    half.style.top = (h + 0.5) * HOUR_PX + "px";
    sheet.append(line, half);
  }

  // One block per session, placed by its start and end time
  for (const it of layoutBlocks(daySessions, dayKey)) {
    const s = it.session;
    const block = document.createElement("button");
    block.type = "button";
    block.className = "tl-block";
    const topPx = (it.top / 60) * HOUR_PX;
    const heightPx = Math.max(MIN_BLOCK_PX, ((it.bottom - it.top) / 60) * HOUR_PX - 2);
    block.style.top = topPx + "px";
    block.style.height = heightPx + "px";
    block.style.left = "calc(" + (it.col / it.cols) * 100 + "% + 4px)";
    block.style.width = "calc(" + 100 / it.cols + "% - 8px)";

    const task = document.createElement("span");
    task.className = "tl-task";
    task.textContent = s.task; // textContent: always plain text
    const time = document.createElement("span");
    time.className = "tl-time";
    time.textContent = formatClock(s.start) + "–" + formatClock(s.end) + " · " + formatDuration(sessionDuration(s));
    block.append(task, time);
    if (s.note) {
      const note = document.createElement("span");
      note.className = "tl-note";
      note.textContent = s.note;
      block.appendChild(note);
    }
    block.setAttribute("aria-label", s.task + ", " + time.textContent + (s.note ? ", " + s.note : ""));
    block.addEventListener("click", (event) => {
      event.stopPropagation(); // don't also count as a tap on empty space
      openEdit(s.id);
    });
    sheet.appendChild(block);
  }

  // Red "now" line on today
  const isToday = dayKey === localDayKey(new Date());
  if (isToday) {
    const now = document.createElement("div");
    now.className = "tl-now";
    now.style.top = (minutesIntoDay(new Date().toISOString(), dayKey) / 60) * HOUR_PX + "px";
    sheet.appendChild(now);
  }

  // Tap on empty space: add a session starting there (rounded to 5 minutes)
  sheet.addEventListener("click", (event) => {
    const y = event.clientY - sheet.getBoundingClientRect().top;
    const minutes = Math.min(1435, Math.max(0, Math.floor((y / HOUR_PX) * 12) * 5));
    openNewSession(dayKey, minutes);
  });

  dayTimeline.innerHTML = ""; // remove the old timeline
  dayTimeline.appendChild(sheet);

  // When a day is opened: scroll to its first session (or 08:00 / now)
  if (lastScrolledDay !== dayKey) {
    lastScrolledDay = dayKey;
    const first = daySessions.length
      ? Math.min(...daySessions.map((s) => minutesIntoDay(s.start, dayKey)))
      : isToday ? minutesIntoDay(new Date().toISOString(), dayKey) - 60 : 8 * 60;
    dayTimeline.scrollTop = Math.max(0, (first / 60) * HOUR_PX - 24);
  }
}

// =====================================================================
// EDIT / DELETE A SAVED SESSION
// =====================================================================

const editTask = document.getElementById("edit-task");
const editNote = document.getElementById("edit-note");
const editStart = document.getElementById("edit-start");
const editEnd = document.getElementById("edit-end");
const editPaused = document.getElementById("edit-paused");
const editDuration = document.getElementById("edit-duration");
const editError = document.getElementById("edit-error");

// The session being edited, exactly as it was when the form opened.
let editingOriginal = null;
const editTitle = document.getElementById("edit-title");
const editDeleteBtn = document.getElementById("edit-delete");

// ISO time -> "2026-11-12T14:05", the local format datetime-local inputs use.
function toLocalInputValue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return localDayKey(d) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

// Open the edit screen for one session and fill in its current values.
// This only happens once when opening, so typing isn't overwritten later.
function openEdit(id) {
  const s = loadData().sessions.find((x) => x.id === id);
  if (!s) return;
  showEditForm(s, false);
}

// Add a session by hand (from the day timeline), e.g. something you forgot to time.
// startMinutes = minutes after midnight on that day; it lasts 30 minutes to begin with.
function openNewSession(dayKey, startMinutes) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, startMinutes);
  const end = new Date(start.getTime() + 30 * 60000);
  showEditForm({
    id: makeId(),
    task: "",
    subject: "",
    start: start.toISOString(),
    end: end.toISOString(),
    pausedMs: 0,
    note: "",
  }, true);
}

// "+ Add" button: today = the last half hour; other days = 09:00.
function addSessionButton() {
  const today = localDayKey(new Date());
  if (selectedDay === today) {
    const now = new Date();
    const minutes = Math.floor((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
    openNewSession(today, Math.max(0, minutes - 30));
  } else {
    openNewSession(selectedDay, 9 * 60);
  }
}

// true while adding a brand-new session (no Delete button, Save adds it).
let editingIsNew = false;

// Fill the edit form with a session's values and open it.
function showEditForm(s, isNew) {
  editingOriginal = s;
  editingIsNew = isNew;
  editTitle.textContent = isNew ? "Add session" : "Edit session";
  editDeleteBtn.hidden = isNew;
  editTask.value = s.task;
  editNote.value = s.note || "";
  editStart.value = toLocalInputValue(s.start);
  editEnd.value = toLocalInputValue(s.end);
  editPaused.value = Math.round(s.pausedMs / 60000);
  editError.hidden = true;
  updateEditDuration();
  openView("edit");
  if (isNew) editTask.focus(); // ready to type what you did
}

// Read the form and turn it into session values.
// The pickers only show minutes, not seconds. So if a field was NOT
// changed, we keep the exact original value; otherwise saving an
// untouched session would cut off its seconds.
function readEditForm() {
  const o = editingOriginal;
  // "2026-11-12T14:05" is read as local time. An emptied field gives "",
  // which validateSession() then reports instead of crashing.
  const toIso = (value) => (value ? new Date(value).toISOString() : "");
  const start = editStart.value === toLocalInputValue(o.start) ? o.start : toIso(editStart.value);
  const end = editEnd.value === toLocalInputValue(o.end) ? o.end : toIso(editEnd.value);
  const pausedMs = Number(editPaused.value) === Math.round(o.pausedMs / 60000)
    ? o.pausedMs
    : Number(editPaused.value) * 60000;
  return {
    id: o.id, // same id: it's still the same session
    task: editTask.value.trim(),
    subject: o.subject || "", // no longer editable; older sessions keep theirs
    start: start,
    end: end,
    pausedMs: pausedMs,
    note: editNote.value.trim(),
  };
}

// Returns a message describing what's wrong, or "" if all is fine.
function validateSession(s) {
  if (!s.task) return "Task can't be empty.";
  if (!editStart.value || !editEnd.value) return "Start and end are both needed.";
  if (editPaused.value === "" || s.pausedMs < 0) return "Paused must be 0 or more minutes.";
  const length = Date.parse(s.end) - Date.parse(s.start);
  if (length <= 0) return "End must be after start.";
  if (s.pausedMs > length) return "Paused time is longer than the session.";
  return "";
}

// Live preview of the duration while you change the fields.
function updateEditDuration() {
  const s = readEditForm();
  const problem = validateSession(s);
  editDuration.textContent = problem ? "" : "Duration: " + formatDuration(sessionDuration(s));
}

function saveEdit() {
  const updated = readEditForm();
  const problem = validateSession(updated);
  if (problem) {
    editError.textContent = problem;
    editError.hidden = false;
    return; // nothing is saved
  }
  const data = loadData();
  const index = data.sessions.findIndex((x) => x.id === updated.id);
  if (editingIsNew) {
    data.sessions.push(updated); // a new session added by hand
  } else if (index === -1) {
    return; // session no longer exists
  } else {
    data.sessions[index] = updated;
  }
  saveData(data);
  // Go to the session's day (a new day if the start date was changed).
  selectedDay = localDayKey(new Date(updated.start));
  goBack(); // back to the day screen, which now shows selectedDay
}

function deleteEdit() {
  if (!confirm("Delete this session?")) return;
  const data = loadData();
  data.sessions = data.sessions.filter((x) => x.id !== editingOriginal.id);
  saveData(data);
  // Back to the day's timeline (even if it's empty now: you can add new ones there).
  goBack();
}

// =====================================================================
// STATS: BAR CHART OF THE LAST 7 DAYS
// =====================================================================

const statsRange = document.getElementById("stats-range");
const statsNext = document.getElementById("stats-next");
const statsChart = document.getElementById("stats-chart");
const statsDayTitle = document.getElementById("stats-day-title");
const statsDayTotal = document.getElementById("stats-day-total");
const statsDayEmpty = document.getElementById("stats-day-empty");
const statsDayList = document.getElementById("stats-day-list");

const statsDayGoal = document.getElementById("stats-day-goal");
const statsNotes = document.getElementById("stats-notes");
const statsNotesList = document.getElementById("stats-notes-list");
const recentDays = document.getElementById("recent-days");
const recentEmpty = document.getElementById("recent-empty");
const allDaysBtn = document.getElementById("all-days-btn");
const statsCalendar = document.getElementById("stats-calendar");
const goalBtn = document.getElementById("goal-btn");
const tabWeek = document.getElementById("tab-week");
const tabMonth = document.getElementById("tab-month");

// "week" = bar chart, "month" = calendar with goal rings.
let statsMode = "week";
// Week view shows the 7 days ENDING on statsEndDay.
let statsEndDay = null;
// Month view shows statsMonth, e.g. "2026-11".
let statsMonth = null;
// The tapped bar / calendar day (shared by both views).
let statsSelectedDay = null;

// "2026-11-12" plus 3 days -> "2026-11-15". Works across months and years.
function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return localDayKey(new Date(y, m - 1, d + n));
}

// Date in a chosen style, e.g. { weekday: "short" } -> "Thu"
function formatDayPart(dayKey, options) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, options);
}

// Axis label for a number of minutes: 30 -> "30m", 60 -> "1h", 90 -> "1h30"
function formatAxisMinutes(min) {
  if (min === 0) return "0";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return m + "m";
  return m === 0 ? h + "h" : h + "h" + String(m).padStart(2, "0");
}

// Pick a clean gridline step so there are at most 4 lines, e.g. every 1h.
function chooseAxisStep(maxMinutes) {
  const steps = [15, 30, 60, 120, 180, 240, 360, 480];
  for (const step of steps) {
    if (Math.ceil(maxMinutes / step) <= 4) return step;
  }
  return 720;
}

// Shortcut for making SVG elements (they need a special "namespace").
function svgEl(tag, attributes) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const name in attributes) {
    if (attributes[name] != null) el.setAttribute(name, attributes[name]); // skip empty ones
  }
  return el;
}

// Draw a progress ring into an <svg viewBox="0 0 40 40">.
// progress: 0 = empty, 1 = full (goal reached; then the ring turns green).
function drawRing(svg, progress) {
  const R = 16;
  const C = 2 * Math.PI * R; // length of the circle
  const p = Math.max(0, Math.min(1, progress));
  svg.innerHTML = ""; // remove the old ring
  svg.classList.toggle("met", progress >= 1);
  svg.appendChild(svgEl("circle", { class: "ring-track", cx: 20, cy: 20, r: R }));
  if (p > 0) {
    svg.appendChild(svgEl("circle", {
      class: "ring-progress", cx: 20, cy: 20, r: R,
      "stroke-dasharray": (p * C) + " " + C, // draw only part of the circle
      transform: "rotate(-90 20 20)", // start at 12 o'clock
    }));
  }
}

// Bar shape: rounded corners on top, square at the bottom (the baseline).
function barPath(x, y, width, height) {
  const r = Math.min(4, height, width / 2);
  const bottom = y + height;
  return "M" + x + "," + bottom +
    " V" + (y + r) +
    " Q" + x + "," + y + " " + (x + r) + "," + y +
    " H" + (x + width - r) +
    " Q" + (x + width) + "," + y + " " + (x + width) + "," + (y + r) +
    " V" + bottom + " Z";
}

function openStats() {
  const today = localDayKey(new Date());
  statsEndDay = today;
  statsMonth = today.slice(0, 7); // "2026-11-12" -> "2026-11"
  statsSelectedDay = today;
  goalEditor.hidden = true; // start with the goal editor closed
  showBackupMessage(""); // don't show an old backup message
  openView("stats");
}

// Week / Month tabs. The selected day stays the same; we jump to its week or month.
function setStatsMode(mode) {
  statsMode = mode;
  statsEndDay = statsSelectedDay;
  statsMonth = statsSelectedDay.slice(0, 7);
  render();
}

// "2026-11" plus 1 -> "2026-12" (and "2026-12" plus 1 -> "2027-01")
function addMonths(monthKey, n) {
  const [y, m] = monthKey.split("-").map(Number);
  return localDayKey(new Date(y, m - 1 + n, 1)).slice(0, 7);
}

// Last day of a month, e.g. "2026-11" -> "2026-11-30"
function lastDayOfMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return localDayKey(new Date(y, m, 0)); // day 0 of next month = last day of this one
}

// ‹ and › buttons: one week or one month back/forward (never into the future).
// "2026-11-12" style keys compare correctly as plain text.
function moveStats(direction) {
  const today = localDayKey(new Date());
  if (statsMode === "week") {
    let end = addDays(statsEndDay, 7 * direction);
    if (end > today) end = today;
    statsEndDay = end;
    statsSelectedDay = end;
  } else {
    statsMonth = addMonths(statsMonth, direction);
    // Select today in the current month, otherwise the month's last day.
    const last = lastDayOfMonth(statsMonth);
    statsSelectedDay = last > today ? today : last;
  }
  render();
}

// ---- Goal editor: tap "Goal: 2h ✎", use − / +, then Save ----
const goalEditor = document.getElementById("goal-editor");
const goalHours = document.getElementById("goal-hours");
const goalMinutes = document.getElementById("goal-minutes");
const goalError = document.getElementById("goal-error");
const GOAL_STEP = 15; // minutes per − / + tap
const GOAL_MIN = 5; // smallest goal: 5 minutes
const GOAL_MAX = 12 * 60; // biggest goal: 12 hours

// Put a number of minutes into the two fields, e.g. 150 -> [2] h [30] min
function showGoalInFields(minutes) {
  goalHours.value = Math.floor(minutes / 60);
  goalMinutes.value = minutes % 60;
}

// Read the two fields as minutes. Empty fields count as 0.
// "1.5" hours works too (= 1h30). Returns NaN if the input isn't a number.
function readGoalFields() {
  const h = goalHours.value === "" ? 0 : Number(goalHours.value);
  const m = goalMinutes.value === "" ? 0 : Number(goalMinutes.value);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) return NaN;
  return Math.round(h * 60 + m); // "90 min" typed in the minutes field also works: 1h30
}

function openGoalEditor() {
  const today = localDayKey(new Date());
  showGoalInFields(goalForDay(loadData().goals, today));
  goalError.hidden = true;
  goalEditor.hidden = false;
}

// − / + : change by 15 minutes, starting from whatever is typed right now.
function stepGoal(direction) {
  const current = readGoalFields();
  const start = isNaN(current) ? DEFAULT_GOAL_MINUTES : current;
  showGoalInFields(Math.min(GOAL_MAX, Math.max(GOAL_STEP, start + direction * GOAL_STEP)));
  goalError.hidden = true;
}

function closeGoalEditor() {
  goalEditor.hidden = true;
}

function saveGoal() {
  const minutes = readGoalFields();
  if (isNaN(minutes) || minutes < GOAL_MIN || minutes > GOAL_MAX) {
    goalError.textContent = "Please enter a goal between 5 min and 12 h.";
    goalError.hidden = false;
    return; // nothing is saved
  }
  setGoalFromToday(minutes);
  closeGoalEditor();
  render();
}

function renderStats(data) {
  const sessions = data.sessions;
  const today = localDayKey(new Date());
  const firstDay = firstSessionDay(sessions);

  // Info about one day: its total, its goal and how it did.
  const dayInfo = (dayKey) => {
    const ms = sumDurations(sessionsOnDay(sessions, dayKey));
    const goal = goalForDay(data.goals, dayKey);
    return { dayKey: dayKey, ms: ms, goal: goal, status: dayStatus(dayKey, ms, goal, today, firstDay) };
  };

  // Top row: tabs and today's goal
  tabWeek.classList.toggle("active", statsMode === "week");
  tabMonth.classList.toggle("active", statsMode === "month");
  goalBtn.textContent = "Goal: " + formatAxisMinutes(goalForDay(data.goals, today)) + " ✎";
  document.getElementById("stats-week").hidden = statsMode !== "week";
  document.getElementById("stats-month").hidden = statsMode !== "month";

  if (statsMode === "week") {
    // The 7 days in the window, oldest first.
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(dayInfo(addDays(statsEndDay, -i)));
    const shortDate = { day: "numeric", month: "short" };
    statsRange.textContent =
      formatDayPart(days[0].dayKey, shortDate) + " – " + formatDayPart(statsEndDay, shortDate);
    statsNext.disabled = statsEndDay >= today;
    drawBarChart(days);
  } else {
    // Every day of the month.
    const days = [];
    const last = lastDayOfMonth(statsMonth);
    for (let d = statsMonth + "-01"; d <= last; d = addDays(d, 1)) days.push(dayInfo(d));
    statsRange.textContent = formatDayPart(statsMonth + "-01", { month: "long", year: "numeric" });
    statsNext.disabled = statsMonth >= today.slice(0, 7);
    drawCalendar(days);
  }

  // Under the chart: what the selected day was spent on, and how it did.
  const selected = dayInfo(statsSelectedDay);
  const daySessions = sessionsOnDay(sessions, statsSelectedDay);
  statsDayTitle.textContent = statsSelectedDay === today ? "Today" : formatDayKey(statsSelectedDay);
  statsDayTotal.textContent = formatDuration(selected.ms);
  statsDayGoal.textContent = goalText(selected);
  statsDayEmpty.hidden = daySessions.length > 0;
  renderTaskTotals(statsDayList, daySessions);

  // "Done": the notes written after each session of that day, in time order.
  const notes = daySessions
    .filter((s) => s.note)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  statsNotes.hidden = notes.length === 0;
  statsNotesList.innerHTML = ""; // remove the old notes
  for (const s of notes) {
    const li = document.createElement("li");
    li.textContent = s.note; // textContent: always shown as plain text
    statsNotesList.appendChild(li);
  }

  // Recent days: the last few days with sessions; the rest is behind "Show all days".
  const RECENT_COUNT = 5;
  const allDays = groupByDay(sessions);
  recentDays.innerHTML = ""; // remove the old cards
  for (const day of allDays.slice(0, RECENT_COUNT)) recentDays.appendChild(buildDayCard(day));
  recentEmpty.hidden = allDays.length > 0;
  allDaysBtn.hidden = allDays.length <= RECENT_COUNT; // nothing more to show
}

// One line about the goal, e.g. "Goal 2h · reached ✓" or "Goal 2h · 0:30:00 to go"
function goalText(day) {
  const goal = "Goal " + formatAxisMinutes(day.goal);
  const shortBy = formatDuration(day.goal * 60000 - day.ms);
  if (day.status === "met") return goal + " · reached ✓";
  if (day.status === "today") return goal + " · " + shortBy + " to go";
  if (day.status === "missed") return goal + " · missed by " + shortBy;
  return ""; // blank and future days: nothing to say
}

// Draw the month as a calendar: weekday headers, then one ring per day.
function drawCalendar(days) {
  statsCalendar.innerHTML = ""; // remove the old calendar

  // Weekday headers, Monday first. 2026-11-09 was a Monday.
  for (let i = 0; i < 7; i++) {
    const head = document.createElement("div");
    head.className = "cal-weekday";
    head.textContent = formatDayPart(addDays("2026-11-09", i), { weekday: "narrow" });
    statsCalendar.appendChild(head);
  }

  // Empty cells before the 1st, so it lands under the right weekday.
  const [y, m] = days[0].dayKey.split("-").map(Number);
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  for (let i = 0; i < offset; i++) statsCalendar.appendChild(document.createElement("div"));

  const R = 16; // ring radius, in a 40x40 box
  const C = 2 * Math.PI * R; // ring length all the way round

  for (const day of days) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cal-cell " + day.status + (day.dayKey === statsSelectedDay ? " selected" : "");
    cell.disabled = day.status === "future";
    cell.setAttribute("aria-label", formatDayKey(day.dayKey) + ": " + formatDuration(day.ms) +
      (goalText(day) ? " – " + goalText(day) : ""));

    const svg = svgEl("svg", { viewBox: "0 0 40 40", "aria-hidden": "true" });
    // Blank and future days get no ring, just the date.
    if (day.status !== "blank" && day.status !== "future") {
      svg.appendChild(svgEl("circle", { class: "ring-track", cx: 20, cy: 20, r: R }));
      const progress = Math.min(1, day.ms / (day.goal * 60000));
      if (progress > 0) {
        svg.appendChild(svgEl("circle", {
          class: "ring-progress", cx: 20, cy: 20, r: R,
          "stroke-dasharray": (progress * C) + " " + C, // draw only part of the circle
          transform: "rotate(-90 20 20)", // start at 12 o'clock
        }));
      }
    }
    const date = svgEl("text", { class: "ring-date", x: 20, y: 24.5, "text-anchor": "middle" });
    date.textContent = String(Number(day.dayKey.slice(8))); // "2026-11-05" -> "5"
    svg.appendChild(date);
    cell.appendChild(svg);

    // ✓ under the ring when the goal was reached (so it's not shown by colour alone)
    const check = document.createElement("span");
    check.className = "cal-check";
    check.textContent = day.status === "met" ? "✓" : "";
    cell.appendChild(check);

    cell.addEventListener("click", () => {
      statsSelectedDay = day.dayKey;
      render();
    });
    statsCalendar.appendChild(cell);
  }
}

// Draw the 7 bars as an SVG picture.
function drawBarChart(days) {
  // Sizes in "chart units". The SVG scales to the screen width.
  const width = 340, height = 200;
  const left = 36, right = 4, top = 22, bottom = 24; // room for labels
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const baseline = top + plotH;
  const band = plotW / days.length; // horizontal space per day
  const barW = Math.min(24, band - 8); // thin bars, never more than 24 wide

  // Y scale: round the biggest day up to a clean gridline (at least 1 hour).
  // (The goal counts too, so its line always fits in the chart.)
  const maxMinutes = Math.max(60, ...days.map((d) => Math.max(d.ms / 60000, d.goal)));
  const step = chooseAxisStep(maxMinutes);
  const axisMax = step * Math.ceil(maxMinutes / step);
  const yFor = (minutes) => baseline - (minutes / axisMax) * plotH;

  const svg = svgEl("svg", { viewBox: "0 0 " + width + " " + height, role: "group", "aria-label": "Focus time per day" });

  // Gridlines with labels: 0, 1h, 2h, ...
  for (let min = 0; min <= axisMax; min += step) {
    const y = yFor(min);
    svg.appendChild(svgEl("line", { class: "grid", x1: left, x2: width - right, y1: y, y2: y }));
    const label = svgEl("text", { x: left - 6, y: y + 4, "text-anchor": "end" });
    label.textContent = formatAxisMinutes(min);
    svg.appendChild(label);
  }

  days.forEach((day, i) => {
    const selected = day.dayKey === statsSelectedDay;
    const bandX = left + i * band;
    const centerX = bandX + band / 2;

    // One group per day = one tap target covering the whole column.
    const column = svgEl("g", { class: "column", tabindex: "0", role: "button" });
    const name = formatDayKey(day.dayKey) + ": " + formatDuration(day.ms);
    column.setAttribute("aria-label", name);
    const tooltip = svgEl("title", {}); // shows on mouse hover on a PC
    tooltip.textContent = name;
    column.appendChild(tooltip);

    // Invisible full-height rectangle, so you don't have to hit the thin bar exactly
    column.appendChild(svgEl("rect", {
      class: selected ? "selected-band" : "hit",
      x: bandX + 2, y: top - 18, width: band - 4, height: plotH + 18, rx: 6,
      fill: selected ? null : "transparent",
    }));

    // The bar itself (a day with 0 time draws nothing)
    const minutes = day.ms / 60000;
    if (minutes > 0) {
      const barH = Math.max(2, baseline - yFor(minutes)); // tiny days still show a sliver
      column.appendChild(svgEl("path", { class: "bar", d: barPath(centerX - barW / 2, baseline - barH, barW, barH) }));
    }

    // Selected day: its time on top of the bar
    if (selected && day.ms > 0) {
      const value = svgEl("text", { class: "value-label", x: centerX, y: yFor(minutes) - 6, "text-anchor": "middle" });
      value.textContent = formatAxisMinutes(Math.round(minutes));
      column.appendChild(value);
    }

    // Weekday under the bar, e.g. "Thu"
    const dayLabel = svgEl("text", {
      class: "day-label" + (selected ? " selected" : ""),
      x: centerX, y: height - 6, "text-anchor": "middle",
    });
    dayLabel.textContent = formatDayPart(day.dayKey, { weekday: "short" });
    column.appendChild(dayLabel);

    // Tap (or Enter/Space on a keyboard) selects the day
    const select = () => { statsSelectedDay = day.dayKey; render(); };
    column.addEventListener("click", select);
    column.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
    });

    svg.appendChild(column);
  });

  // Goal line: one piece per day, so if the goal changed mid-week the line steps.
  days.forEach((day, i) => {
    const y = yFor(day.goal);
    svg.appendChild(svgEl("line", {
      class: "goal-line", x1: left + i * band, x2: left + (i + 1) * band, y1: y, y2: y,
    }));
  });

  statsChart.innerHTML = ""; // remove the old chart
  statsChart.appendChild(svg);
}

// =====================================================================
// BACKUP: EXPORT / IMPORT AS JSON
// =====================================================================

const backupMessage = document.getElementById("backup-message");
const importFile = document.getElementById("import-file");

// "1 session", "5 sessions"
function countSessions(n) {
  return n + (n === 1 ? " session" : " sessions");
}

function showBackupMessage(text) {
  backupMessage.textContent = text;
  backupMessage.hidden = !text;
}

// Download all sessions as a .json file.
function exportBackup() {
  const backup = {
    app: "studytracker", // marks the file as ours
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: loadData().sessions,
    goals: loadData().goals, // daily goal history
  };
  const text = JSON.stringify(backup, null, 2); // indented, readable by humans

  // Turn the text into a temporary file and "click" a download link for it.
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "studytracker-backup-" + localDayKey(new Date()) + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000); // clean up afterwards

  showBackupMessage("Exported " + countSessions(backup.sessions.length) + ".");
}

// Is this one session complete and sensible? (Used to check imported files.)
function isValidSession(s) {
  return (
    s !== null && typeof s === "object" &&
    typeof s.id === "string" && s.id !== "" &&
    typeof s.task === "string" && s.task !== "" &&
    (s.subject === undefined || typeof s.subject === "string") &&
    !isNaN(Date.parse(s.start)) &&
    !isNaN(Date.parse(s.end)) &&
    typeof s.pausedMs === "number" && s.pausedMs >= 0
  );
}

// Read a chosen file and MERGE it in: only sessions whose id we don't
// have yet are added. Nothing existing is changed or removed, and the
// running timer is never touched.
async function importBackup(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    showBackupMessage("Couldn't read that file. Nothing was changed.");
    return;
  }

  const sessions = parsed && parsed.sessions;
  if (!Array.isArray(sessions) || !sessions.every(isValidSession)) {
    showBackupMessage("That doesn't look like a Study Tracker backup. Nothing was changed.");
    return;
  }

  const data = loadData();
  const existingIds = new Set(data.sessions.map((s) => s.id));
  const newSessions = sessions.filter((s) => !existingIds.has(s.id));

  // Goal history: add goal changes from the file whose date we don't have yet.
  // (Files from before goals existed simply have none; that's fine.)
  const fileGoals = Array.isArray(parsed.goals) ? parsed.goals : [];
  const existingFroms = new Set(data.goals.map((g) => g.from));
  const newGoals = fileGoals.filter((g) =>
    g && typeof g.from === "string" && typeof g.minutes === "number" && g.minutes > 0 &&
    !existingFroms.has(g.from));
  // Only added to `data` here; it gets saved together with the sessions below.
  for (const g of newGoals) data.goals.push({ from: g.from, minutes: g.minutes });
  data.goals.sort((a, b) => (a.from < b.from ? -1 : 1));

  if (newSessions.length === 0 && newGoals.length > 0) {
    saveData(data);
    showBackupMessage("No new sessions, but your goal history was updated.");
    render();
    return;
  }
  if (newSessions.length === 0) {
    showBackupMessage("Nothing new: everything in the file (" + countSessions(sessions.length) + ") is already here.");
    return;
  }
  if (!confirm("Import " + countSessions(newSessions.length).replace(" ", " new ") + "?")) {
    showBackupMessage("Import cancelled. Nothing was changed.");
    return;
  }

  // Copy only the fields we know, so a strange file can't add junk.
  for (const s of newSessions) {
    data.sessions.push({
      id: s.id,
      task: s.task,
      subject: s.subject || "",
      start: s.start,
      end: s.end,
      pausedMs: s.pausedMs,
      note: typeof s.note === "string" ? s.note : "",
    });
  }
  saveData(data);
  showBackupMessage("Imported " + countSessions(newSessions.length) + ".");
  render(); // redraw History with the new days
}

// Draw one button per recent task. Tapping it fills in the task name.
function renderRecentTasks(sessions) {
  recentTasksBox.innerHTML = ""; // remove the old buttons
  for (const item of getRecentTasks(sessions, 5)) {
    const btn = document.createElement("button");
    btn.type = "button";
    // textContent (not innerHTML) so task names are always shown as plain text
    btn.textContent = item.task;
    btn.addEventListener("click", () => {
      taskInput.value = item.task;
    });
    recentTasksBox.appendChild(btn);
  }
}

// Redraw just the time. Runs a few times per second.
function updateTimerDisplay() {
  const data = loadData();
  const session = data.activeSession;
  document.body.classList.remove("on-break");
  timerPhase.hidden = true;
  timerProgress.hidden = true;
  dialSvg.setAttribute("hidden", ""); // the water dial is only for Timer mode
  // (SVG elements have no .hidden shortcut like normal elements, so we set the attribute)
  dial.classList.remove("has-dial");
  if (!session) return;

  if (session.mode !== "timer") {
    // Stopwatch: count up
    timerDisplay.textContent = formatDuration(elapsedMs(session));
    return;
  }

  // Timer: first move on if a block or break has ended
  const result = advanceTimer(data);
  if (result.changed) {
    if (result.finished) {
      finishTimer(data);
      return;
    }
    saveData(data);
    signal(); // beep + vibrate: next phase started
    render();
    return; // render() calls this function again
  }

  // Count DOWN the current phase
  const phases = phasesOf(session.plan);
  const phase = phases[session.phase];
  const leftMs = phase.min * 60000 - elapsedMs(session);
  timerDisplay.textContent = formatDuration(leftMs + 999); // round up: show 0:00:01, never 0:00:00 early

  // Water dial: the water rises as the phase goes on, full to the brim at the end.
  // The egg drawing is 260 units tall: 265 = just below the bottom (empty),
  // -8 = above the top (full, so even the wave dips are over the rim).
  const progress = Math.min(1, Math.max(0, elapsedMs(session) / (phase.min * 60000)));
  dialSvg.removeAttribute("hidden");
  dial.classList.add("has-dial");
  waterLevel.style.transform = "translateY(" + (265 - progress * 273) + "px)";
  const blocks = session.plan.focus.length;
  timerPhase.hidden = false;
  timerPhase.textContent = phase.type === "focus" ? "Focus " + phase.number + " of " + blocks : "Break";
  document.body.classList.toggle("on-break", phase.type === "break");

  // Progress line: studied so far, and what comes next
  const studiedNow = session.studiedMs + (phase.type === "focus" ? elapsedMs(session) : 0);
  const totalStudy = session.plan.focus.reduce((a, b) => a + b, 0) * 60000;
  const next = phases[session.phase + 1];
  const nextText = !next ? "last block" : next.type === "break"
    ? "next: " + next.min + " min break" : "next: focus " + next.number;
  timerProgress.hidden = false;
  timerProgress.textContent = "Studied " + formatDuration(studiedNow) + " of " + formatDuration(totalStudy) + " · " + nextText;
}

// =====================================================================
// START-UP
// =====================================================================

document.getElementById("start-btn").addEventListener("click", startSession);
pauseBtn.addEventListener("click", togglePause);
document.getElementById("stop-btn").addEventListener("click", stopSession);
document.getElementById("today-link").addEventListener("click", () => openView("today"));
document.getElementById("today-back").addEventListener("click", () => goBack());
const bottomNav = document.getElementById("bottom-nav");
const navHome = document.getElementById("nav-home");
const navStats = document.getElementById("nav-stats");
navHome.addEventListener("click", () => goTab("home"));
navStats.addEventListener("click", () => goTab("stats"));
allDaysBtn.addEventListener("click", () => openView("history"));
document.getElementById("stats-prev").addEventListener("click", () => moveStats(-1));
statsNext.addEventListener("click", () => moveStats(1));
tabWeek.addEventListener("click", () => setStatsMode("week"));
tabMonth.addEventListener("click", () => setStatsMode("month"));
goalBtn.addEventListener("click", openGoalEditor);
document.getElementById("goal-minus").addEventListener("click", () => stepGoal(-1));
document.getElementById("goal-plus").addEventListener("click", () => stepGoal(1));
document.getElementById("goal-cancel").addEventListener("click", closeGoalEditor);
document.getElementById("goal-save").addEventListener("click", saveGoal);
// Pressing Enter (or "Go" on the phone keypad) in a goal field saves.
for (const input of [goalHours, goalMinutes]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveGoal();
  });
}
document.getElementById("export-btn").addEventListener("click", exportBackup);
// The Import button opens the hidden file picker...
document.getElementById("import-btn").addEventListener("click", () => importFile.click());
// ...and once a file is picked, import it.
importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  if (file) await importBackup(file);
  importFile.value = ""; // so picking the same file again still works
});
document.getElementById("history-back").addEventListener("click", () => goBack());
document.getElementById("day-back").addEventListener("click", () => goBack());
document.getElementById("edit-cancel").addEventListener("click", () => goBack());
document.getElementById("edit-save").addEventListener("click", saveEdit);
document.getElementById("day-add").addEventListener("click", addSessionButton);
document.getElementById("edit-delete").addEventListener("click", deleteEdit);
// Update the duration preview whenever any edit field changes.
for (const input of [editStart, editEnd, editPaused]) {
  input.addEventListener("input", updateEditDuration);
}

// Pressing Enter in the task box also starts.
taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") startSession();
});

// "What did you get done?" card after Stop
document.getElementById("note-save").addEventListener("click", saveNote);
document.getElementById("note-skip").addEventListener("click", skipNote);

// Update every 250ms. Ticking more often than once a second keeps the
// display from lagging behind; it does NOT affect accuracy.
setInterval(updateTimerDisplay, 250);

// When you come back to the app (unlock phone, switch apps), redraw at once.
// The phone drops "keep screen on" when you leave, so ask again for a running timer.
document.addEventListener("visibilitychange", () => {
  const session = loadData().activeSession;
  if (document.visibilityState === "visible" && session && session.mode === "timer") keepScreenOn();
  render();
});

// ---- "Focus. Flow. Finish." wave ----
// Split the tagline into one <span> per letter, numbered 0, 1, 2, ...
// The CSS animation delays each letter by its number, which makes the wave.
const tagline = document.getElementById("tagline");
const taglineText = tagline.textContent;
tagline.textContent = "";
[...taglineText].forEach((char, i) => {
  const span = document.createElement("span");
  span.className = "ch";
  span.style.setProperty("--i", i);
  span.setAttribute("aria-hidden", "true"); // screen readers read the label instead
  span.textContent = char;
  tagline.appendChild(span);
});

function startWave() {
  if (tagline.classList.contains("waving")) return; // let the current wave finish
  tagline.classList.add("waving");
}

// When the LAST letter has finished hopping, the wave is over and can run again.
if (tagline.lastChild) {
  tagline.lastChild.addEventListener("animationend", () => tagline.classList.remove("waving"));
}
tagline.addEventListener("pointerenter", startWave); // mouse moves over it
tagline.addEventListener("pointerdown", startWave); // finger or click

// Stopwatch / Timer switch and the study-time box
modeStopwatch.addEventListener("click", () => setMode("stopwatch"));
modeTimer.addEventListener("click", () => setMode("timer"));
timerMinutesInput.addEventListener("input", () => {
  chosenBreaks = null; // new study time: start from the recommended option again
  renderPlanOptions();
});

// Back gesture / Back button: the browser tells us which step we went back to.
window.addEventListener("popstate", (event) => {
  let view = (event.state && event.state.view) || "home";
  // After a page reload we no longer know which day or session was open,
  // so fall back to History instead of showing a broken screen.
  if ((view === "day" && !selectedDay) || (view === "edit" && !editingOriginal)) {
    view = "history";
  }
  if (view === "stats" && !statsEndDay) view = "home";
  navDepth = (event.state && event.state.depth) || 0;
  showView(view);
  if (openStatsAfterBack && navDepth === 0) {
    openStatsAfterBack = false;
    openStats();
  }
});

// The app always starts on Home; mark that as the first step in the history.
history.replaceState({ view: "home", depth: 0 }, "");

render(); // draw the correct screen on page load (resumes a running session)

// Turn on offline support (see sw.js). Browsers only allow this on
// https:// or on localhost, so over plain http on Wi-Fi it's skipped.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((error) => {
    console.log("Offline support not available here:", error);
  });
}
