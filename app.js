// =====================================================================
// STORAGE
// Everything is saved under one key in localStorage (see PLAN.md).
// =====================================================================

const STORAGE_KEY = "studytracker.v1";

// Read all data. If nothing is saved yet, start with an empty structure.
function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { sessions: [], activeSession: null };
  }
  return JSON.parse(raw);
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

function startSession() {
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.focus(); // no task typed: put the cursor in the box instead
    return;
  }
  const data = loadData();
  data.activeSession = {
    task: task,
    subject: subjectInput.value.trim(), // empty string if not filled in
    start: new Date().toISOString(),
    pausedMs: 0,
    pausedAt: null,
  };
  saveData(data); // save immediately so a refresh loses nothing
  taskInput.value = "";
  subjectInput.value = "";
  savedMessageText = ""; // hide the old "Saved" message
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

  const now = Date.now();
  let pausedMs = session.pausedMs;
  // Stopped while paused: the current pause also counts as paused time.
  if (session.pausedAt) {
    pausedMs += now - Date.parse(session.pausedAt);
  }

  // The finished session, in the shape described in PLAN.md.
  const finished = {
    id: makeId(),
    task: session.task,
    subject: session.subject || "",
    start: session.start,
    end: new Date(now).toISOString(),
    pausedMs: pausedMs,
  };

  data.sessions.push(finished);
  data.activeSession = null;
  saveData(data); // session saved and timer cleared in one write

  const duration = now - Date.parse(finished.start) - finished.pausedMs;
  savedMessageText = "Saved: " + finished.task + " – " + formatDuration(duration);
  render();
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
const subjectInput = document.getElementById("subject-input");
const recentTasksBox = document.getElementById("recent-tasks");
const savedMessage = document.getElementById("saved-message");

const todayScreen = document.getElementById("today-screen");
const homeTodayTotal = document.getElementById("home-today-total");
const todayTotal = document.getElementById("today-total");
const todayEmpty = document.getElementById("today-empty");
const todayList = document.getElementById("today-list");

// Text of the "Saved: ..." message. Not stored, so it's gone after a reload.
let savedMessageText = "";

const historyEmpty = document.getElementById("history-empty");
const historyList = document.getElementById("history-list");
const dayTitle = document.getElementById("day-title");
const dayTotal = document.getElementById("day-total");
const dayList = document.getElementById("day-list");

// All screens that are not the timer, by name.
const screens = {
  home: homeScreen,
  today: todayScreen,
  history: document.getElementById("history-screen"),
  day: document.getElementById("day-screen"),
};

// Which screen to show when no timer is running: a name from `screens`.
// (While a session runs, the timer screen always wins.)
let currentView = "home";
// Which day the day screen shows, e.g. "2026-11-12".
let selectedDay = null;

function showView(view) {
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

  if (!session) {
    const today = sessionsOnDay(data.sessions, localDayKey(new Date()));
    if (currentView === "home") {
      homeTodayTotal.textContent = formatDuration(sumDurations(today));
      savedMessage.textContent = savedMessageText;
      savedMessage.hidden = !savedMessageText;
      renderRecentTasks(data.sessions);
    } else if (currentView === "today") {
      renderToday(today);
    } else if (currentView === "history") {
      renderHistory(data.sessions);
    } else if (currentView === "day") {
      renderDay(selectedDay, sessionsOnDay(data.sessions, selectedDay));
    }
  }

  if (session) {
    timerTask.textContent = session.task;
    pauseBtn.textContent = session.pausedAt ? "Resume" : "Pause";
    timerStatus.textContent = session.pausedAt ? "Paused" : "";
    updateTimerDisplay();
  }
}

// Fill the Today screen: big total plus one row per task.
function renderToday(todaySessions) {
  todayTotal.textContent = formatDuration(sumDurations(todaySessions));
  todayEmpty.hidden = todaySessions.length > 0;
  todayList.innerHTML = ""; // remove the old rows

  for (const item of totalsByTask(todaySessions)) {
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatDuration(item.ms);
    li.append(taskLabel(item.task, item.subject), time);
    todayList.appendChild(li);
  }
}

// Fill the History screen: one tappable card per day, newest first.
function renderHistory(sessions) {
  const days = groupByDay(sessions);
  historyEmpty.hidden = days.length > 0;
  historyList.innerHTML = ""; // remove the old cards

  for (const day of days) {
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
      showView("day");
    });
    historyList.appendChild(card);
  }
}

// Fill the day screen: the day's total, then every session in time order.
function renderDay(dayKey, daySessions) {
  dayTitle.textContent = formatDayKey(dayKey);
  dayTotal.textContent = formatDuration(sumDurations(daySessions));
  dayList.innerHTML = ""; // remove the old rows

  daySessions.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const s of daySessions) {
    const li = document.createElement("li");

    // Left side: "14:00–14:45" on top, task below, paused time if any
    const info = document.createElement("div");
    info.className = "session-info";
    const clock = document.createElement("span");
    clock.textContent = formatClock(s.start) + "–" + formatClock(s.end);
    info.append(clock, taskLabel(s.task, s.subject));
    if (s.pausedMs >= 1000) {
      const paused = document.createElement("span");
      paused.className = "muted small";
      paused.textContent = "paused " + formatDuration(s.pausedMs);
      info.appendChild(paused);
    }

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatDuration(sessionDuration(s));

    li.append(info, time);
    dayList.appendChild(li);
  }
}

// Draw one button per recent task. Tapping it fills in task + subject.
function renderRecentTasks(sessions) {
  recentTasksBox.innerHTML = ""; // remove the old buttons
  for (const item of getRecentTasks(sessions, 5)) {
    const btn = document.createElement("button");
    btn.type = "button";
    // textContent (not innerHTML) so task names are always shown as plain text
    btn.textContent = item.task;
    if (item.subject) {
      const tag = document.createElement("span");
      tag.className = "subject";
      tag.textContent = " · " + item.subject;
      btn.appendChild(tag);
    }
    btn.addEventListener("click", () => {
      taskInput.value = item.task;
      subjectInput.value = item.subject || "";
    });
    recentTasksBox.appendChild(btn);
  }
}

// Redraw just the time. Runs a few times per second.
function updateTimerDisplay() {
  const session = loadData().activeSession;
  if (session) {
    timerDisplay.textContent = formatDuration(elapsedMs(session));
  }
}

// =====================================================================
// START-UP
// =====================================================================

document.getElementById("start-btn").addEventListener("click", startSession);
pauseBtn.addEventListener("click", togglePause);
document.getElementById("stop-btn").addEventListener("click", stopSession);
document.getElementById("today-link").addEventListener("click", () => showView("today"));
document.getElementById("today-back").addEventListener("click", () => showView("home"));
document.getElementById("history-link").addEventListener("click", () => showView("history"));
document.getElementById("history-back").addEventListener("click", () => showView("home"));
document.getElementById("day-back").addEventListener("click", () => showView("history"));

// Pressing Enter in either box also starts.
for (const input of [taskInput, subjectInput]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") startSession();
  });
}

// Update every 250ms. Ticking more often than once a second keeps the
// display from lagging behind; it does NOT affect accuracy.
setInterval(updateTimerDisplay, 250);

// When you come back to the app (unlock phone, switch apps), redraw at once.
document.addEventListener("visibilitychange", render);

render(); // draw the correct screen on page load (resumes a running session)
