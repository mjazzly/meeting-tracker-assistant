# WORK-08 design note: the tracker runs on its own

Step 1 of HOSTED-BRIEF.md. Approved by Megat on 6 Nov 2026 with four changes, all applied below: the save order and the `mt:pushing` flag (One run, steps 3 and 11; cases H18 to H20); heartgold is a personal Gmail, so no shared drive; and two checks added to step 3 (the desktop sign-in first, the owner name a visitor sees before the folder is made public).

## What changed from the brief, and why

Reading the code and the current platform docs turned up five things the brief does not cover. Each one is settled below; the reason is given here once.

1. **A service account cannot create files in a personal Drive.** Google gives service accounts no storage quota, so a new file it tries to add to a folder in heartgold's My Drive is refused (403 `storageQuotaExceeded`). It can read anything shared with it and can change the content of a file it can edit, because that file stays heartgold's. The brief kept this as the step 4 fallback. This design makes it the plan from the start. **Every file the service touches exists before the first run, is owned by heartgold, and is only ever updated in place.** No per-run file names, no deletes. Step 3 tests this by its effect (a create is refused, an update goes through) before anything else is set up. A shared drive would remove the limit, but it needs a Workspace account, and heartgold is a personal Gmail account. The fixed-file layout stays.
2. **The feeder fills slots; it does not create files.** The eight transcript files sit in `transcripts/` from the start, empty. To feed transcript 03, the service writes its text from the repo into the empty `03_northgate_claims.txt`. To reset, it empties the file again. The runner hands `lib/source.js` a Drive wrapper whose `list` leaves out empty files, so an empty slot is never seen, never flagged and never read. `source.js` stays unchanged.
3. **Each run starts with an empty temp folder.** A Vercel function keeps nothing between calls. `store.js` needs the transcript file on disk for the gates it checks on an answer (Gate 3 reads the meeting date from the header) and for a held row's append. So the pull step also downloads every transcript the run log already records, by its file id, the same way `source.js` reads it (header only for a confidential file).
4. **Answers are applied by the model, in words, as today.** `/held` turns each form answer into one plain sentence ("04_halden_finance.txt: Priya Nair is Halden Logistics, Finance Director."). The next run sends the waiting sentences as its opening message, and the model applies each with one call, as skill step 10 says. This is the path the harness's passing records used, and it is the path CI can test with `eval/answers.txt` word for word. `store.append` still checks every gate again, so a badly applied answer is refused in code.
5. **The smallest model meets the bar exactly.** Both of its harness records score four of five, with case 3 missed each time (the due date said without "by"). CI therefore sits on the edge: one more miss turns it red. That is the gate working as intended, not a flaw in the design. It is stated here so a red run on a quiet push is not a surprise.

Two smaller ones. `server.js` registers its ten tools at module level and connects them to stdio, so the in-memory connection needs the registration moved into `lib/tools.js`, used by both. No tool's name, description or schema changes, and `npm test` proves it. And the public routes read a snapshot the run writes to Upstash, never Drive, so a visitor cannot cost a Drive call or a model call.

## The eight decisions, as decided

| # | Decision | Decided | Note |
|---|---|---|---|
| 1 | Host | Vercel Hobby on mjazzly, project `meeting-tracker`, root `hosted/` | Plain Node functions, no framework. Fluid compute: 300 seconds max on Hobby (Vercel docs, read 6 Nov 2026). |
| 2 | Drive access | Service account, scope `drive`, sees only what is shared with it | With the fixed-file layout above. The OAuth path stays for the desktop app, unchanged. |
| 3 | Where the state lives | The Drive folder | Upstash holds only the lock, the counters, the kill switch and the public snapshot. The folder is the record of truth; the snapshot is rebuilt from it every run. |
| 4 | Daily trigger | Vercel Cron, `0 23 * * *` UTC | Hobby fires anywhere in that hour, so 7:00 to 7:59 AM Kuala Lumpur. cron-job.org calling `/api/run` with `RUN_TOKEN` is the fallback if Vercel creates no runs. Vercel is moving Cron to "Schedules"; step 3 checks which one the project shows. |
| 5 | Feeder and 28-day cycle | Yes | Slots, as above. |
| 6 | Transcripts per invocation | Two | `maxDuration` 300 on `/api/run`. The runner also stops starting a new model call after 240 seconds, keeps what is done, and carries the rest. The eight-case CI path runs the runner as plain Node with no time limit. |
| 7 | The entry | WORK-08, chaining off WORK-01 | WORK-01 stays as its record. |
| 8 | Who answers held questions | Megat on `/held` | The answer path CI tests. |

