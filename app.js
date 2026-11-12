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
  edit: document.getElementById("edit-screen"),
};

// Which screen to show when no timer is running: a name from `screens`.
// (While a session runs, the timer screen always wins.)
let currentView = "home";
// Which day the day screen shows, e.g. "2026-11-12".
let selectedDay = null;

// Going DEEPER (Home -> History -> Day -> Edit): remember the step in the
// browser history, so the phone's back gesture can undo it.
function openView(view) {
  history.pushState({ view: view }, "");
  showView(view);
}

// Going BACK: all Back buttons call this, exactly like the back gesture.
function goBack(steps = 1) {
  history.go(-steps);
}

// Show a screen without touching the browser history.
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
    // "edit" needs nothing here: openEdit() filled the form once already.
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
      openView("day");
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
    // The whole row is a button: tap it to edit this session.
    const row = document.createElement("button");
    row.type = "button";
    row.className = "session-row";
    row.addEventListener("click", () => openEdit(s.id));

    // Left side: "14:00–14:45" on top, task below, paused time if any
    const info = document.createElement("span");
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

    row.append(info, time);
    li.appendChild(row);
    dayList.appendChild(li);
  }
}

// =====================================================================
// EDIT / DELETE A SAVED SESSION
// =====================================================================

const editTask = document.getElementById("edit-task");
const editSubject = document.getElementById("edit-subject");
const editStart = document.getElementById("edit-start");
const editEnd = document.getElementById("edit-end");
const editPaused = document.getElementById("edit-paused");
const editDuration = document.getElementById("edit-duration");
const editError = document.getElementById("edit-error");

// The session being edited, exactly as it was when the form opened.
let editingOriginal = null;

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
  editingOriginal = s;
  editTask.value = s.task;
  editSubject.value = s.subject || "";
  editStart.value = toLocalInputValue(s.start);
  editEnd.value = toLocalInputValue(s.end);
  editPaused.value = Math.round(s.pausedMs / 60000);
  editError.hidden = true;
  updateEditDuration();
  openView("edit");
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
    subject: editSubject.value.trim(),
    start: start,
    end: end,
    pausedMs: pausedMs,
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
  if (index === -1) return; // session no longer exists
  data.sessions[index] = updated;
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
  // Back to the day; if that day is now empty, back to History instead.
  const left = sessionsOnDay(data.sessions, selectedDay);
  goBack(left.length > 0 ? 1 : 2); // 2 steps = skip the now-empty day, land on History
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
    });
  }
  saveData(data);
  showBackupMessage("Imported " + countSessions(newSessions.length) + ".");
  render(); // redraw History with the new days
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
document.getElementById("today-link").addEventListener("click", () => openView("today"));
document.getElementById("today-back").addEventListener("click", () => goBack());
document.getElementById("history-link").addEventListener("click", () => {
  showBackupMessage(""); // don't show an old backup message
  openView("history");
});
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
document.getElementById("edit-delete").addEventListener("click", deleteEdit);
// Update the duration preview whenever any edit field changes.
for (const input of [editStart, editEnd, editPaused]) {
  input.addEventListener("input", updateEditDuration);
}

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

// Back gesture / Back button: the browser tells us which step we went back to.
window.addEventListener("popstate", (event) => {
  let view = (event.state && event.state.view) || "home";
  // After a page reload we no longer know which day or session was open,
  // so fall back to History instead of showing a broken screen.
  if ((view === "day" && !selectedDay) || (view === "edit" && !editingOriginal)) {
    view = "history";
  }
  showView(view);
});

// The app always starts on Home; mark that as the first step in the history.
history.replaceState({ view: "home" }, "");

render(); // draw the correct screen on page load (resumes a running session)

// Turn on offline support (see sw.js). Browsers only allow this on
// https:// or on localhost, so over plain http on Wi-Fi it's skipped.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((error) => {
    console.log("Offline support not available here:", error);
  });
}
