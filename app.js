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

// =====================================================================
// TIMER
// The running session looks like this while active:
//   { task, start, pausedMs, pausedAt }
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
    start: new Date().toISOString(),
    pausedMs: 0,
    pausedAt: null,
  };
  saveData(data); // save immediately so a refresh loses nothing
  taskInput.value = "";
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
  // Step 2: just clear the running session. Saving it comes in step 3.
  data.activeSession = null;
  saveData(data);
  render();
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

// Show the right screen for the current state.
function render() {
  const session = loadData().activeSession;
  homeScreen.hidden = !!session;
  timerScreen.hidden = !session;

  if (session) {
    timerTask.textContent = session.task;
    pauseBtn.textContent = session.pausedAt ? "Resume" : "Pause";
    timerStatus.textContent = session.pausedAt ? "Paused" : "";
    updateTimerDisplay();
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

// Pressing Enter in the task box also starts.
taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") startSession();
});

// Update every 250ms. Ticking more often than once a second keeps the
// display from lagging behind; it does NOT affect accuracy.
setInterval(updateTimerDisplay, 250);

// When you come back to the app (unlock phone, switch apps), redraw at once.
document.addEventListener("visibilitychange", render);

render(); // draw the correct screen on page load (resumes a running session)