## Routes

| Route | Who reaches it | What it does |
|---|---|---|
| `GET /` | anyone | The board as last released, the questions waiting on a person (read only, with how many and since which run), the last run's line, the cycle day. Read from the Upstash snapshot. No form, no secret. |
| `GET /api/run` | Vercel Cron (`Authorization: Bearer CRON_SECRET`); Megat (`Authorization: Bearer RUN_TOKEN`) | One run, below. With `RUN_TOKEN` only, `?feed=next` feeds the next empty slot first. Anything else: 401, no lock taken. |
| `GET /board` | anyone | The board's own page from the snapshot, shown in a frame on `/`. |
| `GET /api/state` | anyone | Read-only JSON from the snapshot: last run, the last 30 run lines, counts, held count and since which run, cycle day, skill version, model tier and model id. The record job reads this. |
| `GET /held`, `POST /held` | Megat with `ANSWER_TOKEN` (`/held?token=…` once sets an HttpOnly cookie, then redirects to drop it from the address bar) | Each held row with the gate's own question and one form: Gate 1, the matching contacts to choose from; Gate 2, confirm no actions, or give the line missed; Gate 3, a corrected date, or accept it as said; a meeting date for a transcript that had none. A save takes the lock, adds the sentence to `tracker/answers.json`, releases. If a run holds the lock, the page says so and nothing is saved. |

Failed token attempts on `/api/run` and `/held` are counted per hashed IP (`IP_SALT`); ten in a day closes that IP for the day.

## The folder

One folder in heartgold's My Drive, **anyone with the link can view**, shared with the service account as **Editor**.

```
Meeting tracker/
  transcripts/   01_halden_kickoff.txt … 08_meridian_contracts.txt   (empty until fed)
  tracker/       tracker.csv  run_log.csv  held.json  answers.json  summary.md
  released/      board.html
```

All fourteen files are made once by `hosted/scripts/make-folder.js`, which Megat runs from Terminal with his existing desktop sign-in, so heartgold owns them. The script prints the three folder ids and nothing secret. The contacts table (stands in for a CRM) ships with the function from the repo's `data/contacts.csv`; it is not state.

How the store's files map to the folder (the runner does the mapping; `store.js` sees its usual layout):

| In the run's temp folder | In Drive |
|---|---|
| `tracker.csv`, `run_log.csv` | `tracker/tracker.csv`, `tracker/run_log.csv` |
| `held/<transcript>.json`, one per held transcript | `tracker/held.json`, all of them in one array |
| (none) | `tracker/answers.json`: sentences saved on `/held`, each marked with the run that applied it |
| `summary_<run>.md`, `board_<run>.html` | `tracker/summary.md`, `released/board.html`, the latest only. Earlier runs live in the record and in Drive's version history. |

## One run

