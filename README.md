# Meeting Tracker tool server, eval harness and library index, v2.1

Rung 2 of the Meeting Tracker Assistant. The steps the scripts ran in v1 (scan, read, lookup, close, append, resolve a date, note, summary) are now **tools the model calls itself** from a Claude desktop chat. The state (tracker, log, held rows) lives in `data/` on this machine, so nothing is carried between sessions by hand. The four gates are enforced in code (`lib/store.js`), so the model cannot skip one.

Synthetic data only. `data/contacts.csv` stands in for a CRM.

Rung 4 adds the library: `library/index.json` lists everything built so far (the seven exemplars of Exemplar Pack v2 and the two assistants), one entry each with when to use it, inputs, output, limits and what it was tested on. Three more tools let the model search it before anything is built; `skill/check-before-build/SKILL.md` is the skill that uses them.

## Files

| Path | What it is |
|---|---|
| `server.mjs` | The server as one file. This is what the desktop app runs. No `npm install` needed. |
| `server.js`, `lib/store.js` | The source `server.mjs` is built from. `store.js` holds every rule and gate. |
| `data/` | Contacts table, transcripts, and the state (tracker, log, held rows, summaries). |
| `test/run_cases.js` | Smoke test: drives all eight transcripts through the tools as a client. Needs `npm install` first. |
| `eval.mjs` | The eval harness as one file (rung 3). No install needed. |
| `eval/` | The harness source, the expected results (`expected/`), every recorded run (`results/`), the fixed gate answers (`answers.txt`) and the living exemplar page (`EXEMPLAR.md`). |
| `skill/SKILL.md` | The copy of the skill the harness gives the model. Keep it the same as the one in your Claude account. |
| `library/index.json` | The library index (rung 4): nine entries, edited by hand. `INDEX.md` is rendered from it. `brief_template.md` is the brief returned for a new request. |
| `lib/library.js`, `library/search.js` | The search in code (word overlap, a floor, a clear-lead rule) and its script route. |
| `library/expected.json`, `library/library_test.js` | Six search cases with expected verdicts written first, and the one-command test. |
| `skill/check-before-build/SKILL.md` | The check-before-build skill: search first, return the match with its limits or the brief to fill, stop at three gates. |
| `pages/check_before_build_page.html` | The one-page workflow diagram for rung 4, in the set's theme. |

## The thirteen tools

Tracker (rung 2): `tracker_scan`, `tracker_read_transcript` (refuses a confidential file), `tracker_read_tracker`, `tracker_close`, `tracker_lookup`, `tracker_append` (Gates 1, 2, 3), `tracker_held`, `tracker_resolve_date`, `tracker_note`, `tracker_summary`.

Library (rung 4): `library_search` (the request as written in, a verdict out: MATCH with the entry's limits and tested-on line, POSSIBLE with the entries to choose between, or NEW with the nearest two named), `library_brief` (the brief template with "has it been done before" already answered), `library_index` (the whole index as a table).

## Connect it to the Claude desktop app

1. In Terminal, run `which node` and copy the path it prints.
2. Claude desktop app, Settings, Developer, Edit Config. Add this inside `"mcpServers"` (replace the node path with yours):

```json
"meeting-tracker": {
  "command": "/path/from/which/node",
  "args": ["~/Code/meeting-tracker-server/server.mjs"]
}
```

3. Quit and reopen the desktop app. In a new chat, the tools menu should list `meeting-tracker` with thirteen tools.

## Rerun every case with one command (the harness)

```
node eval.mjs --model claude-opus-5-5 --effort high
```

It copies the contacts and transcripts into an empty folder under `eval/runs/`, starts this server on it, gives the model the skill and nothing else, sends "Run the tracker", answers the gate questions with `eval/answers.txt`, checks every case against `eval/expected/`, saves the result in `eval/results/`, and rebuilds `eval/EXEMPLAR.md`. The tracker in `data/` is never touched.

It needs an Anthropic API key in a file called `.env` in this folder (see `.env.example`). Use a dedicated key with a low spend limit and delete it when you are done. Each run prints its model calls and tokens, and the page records them.

- `--model` picks the model, so the same cases can be run on a smaller tier to see whether it still passes.
- `--mock` tests the harness itself with a scripted stand-in and no API call; mock runs are never recorded on the page.
- `--page-only` rebuilds the page from the recorded runs.

## Check the library before building (rung 4)

```
node library/search.js "we get 300 Excel exports with different column headers and need one table"
node library/search.js --brief "translate our proposals into Bahasa Malaysia"
node library/search.js --list
node library/library_test.js
```

The first prints the verdict and the matching entry with its limits and tested-on line; the second prints the brief to fill for a new request; the third lists the index; the fourth reruns the six cases in `library/expected.json` and names any miss. In a chat with the server connected, the `check-before-build` skill does the same through `library_search` and `library_brief`.

To add an entry: write its five cases first, then add a line to `library/index.json` with every field filled (tested_on says "written, not run" until it runs), then `node library/library_test.js` and `node library/search.js --md`. The exemplar entries were checked against the sheets in `~/Examplers/exemplar-pack-v2` on 25 Oct 2026.

To run the skill itself against the six cases, blind, with a model (needs the `.env` key, and runs from Terminal):

```
node library/run_skill_eval.js --model claude-haiku-5-5
node library/run_skill_eval.js --model claude-opus-5-5 --effort high
```

Each case runs in a fresh conversation with the skill and the three library tools; the reply is checked for the entry named, the tested-on state carried, the limit named on case 6, the question asked on case 4, and the brief with numbered questions on case 5. Results go to `library/results/`; a miss is named with its reason.

## Start again from an empty tracker

Delete `data/tracker.csv`, `data/run_log.csv`, `data/summary_*.md` and the files in `data/held/`. The server recreates the empty files on its next start.

## Rebuild after changing the source

`npm install`, then `npx esbuild server.js --bundle --platform=node --format=esm --target=node20 --outfile=server.mjs --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"`
