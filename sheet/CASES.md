# Meeting tracker sheet: the case set

Eight cases, the same transcripts as WORK-01 (`data/transcripts/`), checked by the same checker (`eval/check.js`) against the same expected results (`eval/expected/`), written before the first WORK-01 run. This file is for the person running the platforms. It is never given to a platform.

## The eight cases

| Case | Transcript | Kind | Run | What it tests |
|---|---|---|---|---|
| 1 | `01_halden_kickoff.txt` | Ordinary | 1 | Owners named in the sentence, relative dates against a stated meeting date, lines that are not actions |
| 2 | `02_meridian_pricing.txt` | Ordinary | 1 | Actions nobody took, kept with owner "not stated" |
| 3 | `03_northgate_claims.txt` | Ordinary | 1 | No meeting date: phrases kept, rows set to confirm; sentences about method are not actions |
| 4 | `04_halden_finance.txt` | Ordinary | 1 | Stop 1: a name that matches two contacts |
| 5 | `05_meridian_update.txt` | Ordinary | 1 | Stop 2: no actions; a closure of an earlier row in the same run |
| 6 | `06_northgate_board.txt` | Decline | 1 | Stop 4: confidential header, declined, nothing added |
| 7 | `07_halden_followup.txt` | Between runs | 2 | Closes a row from run 1 in the carried tracker; continues the action ids; adds no duplicate |
| 8 | `08_meridian_contracts.txt` | Between runs | 2 | Stop 3 in the second run: a due date before the meeting date |

The bar is WORK-01's: four of cases 1 to 5 match and case 6's decline holds. Cases 7 and 8 are reported as a count of two.

## What each platform is given, and nothing else

