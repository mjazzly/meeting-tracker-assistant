# Meeting Tracker Assistant

Turns meeting transcripts into an action tracker the model keeps itself. It looks every named person up in a contacts table through a tool it calls, appends to the tracker without overwriting, closes actions a later meeting resolves, and stops to ask at four gates rather than guess: a name that matches two people, a meeting with no actions, a date before the meeting it was set in, and a transcript marked confidential.

**Owner:** Megat Jazly. **Current version:** v2.0. **Limits:** synthetic transcripts and a synthetic contacts table that stands in for a CRM; one folder; no scheduling; no external system connected.

**Tested on:** claude-opus-5-5 (effort high), 2026-10-25, automated harness run: 5 of 5 cases matched, decline held, bar met.

**The bar:** four of the five cases matched and the decline holding, against expected results written before the first run. A miss is named with its line, never rounded up.

## Run history

| Date | Run | Skill | How it ran | Model | Cases matched | Decline | State cases | Counted | Tokens in / out |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-24 | Run 1 | v1.0 | chat, by hand | claude-opus-5-5 high | not counted | not counted | not counted | no | not recorded |
| 2026-10-24 | Run 2 | v1.1 | chat, by hand | claude-opus-5-5 high | 4 of 5 | held | 2 of 2 | yes | not recorded |
| 2026-10-24 | Run 3 | v2.0 | chat, by hand | claude-opus-5-5 high | 5 of 5 | held | 2 of 2 | yes | not recorded |
| 2026-10-24 | E202610242218-haiku-5-5 | v2.0 | harness, automated | claude-haiku-5-5 | 4 of 5 | held | 2 of 2 | yes | 445,166 / 17,547 |
| 2026-10-24 | E202610242220-opus-5-5-high | v2.0 | harness, automated | claude-opus-5-5 high | 5 of 5 | held | 2 of 2 | yes | 542,346 / 10,588 |
| 2026-10-25 | E202610251245-haiku-5-5 | v2.0 | harness, automated | claude-haiku-5-5 | 4 of 5 | held | 2 of 2 | yes | 40 / 18,065 |
| 2026-10-25 | E202610251246-opus-5-5-high | v2.0 | harness, automated | claude-opus-5-5 high | 5 of 5 | held | 2 of 2 | yes | 50 / 11,169 |

## What each run found

- **Run 1:** Not blind: the answer key was shipped inside the folder and the model read it partway through, so the run is not counted. Before that point, case 2 dropped the unowned sales briefing. The run also found two errors in the answer key (corrected, with the reason recorded) and four design holes, all fixed in v1.1.
- **Run 2:** First blind run. Four of five; the miss was case 3 line 6, a sentence about how interviews will be run taken as an unowned action. It came from v1.1's own fix for run 1. The v1.2 rule followed: an action needs something at the end that someone could check was done.
- **Run 3:** First run on connected tools: the model called the tool server on the owner's machine for every step; no file was carried by hand. Five of five; the run 2 miss did not recur, and the model logged seven notes explaining its close calls.

## Latest counted run, case by case (E202610251246-opus-5-5-high)

| Case | Result | Why not, if not |
|---|---|---|
| 1. Clean | Match |  |
| 2. An action with no owner | Match |  |
| 3. A relative date with no meeting date | Match |  |
| 4. A name that matches two people | Match |  |
| 5. No actions | Match |  |
| 6. Confidential (must decline) | Match |  |
| State: a later meeting closes an action | Match |  |
| State: a date before the meeting | Match |  |

## How a harness run works

One command starts the tool server on an empty copy of the data, gives the model the skill and nothing else, and lets it run the whole tracker through the tools. When it stops at its gates, the harness answers with the same fixed message every run. The checker then compares the result with the expected results, which the model never sees, and this page is rebuilt from every recorded run.

Rerun after any change to the skill or the server: `node eval.mjs --model <model id>`.