| # | Step | Done by | What can stop it |
|---|---|---|---|
| 1 | Check the caller | the route | Wrong or missing token: 401. No settings (a preview deployment has none): "not configured", nothing touched. |
| 2 | Take the lock: `SET mt:lock NX EX 600` | runner, Upstash | Lock held: one line in Upstash's run list, 409, stop. Nothing written to Drive. |
| 3 | Kill switch, month budget, unfinished save | runner, Upstash | `mt:kill` is `on`, or this month's counted spend has reached the budget in code: run line, unlock, stop. No feed, no model call. `mt:pushing` is set: the last save did not finish. Run line "needs a person: the last save did not complete" (naming what the flag holds), unlock, stop. No reset, no feed, no Drive write, no model call. |
| 4 | Cycle | runner, `cycle.js` | Day 1 of a cycle, first run that day (`SET NX` on the cycle's reset key): every state file rewritten to its empty form, every slot emptied, snapshot cleared. |
| 5 | Feed | runner, `feeder.js` | Day 1 to 8: every empty slot up to today's number is filled from the repo, in file order (so a missed day catches up). Manual `feed=next`: the next empty slot only. |
| 6 | Pull | runner, Drive | `tracker/` into the temp folder, held rows split back into `held/`, every transcript the log records downloaded by file id. The unfinished-save check ran at step 3, before the reset and the feed could write anything. |
| 7 | Scan | `source.js` then `store.scan` | Nothing new and no answers waiting: run line "nothing new", push the log, unlock, stop. No model call. |
| 8 | Cap | runner | More than two new: the first two stay; the rest are taken out of this run's temp folder and a note names them as carried to the next run. |
| 9 | The model runs the skill | smallest model over the ten tools, in memory | The gates, exactly as today. Per run: at most 40 model calls and 20,000 output tokens; after 240 seconds no new call starts. Any cap reached: what is done is kept, the run line names the cap, an unfinished transcript is simply new again next run. |
| 10 | Summary and board | `store.summary` (the model calls it) | |
| 11 | Save | runner, Drive | Before the first Drive write of a save, `SET mt:pushing <run id>`. Order: `tracker.csv`, `held.json`, `answers.json` (marking what was applied), `summary.md`, `released/board.html`, then `run_log.csv` last. `mt:pushing` is cleared only after `run_log.csv` is saved. A save that stops anywhere in between (a Drive error, the function's time limit) leaves the flag set, and step 3 of the next run stops on it. Because `tracker.csv` is saved before `answers.json`, an answer can be marked applied in Drive only when the tracker rows it produced are already there. Every save follows this rule, including the reset's and a nothing-new run's (which saves `run_log.csv` alone). |
| 12 | Snapshot and run line | runner, Upstash | Run line to the log and to the run list (fed, new, read, held, closed, model calls, input and output tokens, cost in US dollars from `eval/prices.json`). Month spend counted with one `INCRBY`. |
| 13 | Unlock | runner | Always, in a `finally`, after step 2 succeeded. |

Clearing `mt:pushing` is a person's job, never the service's: open the folder, compare `tracker.csv`, `held.json`, `answers.json` and `run_log.csv` with the run the flag names, put right what the half-finished save left, then `DEL mt:pushing` in the Upstash console. The README gives the steps.

The model is fixed in code as the smallest tier (`claude-haiku-5-5`) at **high effort**, with prompt caching on, as in the harness. High effort was chosen on 6 Nov 2026 from measured passes ("Effort, measured" below). The month budget in code is US$3, under each workspace's US$5 limit. A full pass of eight cost US$0.02 to US$0.05 on the harness records, so the budget is a backstop, not a forecast.

## The cycle

`CYCLE_START` is a date setting. Day = days since `CYCLE_START` in Kuala Lumpur time, mod 28, plus one. Day 1 resets and feeds 01; days 2 to 8 feed one each, so 07 and 08 arrive after the ones they close; days 9 to 28 find nothing new and say so at no model cost. The record job has already written the previous cycle's days to the repo before a reset.

Step 4's evening pass (eight manual `feed=next` calls) runs before `CYCLE_START`, so the first cycle proper begins from a reset the next morning.

## CI: `.github/workflows/cases.yml`

On every push to any branch, and on dispatch. Only `main` can move `live`.

1. **No key:** `npm test`, `node test/drive_cases.js`, `node test/hosted_cases.js`.
2. **With the `tracker-ci` key:** `node hosted/ci.js`, the runner's own code against the fake Drive with the setup script's empty layout, on the smallest model at the service's own settings. Two cadences, both marked by `eval/check.js` against the bar in `harness.json`, every miss printed by case and line:
   - **Live cadence, the gate.** What the service does: one transcript fed and read per run. After each run, every question it held is answered through the `/held` path with the sentence the form writes, so each answer is applied in the next run, alongside the next transcript (runs 5, 6 and 9). The form's choices say what `eval/answers.txt` says; 03's meeting date is left unanswered, as the key leaves it. If the bar is not met, the live pass runs once more; red only if that pass misses too.
   - **Batched cadence, recorded, not gating.** Two transcripts per run, as after a missed day, then `eval/answers.txt` word for word in a run with nothing new.
   Changed on 6 Nov 2026 after step 4: CI had gated only on the batched cadence, which the service never runs on a normal day. See "Why the live pass and CI differed" below.
   `node hosted/ci.js --measure N [--effort high]` runs N live-cadence passes with no gate and prints a per-case tally, to choose a model or effort by. `--effort` exists only there; the service never sets one.
3. **On `main` only:** commit the record to `results/ci/` with the `[ci]` prefix, green or red, so the record shows every time the gate held as well as every pass. **On green only**, fast-forward `live` to the commit that passed. Commits made with the workflow's own token start no new workflow run.

A ruleset on `live` blocks force pushes and deletion and restricts updates to the Actions app. If GitHub does not allow that bypass on this repo, the rule stays written down, and the record shows that every move of `live` came from a workflow run. As set on 6 Nov 2026 (ruleset "live moves only from CI", active): GitHub offered no GitHub Actions entry in the bypass list, so the ruleset blocks deletion and force pushes only, and "restrict updates" is off, since with no bypass it would refuse the workflow's own fast-forward. Every move of `live` names its workflow run in `results/ci/`.

Weekly rerun: cron-job.org calls the dispatch endpoint with a fine-grained token limited to Actions on this repo, as the scorecard's does.

**The record:** `.github/workflows/hosted-record.yml`, daily at 8:30 AM Kuala Lumpur, reads `/api/state` (no secret) and writes `results/hosted/<date>.json`. If GitHub's scheduler creates no runs, the same cron-job.org dispatch as the scorecard. Every number on the page is read from `results/hosted/` and `results/ci/`.

## Secrets and settings

Megat creates every one. None is pasted into this chat or written into the repo. Every Vercel variable is scoped to **Production only**, so a preview deployment has no key and step 1 refuses it.

| Name | What it is | Lives in | Expires |
|---|---|---|---|
| `ANTHROPIC_API_KEY` (service) | Key in Console workspace `tracker-hosted`, US$5 a month limit | Vercel | 90 days |
| `ANTHROPIC_API_KEY` (CI) | Key in Console workspace `tracker-ci`, US$5 a month limit | GitHub Actions secret | 90 days |
| `GOOGLE_SA_KEY` | Base64 of the service account's JSON key | Vercel | No expiry on Google's side; rotated with the API keys every 90 days |
| `DRIVE_FOLDER_ID`, `DRIVE_TRANSCRIPTS_ID`, `DRIVE_TRACKER_ID`, `DRIVE_RELEASED_ID` | Folder ids, not secret | Vercel | |
| `CRON_SECRET` | Random, `openssl rand -hex 32` | Vercel (Cron sends it itself) | None; rotate on any doubt |
| `RUN_TOKEN` | Random | Vercel, and Megat's password manager | None |
| `ANSWER_TOKEN` | Random | Vercel, and Megat's password manager | None |
| `IP_SALT` | Random | Vercel | None |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis, added from the Vercel Marketplace (Vercel sets these itself) | Vercel | None |
| `CYCLE_START` | A date | Vercel | |
| `HOSTED_URL` | The service's address, not secret | GitHub repository variable | |
| Dispatch token | Fine-grained GitHub token, Actions read and write on this repo only | cron-job.org | 90 days |

## Step 3, in order

Megat runs each item; Claude Code prints one at a time, waits, and checks it by its effect.

1. **The desktop Drive sign-in first.** A read-only check that the token in `~/.config/meeting-tracker/` still refreshes. If it has expired (a Testing app signs out after 7 days), Megat runs `node server.mjs --auth` before anything else.
2. The two Console workspaces and their keys.
3. On the existing Google Cloud project: the Drive API on, the service account made, its key downloaded.
4. `node hosted/scripts/make-folder.js`: the folder, its three subfolders and fourteen files, owned by heartgold. The folder is shared with the service account as Editor. **It is not made public yet.**
5. **The probe**: the service account updates one file (expected to work) and tries to create one (expected to be refused for quota). Run on 6 Nov 2026 against the real folder: the update in place worked, and the create was refused with `storageQuotaExceeded`. The fixed-file layout is confirmed, not assumed.
6. **Before the folder is made public**, Megat opens the folder's link in a private window and checks the owner name a visitor sees there. If it is not the name he wants shown, he changes heartgold's display name at myaccount.google.com, Personal info, Name, and checks again. Only then is the folder set to "anyone with the link can view". Done on 6 Nov 2026: the account name was changed to Megat Jazly first. Once the folder was public, a signed-out private window showed "Owner hidden" on every item, with no name and no email, and offered only view and download.
7. The Vercel project, the settings table, Upstash, the cron; the GitHub secret and variable; the cron-job.org job.

## Cases for `test/hosted_cases.js`

Written before any code. Each runs the runner against the fake Drive (extended for subfolders, the service account sign-in and the quota rule: a create by the service account is refused) and a scripted model that records every call.

| # | Case | Expected |
|---|---|---|
| H1 | Nothing new, no answers | Scripted model called 0 times. Run line "nothing new". Only `run_log.csv` changes in Drive. |
| H2 | Day 1 with an empty folder | Reset runs, slot 01 filled from the repo, 01 read, rows appended, `released/board.html` and `tracker/tracker.csv` updated in place, snapshot written. No create call reaches Drive. |
| H3 | Reset runs once | A second run on day 1 does not reset again; it finds nothing new. |
| H4 | Reset over a full cycle | Every state file back to its empty form (tracker and log headers only, `[]` in the JSON files), every slot empty, then 01 fed. The fake Drive holds the same file ids as before. |
| H5 | Empty slots are invisible | Slots 05 to 08 empty: the source lists only 01 to 04, writes no "skipped" flag, the scan names none of them. |
| H6 | A gate holds | 04 fed; the scripted append for Priya Nair has no company: stop logged, `held.json` holds the rows and the question, snapshot says one waiting since this run. The public page shows the question and no form. |
| H7 | An answer is saved | `POST /held` with the cookie adds one sentence to `answers.json`. Tracker unchanged. |
| H8 | No token, wrong token | `/held` and `/api/run` return 401; nothing saved, no lock taken; the IP counter goes up. |
| H9 | The next run applies it | Nothing new, one answer waiting: the model IS called; its opening message carries the sentence; the append with the company goes through; `held.json` empty; the answer marked with this run; the summary has "Answered this run". |
| H10 | The lock refuses a second run | Lock held: 409, one line in the run list, no Drive call, no model call. |
| H11 | Answer while a run holds the lock | `/held` says a run is in progress; nothing saved. |
| H12 | Cap carries the rest | Three slots filled at once: two read this run, a note names the third as carried; the next run reads it with no feed. |
| H13 | Confidential transcript | 06 fed: only a Range request reaches its body; declined; no model message contains a line past its header. Pulled again on the next run, still header only. |
| H14 | Restore on pull | An answer for 08 (Gate 3) applied two runs after 08 was read: 08 is downloaded by file id on pull, and the append with the date as said goes through. |
| H15 | Kill switch, then budget | `mt:kill` on: run line says so, no feed, no model call. Then month spend at the budget: the same, naming the budget. |
| H16 | Per run caps | A scripted model that never stops: run ends at 40 calls, keeps finished transcripts, leaves the unfinished one new; the next run reads it. |
| H17 | Time guard | Scripted model with a delay: no new call starts after the limit (shortened for the test); the run line names it. |
| H18 | Save fails at the log | The fake Drive fails the `run_log.csv` update: `mt:pushing` stays set, the lock is released. The next run stops at pull with "needs a person: the last save did not complete", no feed, no Drive write, no model call. |
| H19 | Save fails after `tracker.csv`, before `held.json` | A run applying an answer: `tracker.csv` in Drive has the new rows; `held.json` and `answers.json` are unchanged, so the answer is not marked applied. `mt:pushing` stays set; the next run stops as in H18. |
| H20 | Save fails after `held.json`, before `answers.json` | `tracker.csv` and `held.json` saved; `answers.json` unchanged, so no answer is marked applied. `mt:pushing` stays set; the next run stops as in H18. In H18, H19 and H20 alike, every answer marked applied in Drive has its tracker rows saved. |
| H21 | Public routes cost nothing | `GET /` and `GET /api/state` make no Drive call and no model call, and contain no token, key or folder edit link. |
| H22 | Preview has no settings | Without the keys: "not configured", no Drive call, no lock. |

## What is not changed

`lib/store.js`, `lib/source.js`, `eval/expected/`, `eval/check.js`, `eval/answers.txt`, the bar in `harness.json`. `lib/drive.js` gains the service account sign-in in a new `lib/drive-sa.js`, same `list`, `download`, `upload` shape, Node only, no package added. `server.js` keeps its stdio wiring and imports the tools from `lib/tools.js`. `skill/SKILL.md` moves to v2.1 in its limits line and version log only.

New packages, in `hosted/package.json` only: `@upstash/redis`, as in the demo.

## Step 4, as run (6 Nov 2026)

Ten manual runs from Terminal with `RUN_TOKEN` (`R2026-11-06-1` to `-10`), one transcript fed per run, then the edit check (`-11`). The record of all eleven is `results/hosted/2026-11-06.json`, written by the record job started by hand before the first cycle's reset.

- **Gates.** Gate 1 held 04 (Priya Nair, two contacts); Gate 2 held 05; Gate 3 held 08 (line 2 due 2026-10-15, meeting 2026-10-22); 06 was declined from its header alone, its body never downloaded; 03's two dates went to `confirm` with the meeting date question.
- **Answers.** Gate 1 answered on `/held` and applied by run 5; Gates 2 and 3 answered and applied by run 10. 03's meeting date left unanswered, as the key leaves it. Each answer was marked applied only in the run whose tracker rows were saved first.
- **Drive.** Every write was an update in place by the service account; nothing was created or deleted.
- **Edit check.** 02 given a new version in Drive (same file id): run 11 flagged it as edited after it was processed, read nothing twice, made no model call, and left `tracker.csv` byte for byte unchanged.
- **Against the key** (eval/check.js on the folder's final state): 2 of 5 matched, the decline held, both state cases held; below the bar. 01 took line 2 as an action; 03 dropped "by" from both dates; 05 did not close 02 line 5. The three CI passes on the same code and model before and around it met the bar (4, 5 and 4 of 5). The misses are the smallest model's reading on one live pass; the service's own parts (gates, answers, saves, decline, edit flag) all held.
- **Cost.** US$0.0298 for the eleven runs, all in the `tracker-hosted` workspace; the two runs with nothing to read cost nothing.

## Why the live pass and CI differed (6 Nov 2026)

Compared input by input. The same on both paths: every transcript's bytes (the MD5 the service logged equals the repo file's), the skill, the tools, the store and the runner (identical blobs at all three CI commits; the live runs were served by `c471088`), the model and its settings. Temperature cannot be set on these models, so the same input can give a different reading from run to run on either path.

Different: CI read two transcripts per run and applied `eval/answers.txt` once, after all eight, in a run with nothing new; the service reads one per run and applies each `/held` answer in the next run, sometimes alongside a new transcript.

Per miss, against the five earlier smallest-model runs (three CI passes, two harness runs): 03's dropped "by" missed in 4 of 5 on both paths, so it is the model on that input, not the path. 05's missing closure matched in 5 of 5 earlier; the live run that missed it first applied the Gate 1 answer for 04 and never called `tracker_read_tracker`, a run shape CI had never exercised, so it is most likely the path. 01's line 2 matched in 5 of 5 earlier on an input that differed only in the scan listing one transcript instead of two; unresolved by one live sample. CI now gates on the live cadence, and repeated measured passes settle the rest.

## Effort, measured (6 Nov 2026)

Five live-cadence passes each with `node hosted/ci.js --measure 5`, on the smallest model, the code as committed with this note; records in `results/ci-measure/` (`M202611060220-local.json` at the default effort, `M202611060235-local-high.json` at high).

| | Default effort | High effort |
|---|---|---|
| Bar met | 3 of 5 | 5 of 5 |
| Of the five cases, matched per pass | 4, 3, 4, 4, 3 | 4, 4, 4, 4, 4 |
| 01, 04, 06, 07 | 5 of 5 each | 5 of 5 each |
| 02 | 4 of 5 (a due date read as 2024, so Gate 3 fired) | 5 of 5 |
| 03 | 0 of 5 ("by" dropped) | 0 of 5 ("by" dropped) |
| 05 | 4 of 5 (Gate 2 did not fire once) | 5 of 5 |
| 08 | 4 of 5 (one row left at `confirm`) | 5 of 5 |
| Cost a pass | US$0.025 | US$0.033 |

What it settles about the step 4 live pass (2 of 5): 01's line 2 and 05's missing closure matched in every live-cadence pass at both efforts, including the run that applies an answer and reads a new transcript together, so on the morning they were the default effort's one-off slips, not the path. 03 missed in every pass at both efforts: the skill's due-date wording, which sheet v1.1 addresses as its own change. One tier up was priced (about twenty times the cost per token) and not measured; high effort on the smallest model met the bar in every pass for about a third more.

From this commit the service and the CI gate both run at high effort (`EFFORT` in `hosted/lib/runner.js`); `--effort` in the measure mode is the only override.