- **Instructions:** `sheet/SHEET.md`, pasted whole. On the ChatGPT Project, `sheet/SHEET-gpt.md` instead: its instructions take 8,000 characters and SHEET.md is 8,219, so SHEET-gpt.md is the same text with formatting only removed (bold markers, inline backticks, heading markers, list bullets, indents, blank lines; the code fences round the worked example kept), 7,976 characters. Every word is kept, character for character.
- **Files (Claude Project files, ChatGPT Project files, the Gemini Skill's file):** `data/contacts.csv`.
- **Attached in the chat:** the transcripts for the run and, in run 2, the carried tracker.

Never given: `eval/expected/`, `eval/answers.txt`, this file, `skill/SKILL.md`, any earlier run's output, any hint about what a case tests.

## The person carries the tracker

On a chat platform nothing is saved between conversations. So the person carries the tracker: the tracker block from run 1's last reply, written to a file by the importer, is attached to run 2. That file is the only thing that crosses from run 1 to run 2. Run 1's run log is not carried.

## Before each run: nothing else in the room

A chat platform adds things on its own: skills, connectors and apps, web search, code execution, memory. Any of them can put words in front of the model that are not the sheet, the contacts table or the attachments. The first Claude Project attempt loaded the meeting tracker skill installed on the account, so it was not blind (`claude-r1-try1`). The second run 1 had the Claude Desktop connection to the owner's Mac available, though nothing shows it used it, so it is not counted (`claude-r1-try2`). Both run 2 attempts were given the WORK-01 tool server's own `data/tracker.csv` by mistake in place of the carried tracker (`claude-r2-try1`, `claude-r2-try2`; see Run 2, step 2).

1. Turn off skills (all of them, or at least the meeting tracker skill; on Gemini, every skill but the sheet's own), every connector and app, web search and code execution, for the account, the Project or the Skill.
2. **Devices, in every chat.** On Claude in the browser, open Devices in the new chat and untick the Mac before sending anything, so the chat cannot reach the tools on the owner's machine. It is set per chat, so check it again in each new conversation, and check the top of the conversation no longer shows the Mac as connected.
3. Check memory is off or empty, before the run and after it.
4. After the run, open every collapsed tool, skill or search step in the conversation. If any of them read something other than the sheet, `contacts.csv` or the attached files, the run is not blind. A step that names the meeting tracker tool means the same, and so does a tracker row whose added_run is neither this run's id nor one in the carried file. The importer flags such rows itself (`foreign_rows` in the record).

A run that is not blind is still recorded, never deleted: rename its file to `<run id>-try<n>.txt`, add a line starting `Not blind:` with what it read to `<run id>-try<n>.notes.txt`, and import it. A run that was blind as far as the record shows but had something available that it should not have (as `claude-r1-try2` had the Mac) takes a line starting `Not counted:` instead, so the record keeps it as blind. Either way the importer marks it not counted, writes no carried tracker from it, and keeps it out of every platform verdict. Then run it again under the plain run id. Any other note for the record goes in the same notes file, one per line.

## How each run goes

Platforms and run ids: `claude` (Claude Project), `gpt` (ChatGPT Project), `gem` (Gemini Skill). Runs `<platform>-r1` and `<platform>-r2`.

The ChatGPT platform is a ChatGPT Project, not a custom GPT: custom GPTs can no longer be created in ChatGPT, and the plugins replacing them carry code, which does not fit a test of a sheet with no code behind it. The run ids stay `gpt-r1` and `gpt-r2`.

The Gemini platform is a Gemini Skill, not a Gem: Gems are retired on personal accounts and replaced by Skills. The Skill is made by hand, named `meeting-tracker-sheet` (Gemini allows only lowercase and hyphens), with `sheet/SHEET.md` pasted in full as its instructions (Gemini stores them as SKILL.md), `contacts.csv` as its only file and the description left empty. It is called by name in each new chat: on Gemini the opening line starts `@meeting-tracker-sheet `, then the line below. The run ids stay `gem-r1` and `gem-r2`.

Each platform runs on its own default settings: Sonnet 5.5 on Low in the Claude Project, GPT-6 with Thinking effort High in the ChatGPT Project, Pro in the Gemini Skill. The Claude Project also has a second row, **matched effort**: the same project and settings with Sonnet 5.5 on High, as the ChatGPT Project ran, under run ids `claude-hi-r1` and `claude-hi-r2`, saved in `eval/sheet/runs/claude/`. Its notes files open with `Row: matched effort (High, as ChatGPT ran)`, which the importer copies into the record; every other run is labelled `default settings`. The default row stays as it is.

**Run 1**
1. Open a fresh conversation in the Project, or a new Gemini chat.
2. Attach `01` to `06` from `data/transcripts/`.
3. Send exactly: `Run the tracker. Use run id <run 1 id>.` (`<platform>-r1`, or `claude-hi-r1` on the matched effort row)
4. When it stops with questions, send the fixed answers below, verbatim, as one message.
5. When it has written its last tracker and run log blocks, save the whole conversation (see Saving).
6. `node eval/sheet/import.js eval/sheet/runs/<platform>/<run 1 id>.txt`. This checks cases 1 to 6 and writes the carried tracker to `eval/sheet/runs/<platform>/carry/<run 1 id>-tracker.csv` (for example `carry/claude-hi-r1-tracker.csv`).

**Run 2**
1. Open a fresh conversation.
2. Attach `eval/sheet/runs/<platform>/carry/<run 1 id>-tracker.csv`, the one written from this row's run 1, then `07` and `08`. Never a file named plain `tracker.csv`: the WORK-01 tool server keeps its own `data/tracker.csv`, which already holds the results for 07 and 08, and both earlier Claude Project run 2 attempts were given it by mistake (`claude-r2-try1`, `claude-r2-try2`).
3. Send exactly: `Run the tracker. Use run id <run 2 id>.` (`<platform>-r2`, or `claude-hi-r2`)
4. When it stops, send the fixed answers below, verbatim, as one message.
5. Save the whole conversation.
6. `node eval/sheet/import.js eval/sheet/runs/<platform>/<run 2 id>.txt`. This checks cases 7 and 8 on the run 2 tracker, which also holds every carried row, and checks that each carried row came back unchanged apart from a closure.

## The fixed answers

The same text the WORK-01 harness sends, copied from `eval/answers.txt`. Send it whole in both runs, once, the first time the platform stops with questions; a sentence that answers nothing in that run is left for the model to pass over, as in the harness.

> Priya Nair is Halden. Yes, no actions in the status update. Record the 15 October date as said. Leave the Northgate dates at confirm for now.

| Sentence | Answers |
|---|---|
| Priya Nair is Halden. | Stop 1, case 4 (run 1) |
| Yes, no actions in the status update. | Stop 2, case 5 (run 1) |
| Record the 15 October date as said. | Stop 3, case 8 (run 2) |
| Leave the Northgate dates at confirm for now. | Any question about case 3's missing meeting date (run 1) |

## What the person types, and nothing more

The opening line and the fixed answers. No corrections, no nudges, no "try again", no second answer. One exception: if the platform cuts a reply off part way through a block (a length limit, not a question), send `Continue.` and the record notes it. If the platform stops for anything else (asks to confirm before starting, asks for a file it already has, ends without the blocks), that is where the run ends, and the record says so, as the harness would.

## Saving

Save the whole conversation as plain text to `eval/sheet/runs/<platform>/<run id>.txt`, with three lines at the top:

```
Platform: Claude Project | ChatGPT Project | Gemini Skill
Model: <the model as the platform shows it, with any mode or setting>
Date: YYYY-MM-DD
```

Then the conversation as copied, the person's messages included. The importer reads the last tracker block and the last run log block in the file.

## How a run is marked

- Run 1's tracker and run log go into a fresh data folder beside the untouched transcripts and contacts; the checker marks cases 1 to 6.
- Run 2's tracker and run log go into a second fresh folder; the checker marks cases 7 and 8. Case 7's closure is checked on a row that came from run 1. The importer also compares every carried row with the file that was attached and names any row that came back changed or missing; that is recorded beside the cases, not folded into them.
- A miss is named by its case and its line, as the checker writes it. Nothing is marked by eye.
