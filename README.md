# Meeting Tracker tool server, eval harness and library index, v2.2

Rung 2 of the Meeting Tracker Assistant. The steps the scripts ran in v1 (scan, read, lookup, close, append, resolve a date, note, summary) are now **tools the model calls itself** from a Claude desktop chat. The state (tracker, log, held rows) lives in `data/` on this machine, so nothing is carried between sessions by hand. The four gates are enforced in code (`lib/store.js`), so the model cannot skip one.

Synthetic data only. `data/contacts.csv` stands in for a CRM.

v2.2 adds a second source for the transcripts: **a Google Drive folder, read through the Drive API**. It runs on this machine against a folder in the cloud. The local folder stays the source for the blind harness. See [Read the transcripts from a Google Drive folder](#read-the-transcripts-from-a-google-drive-folder).

Rung 4 adds the library: `library/index.json` lists everything built so far (the seven exemplars of Exemplar Pack v2 and the two assistants), one entry each with when to use it, inputs, output, limits and what it was tested on. Three more tools let the model search it before anything is built; `skill/check-before-build/SKILL.md` is the skill that uses them.

## Files

| Path | What it is |
|---|---|
| `server.mjs` | The server as one file. This is what the desktop app runs. No `npm install` needed. |
| `server.js`, `lib/store.js` | The source `server.mjs` is built from. `store.js` holds every rule and gate. |
| `data/` | Contacts table, transcripts, and the state (tracker, log, held rows, summaries). |
| `test/run_cases.js` | Smoke test: drives all eight transcripts through the tools as a client. Needs `npm install` first. |
| `lib/drive.js`, `lib/source.js` | The Drive source (v2.2): sign-in and the Drive API calls, and the adapter that copies new transcripts from the folder into the run's transcripts folder. `store.js` is unchanged. |
| `test/drive_cases.js`, `test/fake_drive.js` | Offline test of the Drive source against a stand-in for the Drive API: the same calls as the smoke test, then edits, a rename, a duplicate name and a new file. |
| `test/drive_edit_check.js` | Live check of the edit flag against the real folder, after a Drive harness run. |
| `eval/results-drive/`, `eval/SOURCES.md` | Drive harness runs, recorded apart, and the page that sets each beside the local run on the same model. |
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

To have the desktop app read from the Drive folder instead, add the source and the folder to `args` (the state then lives in `data-drive/`, apart from `data/`):

```json
"args": ["~/Code/meeting-tracker-server/server.mjs", "--source", "drive", "--folder", "<Drive folder id>"]
```

## Rerun every case with one command (the harness)

```
node eval.mjs --model claude-opus-5-5 --effort high
```

It copies the contacts and transcripts into an empty folder under `eval/runs/`, starts this server on it, gives the model the skill and nothing else, sends "Run the tracker", answers the gate questions with `eval/answers.txt`, checks every case against `eval/expected/`, saves the result in `eval/results/`, and rebuilds `eval/EXEMPLAR.md`. The tracker in `data/` is never touched.

It needs an Anthropic API key in a file called `.env` in this folder (see `.env.example`). Use a dedicated key with a low spend limit and delete it when you are done. Each run prints its model calls and tokens, and the page records them.

- `--model` picks the model, so the same cases can be run on a smaller tier to see whether it still passes.
- `--mock` tests the harness itself with a scripted stand-in and no API call; mock runs are never recorded on the page.
- `--page-only` rebuilds the page from the recorded runs.

## Read the transcripts from a Google Drive folder

The same ten tracker tools, gates, skill and checker, with the transcripts in a Google Drive folder. It is the closest free sibling to a SharePoint document library, which is where meeting transcripts sit in most companies. The folder holds the eight synthetic transcripts only; a real transcript never goes in it.

**How it works.** `--source drive` puts `lib/source.js` in front of the store:

| Tool | With `--source drive` |
|---|---|
| `tracker_scan` | Lists the folder, copies each new `.txt` in by its file id, then runs the store's own scan. A file whose header says confidential is fetched as its first 2 KB only: the header lines are kept, the body is never written to disk and never reaches the model. |
| `tracker_read_transcript` | Fetches the file again by its file id and checks its md5 against the scan's, then the store reads it. |
| `tracker_summary` | Writes the summary and board as before, then uploads the board to `released/` in the folder (replacing it if the run already released one). |
| the other seven | Unchanged. |

Every step is in the run log, step `source`: `fetched` with the file id, modified time and md5; `header only`; `read`; `flagged`; `released`. A transcript is known by its file id, so it is never read twice. These are flagged, written to the summary's notes, and left for you to decide, with no tracker row changed:

- a transcript **edited in Drive after it was processed** (same file id, new content)
- a transcript **renamed** in Drive (same file id, new name)
- **a second file with a name already used** (Drive allows two; the tracker knows transcripts by name)
- a file that is **not plain text**, such as a Google Doc
- an edit **between this run's scan and its read** (the version scanned is the one read)

**Access.** Your own Google account, two scopes, granted once in the browser:

- `drive.readonly` lists and reads the folder. It reaches every file in that account's Drive, so use an account that holds nothing else of yours.
- `drive.file` writes the board back and reaches only files this app created. In the live run on 1 Nov 2026 Google let it create `released/` inside the transcripts folder. If an account refuses that, it makes `released/` in My Drive instead and says so in the summary; drag it into the transcripts folder once.

The OAuth client and the token live in `~/.config/meeting-tracker/` (`TRACKER_GOOGLE_DIR` overrides it), outside this folder, so neither can reach the repo. An app left in Testing mode on a personal account signs you out after 7 days; run `--auth` again. A company on Google Workspace would mark the app Internal, and the weekly sign-in goes away.

**Set it up once.**

1. In Google Cloud (console.cloud.google.com), on the account that will hold the folder: create a project, enable the Google Drive API, set up the consent screen (External, Testing, your own address as a test user), and create an OAuth client of type Desktop app. Download its JSON to `~/.config/meeting-tracker/client_secret.json`.
2. In that account's Drive: make a folder, upload the eight files from `data/transcripts/` as plain `.txt` (leave convert uploads off), and copy the folder id from its address (the part after `/folders/`).
3. Sign in: `node server.mjs --auth`. The browser opens the consent page. Google warns that the app is unverified, because it is your own; continue, and tick both boxes.

**Run the cases against the folder.**

```
node eval.mjs --model claude-opus-5-5 --effort high --source drive --folder <Drive folder id>
```

The same opening message, fixed answers and checker as the local run. The run is saved in `eval/results-drive/` and `eval/SOURCES.md` is rebuilt, setting it beside the latest local run on the same model case by case. The exemplar page stays the blind local record.

To see the edit flag live: in Drive, upload a new version of one transcript (File information, Manage versions, Upload new version, so the file id stays the same), then

```
node test/drive_edit_check.js --data eval/runs/<the Drive run's label>/data --folder <Drive folder id>
```

Offline, with no Google account: `npm test`, then `node test/drive_cases.js`.

**Where a OneDrive or SharePoint adapter through Microsoft Graph would differ.** The tools, store and gates stay; `lib/drive.js` and parts of `lib/source.js` change.

- **Sign-in:** an app registration in Microsoft Entra in place of a Google Cloud client. On a work tenant an admin consents once for the organisation, and there is no 7-day Testing sign-out.
- **Least access for the write-back:** Graph has no equivalent of `drive.file`. The choices are `Files.ReadWrite` (all the user's files), the app's own folder (`Files.ReadWrite.AppFolder`), or for a SharePoint library `Sites.Selected`, which an admin grants site by site. That is the largest difference.
- **New and changed files:** a delta query on the folder returns only what changed since a saved token, in place of listing the folder and comparing with the run log.
- **The edit check:** the item's `cTag` (it changes when the content changes) in place of Drive's md5.
- **Names:** a OneDrive folder cannot hold two files with one name, so the duplicate-name flag goes away.
- **Download:** `/content` answers with a redirect to a short-lived address; a 2 KB header read is the same Range request.
- **Confidential:** a SharePoint file can carry a sensitivity label in its metadata, which could decline it before a byte is read. Gate 4 would still check the header.

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

`npm install`, then `npx esbuild server.js --bundle --platform=node --format=esm --target=node20 --outfile=server.mjs --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"`, and the same with `eval/run_eval.js` and `--outfile=eval.mjs` for the harness. The desktop app runs `server.mjs` and the harness runs `eval.mjs`, so a change to the source does nothing until both are rebuilt.
