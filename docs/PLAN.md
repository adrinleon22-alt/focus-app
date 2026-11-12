# Study Time Tracker (phone-first PWA)

## What this is
A personal app for my phone that tells me exactly how much time I spend studying, per day and per specific task. I am the only user. No accounts, no backend.

Main question the app must answer: **"What did I actually work on today, and for how long?"**

## Who I am (for the agent)
Student, limited coding experience. I want to understand what gets built, so:
- Explain what you are about to do before you do it, in plain language.
- Keep code simple and readable. Add short comments where something is not obvious.
- Do not add features I did not ask for.
- After each step, tell me how to test it myself.

## Tech stack (keep it boring)
- Plain HTML, CSS, JavaScript. No framework, no build step.
- Data stored in the browser (localStorage).
- PWA: `manifest.json` + a small service worker so it installs to the home screen and works offline.
- Hosting: GitHub Pages (free, HTTPS, needed for install).
- Files: `index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js`, `icons/`.

If you want to use a different stack, ask me first and explain why.

## Core features (v1 only)
1. **Pick a task, start a session.** Big Start button. Tasks can be typed fresh or picked from recent ones. Optional subject tag (e.g. Statistik, GBI).
2. **Timer.** Counts up while I work. Pause and Stop. Stopping saves the session.
3. **Today screen.** Total time today, plus a list of tasks with time per task.
4. **History.** Days listed newest first, each with total time and a per-task breakdown. Tap a day to see its sessions.
5. **Edit/delete a session** (I will forget to stop the timer sometimes, so I must be able to fix times).
6. **Export/Import as JSON.** A backup button so I never lose data.

## Not in v1 (do not build)
- App blocking, notifications, accounts, cloud sync, AI features, social features, gamification.

## Design rules
- Phone first, one-hand use. Big tap targets.
- Home screen = one big Start button + today's total. Nothing else competing.
- While a session runs: full screen timer, task name, Pause, Stop. Nothing to browse.
- Dark and light mode follow the phone.
- Plain and calm. No clutter.

## Data model
Store everything under one localStorage key, e.g. `studytracker.v1`:

```json
{
  "sessions": [
    {
      "id": "unique-id",
      "task": "Statistik Blatt 3",
      "subject": "Statistik",
      "start": "2026-11-12T14:00:00.000Z",
      "end": "2026-11-12T14:45:00.000Z",
      "pausedMs": 120000
    }
  ],
  "activeSession": null
}
```

- Duration = `end - start - pausedMs`.
- `activeSession` holds a running session (start time, task, pause info) so it survives closing the app.
- Always compute days using the **local date** (Europe/Berlin), not UTC.

## Important technical rules
- **The timer must use timestamps, not a counter.** Phones pause JavaScript when the screen is off. On every tick, compute elapsed time from `Date.now() - start - pausedMs`. Never do `seconds++`.
- Save the active session to localStorage immediately on start, pause and resume, so a crash or refresh loses nothing.
- On iOS, a home-screen app has **separate storage from Safari**. Data entered in Safari will not appear in the installed app. Use the JSON export before switching.
- Browsers can clear localStorage in rare cases. This is why the export button is a v1 feature, not a nice-to-have.

## Build steps (do one at a time, test, then commit)
1. **Skeleton.** Empty page, correct viewport meta, loads on my phone. Commit.
2. **Timer only.** Start/pause/stop with the timestamp approach. Survives refresh. Commit.
3. **Save sessions.** Stop saves to localStorage with task name. Commit.
4. **Today screen.** Total and per-task breakdown. Commit.
5. **History screen.** Per day, tap for sessions. Commit.
6. **Edit/delete sessions.** Commit.
7. **Export/Import JSON.** Commit.
8. **PWA.** Manifest, icons, service worker, offline. Deploy to GitHub Pages and install on phone. Commit.
9. **Polish.** Spacing, dark mode, empty states.

## Rules for working with the agent
- Use git from the start. Commit after every working step with a clear message.
- If something breaks, revert to the last commit instead of stacking fixes.
- If the agent loops on the same bug twice, stop. Describe the bug in plain words, what I expected, and what happened.
- Ask it to explain any code I do not understand before moving on.

## Starter prompt to paste into Claude Code
> Read PLAN.md fully. Do not write any code yet. First tell me, in plain language, how you would structure the project and what step 1 will involve. Wait for my OK before building. After each step, explain what you did and how I can test it on my phone.

## Test checklist (before I trust it)
- [ ] Start a session, lock the phone for 5 minutes, unlock: time is correct
- [ ] Close the app mid-session, reopen: session still running
- [ ] Pause and resume: paused time is excluded
- [ ] Session across midnight is handled sensibly
- [ ] Today total matches the sum of its sessions
- [ ] Export, clear data, import: everything comes back
- [ ] Works in airplane mode after first load
- [ ] Installed to home screen, opens full screen

## Later ideas (only after I have used v1 for a week)
Weekly chart, subject totals, daily goal, tags, a simple reminder, an AI review of my week.
