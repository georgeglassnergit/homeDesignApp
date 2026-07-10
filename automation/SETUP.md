# Autonomous daily dev run — setup (one-time)

The daily run is fully designed (`automation/daily-dev-run.md`). Turning it on needs a GitHub repo + a repo-connected cloud environment, because an unattended 5am run **cannot** reach your Box folder (the device bridge needs your desktop app open) and this ad-hoc session **cannot push** (its proxy token only clones public repos). A proper repo-bound environment fixes both — it clones on start and has real push credentials.

## Step 1 — Create the GitHub repo
Create a new **private** repo under your GitHub account, e.g. `home-design-app`. Don't initialize it with a README (this code already has one).

## Step 2 — Push this code
From the unzipped repo folder on your machine (needs git + normal internet):

```
cd home-design-app
git init && git add . && git commit -m "Home Design App: platform (Phase 1 app + Phase 2 core) + daily automation"
git branch -M main
git remote add origin https://github.com/<your-username>/home-design-app.git
git push -u origin main
```

## Step 3 — Create a repo-connected environment
In **Claude Code on the web** (code.claude.com → Environments), create an environment connected to `home-design-app`. Pick a network policy that allows **web search + git/GitHub** (the run needs search for the landscape scan and git to clone deps + push). Docs: https://code.claude.com/docs/en/claude-code-on-the-web

## Step 4 — Schedule the daily run (5am ET)
Create a scheduled task **in that environment** whose prompt is the full contents of `automation/daily-dev-run.md`, on a daily cron.

- **Timezone:** the scheduler runs in **UTC**. 5am **ET** = **09:00 UTC** during daylight time (Mar–Nov) → `0 9 * * *`. When DST ends (Nov), 5am ET = 10:00 UTC → change to `0 10 * * *`. If the scheduling UI offers a timezone, set `America/New_York` and it handles DST for you.
- The run is timeboxed to ~90 min and hard-stops by 6:55am ET, comfortably inside your "done by 7am."

**I (Account B) can create this scheduled task for you** via the scheduling tool once the repo-connected environment exists — just give me its environment ID (or run the scheduling request from inside that environment) and I'll wire it to the 5am cron with this prompt.

## What each run does
30 min review + landscape research to pick the single highest-value revision → ~55 min implement + headless-verify (vendoring Three.js via git clone, screenshotting with the bundled Chromium) → ~5 min log to `DEV-LOG.md`, push a dated branch, and open a PR for your review. Nothing auto-merges to `main`; you approve each day's work.
