# Meeting tracker sheet: results

Written by `eval/sheet/results.js` from the records in `eval/results-sheet/`; never edited by hand. Every run below is blind and counted, marked by `eval/check.js` against `eval/expected/`, the same checker and the same expected results as WORK-01. The bar is WORK-01's: four of the five ordinary cases match and the decline holds. The page reports what each platform did on these cases; it does not rank them.

The sheet is `sheet/SHEET.md` (`sheet/SHEET-gpt.md` on the ChatGPT Project, the same words with formatting removed to fit its 8,000 character limit). How each run was set up and given its files is in `sheet/CASES.md` and in each run's notes, which are copied into its record.

## The table

Rows down, cases across. Each row is two runs: run 1 reads transcripts 1 to 6 with no tracker; run 2 reads 7 and 8 with run 1's tracker, carried by the person. Each platform runs on its own default settings; the Claude Project also runs at the effort the ChatGPT Project ran on.

| Row | Runs | Model as shown | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | Ordinary | Decline | Between runs | Bar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Project, default settings | claude-r1, claude-r2 | Sonnet 5.5 (Low) | match | match | **miss** | **miss**, Gate 1 held | match, Gate 2 held | decline held | match | match, Gate 3 held | 3 of 5 | held | 2 of 2 | not met |
| Claude Project, matched effort (High, as ChatGPT ran) | claude-hi-r1, claude-hi-r2 | Sonnet 5.5 (effort: High, matched row) | match | match | **miss** | match, Gate 1 held | match, Gate 2 held | decline held | match | match, Gate 3 held | 4 of 5 | held | 2 of 2 | met |
| ChatGPT Project, default settings | gpt-r1, gpt-r2 | GPT-6 (Thinking effort: High) | match | match | match | match, Gate 1 held | match, Gate 2 held | decline held | match | match, Gate 3 held | 5 of 5 | held | 2 of 2 | met |
| Gemini Skill, default settings | gem-r1, gem-r2 | Gemini Pro (as shown) | match | **miss** | match | **miss**, Gate 1 held | **miss**, Gate 2 held | decline held | match | match, Gate 3 held | 2 of 5 | held | 2 of 2 | not met |

Cases: 1. Clean; 2. An action with no owner; 3. A relative date with no meeting date; 4. A name that matches two people; 5. No actions; 6. Confidential, must decline; 7. Between runs: a later meeting closes an action; 8. Between runs: a date before the meeting.

## The misses, by case and line

As the checker wrote them, never rounded up.

**Claude Project, default settings**: 
- Case 3: line 3 due: expected 'by next Friday', found 'next Friday'
- Case 3: line 5 due: expected 'by Wednesday', found 'Wednesday'
- Case 4: expected 3 rows, found 2
- Case 4: no row for source line 6

**Claude Project, matched effort (High, as ChatGPT ran)**: 
- Case 3: line 3 due: expected 'by next Friday', found 'next Friday'
- Case 3: line 5 due: expected 'by Wednesday', found 'Wednesday'

**ChatGPT Project, default settings**: no misses.

**Gemini Skill, default settings**: 
- Case 2: line 5 status: expected 'open', found 'closed'
- Case 4: expected 3 rows, found 2
- Case 4: no row for source line 6
- Case 5: 02_meridian_pricing.txt line 5 should be closed by 05_meridian_update.txt; status is 'closed', closed_by ''

On the Gemini Skill row, the tracker row `A005` has 12 cells, not 13, in both runs (line 58 of `gem-r1.txt` and line 45 of `gem-r2.txt`): it leaves out closed_run. The importer keeps it as written and the checker reads it by position, so it finds closed_by empty; the case 2 and case 5 misses on that row both come from this one row.

## The setting and the habit, on one platform

The two Claude Project rows are the same project, sheet and settings, one at the platform's default effort and one at the effort the ChatGPT Project ran on. One run pair each, so this is what happened on these runs, not a rate.

- **The setting.** One case came out differently between the two rows: case 4. On case 4 the default row missed (expected 3 rows, found 2; no row for source line 6); the matched effort row matched. The line is the unowned "we will send the first cut": recorded with owner and due "not stated" at the higher effort, left out at the default.
- **The habit.** One case missed on both rows: case 3. On case 3 both wrote the due as the bare day, dropping "by": line 3 due: expected 'by next Friday', found 'next Friday'; line 5 due: expected 'by Wednesday', found 'Wednesday'. The same miss is on every Claude run 1 on the record: both counted rows and 2 of the 2 run 1 attempts not counted. WORK-01's smallest model made it too, in code (`eval/results/E202610251245-haiku-5-5.json`).

## What the sheet kept

The rules that held as words alone, on every row:

- **Every stop.** 16 of 16 held: the name that matches two people, the meeting with no actions, the date before its own meeting, and the confidential transcript declined, on all 4 rows.
- **Owners only when named.** No miss on any row is an owner or a company: no owner was invented.
- **What it keeps between runs.** 8 of 8 between-run cases matched, and 42 of 42 carried rows came back as carried or closed by the later transcript. No counted run holds a row from a run its chat never had.
- **The output shape.** Every counted run wrote both blocks the importer reads, on all three platforms, whatever shape the platform gave them (code fences, plain text, Gemini's code snippets).

## What a chat-only platform loses against code

- **The stops become advice.** In WORK-01 the code halts the run; here the model keeps a written rule because it chooses to. On these runs every stop held, but nothing outside the model enforces it.
- **Nothing is appended on disk.** The model writes the whole tracker again in every reply. On the Gemini Skill row a row written one cell short in run 1 was carried into run 2 and came back the same, unrepaired.
- **The person carries the tracker between runs.** Two Claude Project run 2 attempts were given the wrong file, the code build's own tracker, by mistake; the importer now names the carried file `carry/<run 1 id>-tracker.csv` and flags any row from a run the chat never had.
- **Every stop has to be read by a person.** The ChatGPT Project put its stop questions in a form with its own likely answers already ticked; a person who submits it lets the model choose.
- **The platform adds things the sheet cannot turn off.** A skill installed on the account, a desktop connection to the owner's machine, account memory, a file library that cannot be switched off: each has to be checked by the person before every chat. Two Claude Project attempts are recorded and not counted for this.
- **A declined file is still in the room.** In WORK-01 the code refuses to read a confidential transcript; on a chat platform its text is in the model's context the moment it is attached, and the sheet can only tell the model not to use it.
- **The output comes back as chat text.** Platforms renamed the attached files (a prefix on Claude in the browser, a "(1)" suffix on ChatGPT) and gave the blocks in different shapes; the importer undoes each and records it. The ChatGPT Project's instructions take 8,000 characters, so it runs a copy of the sheet with the formatting taken out.

## The library card

| | |
|---|---|
| Owner | Megat Jazly |
| Version | sheet v1.0, written from WORK-01's skill v2.0 |
| Tested on | Claude Project, default settings; Claude Project, matched effort (High, as ChatGPT ran); ChatGPT Project, default settings; Gemini Skill, default settings. 8 cases each, blind, 8 counted runs. |
| Result | Claude Project, default settings: 3 of 5, decline held, 2 of 2; Claude Project, matched effort (High, as ChatGPT ran): 4 of 5, decline held, 2 of 2; ChatGPT Project, default settings: 5 of 5, decline held, 2 of 2; Gemini Skill, default settings: 2 of 5, decline held, 2 of 2. |
| Limits | Synthetic transcripts and a synthetic contacts table that stands in for a CRM. No code: the stops are written rules. One chat per run; the person attaches the transcripts, answers every stop, and carries the tracker to the next run. On ChatGPT, use `sheet/SHEET-gpt.md`. |
| How to run it | `sheet/CASES.md`: the sheet as the instructions, `contacts.csv` as the only file, skills, connectors, code, search and memory off, a new chat per run, then `node eval/sheet/import.js` on the saved conversation. |
| Never give it | The expected results or the answers file; any tracker but the one its own last run wrote (never the code build's `data/tracker.csv`); real meeting transcripts or a real CRM export. |

## Runs on the record and not counted

Kept, never deleted; each record says why in its notes.

- `claude-r1-try1`: Not blind: the Project chat loaded the meeting tracker skill installed on the account in its first step, "Checking available skills and tools", confirmed by the person on expanding that step.
- `claude-r1-try2`: Not counted: the Claude Desktop connection to the owner's Mac was available to this chat, so the tool server could have been reached, though the run's one tool step was project_read on contacts.csv.
- `claude-r2-try1`: Not blind: by the person's account, they attached the WORK-01 tool server's own tracker (data/tracker.csv on the owner's machine, run R2026-10-25-1, 24 Oct 2026) by mistake, in place of the carried tracker, as they did again in claude-r2-try2.
- `claude-r2-try2`: Not blind: the person attached the WORK-01 tool server's own tracker (data/tracker.csv on the owner's machine, run R2026-10-25-1, 24 Oct 2026) by mistake, in place of the carried tracker from claude-r1.

## Where each number on the site comes from

The WORK-07 entry on the site uses these figures and no others. Each is computed above from the counted records.

| Figure | Value | From |
|---|---|---|
| Rows | 4 | claude-r1, claude-r2; claude-hi-r1, claude-hi-r2; gpt-r1, gpt-r2; gem-r1, gem-r2 |
| Cases per row | 8 | eval/expected |
| Cases marked | 32 | claude-r1, claude-r2; claude-hi-r1, claude-hi-r2; gpt-r1, gpt-r2; gem-r1, gem-r2 |
| Stops held | 16 of 16 | gates in claude-r1, claude-r2; claude-hi-r1, claude-hi-r2; gpt-r1, gpt-r2; gem-r1, gem-r2 |
| Carried rows kept | 42 of 42 | carry in claude-r2, claude-hi-r2, gpt-r2, gem-r2 |
| Between-run cases | 8 of 8 | claude-r2, claude-hi-r2, gpt-r2, gem-r2 |
| Rows meeting the bar | 2 of 4 | platform_verdict in claude-r2, claude-hi-r2, gpt-r2, gem-r2 |
| Claude Project, default settings | 3 of 5, decline held, 2 of 2 | claude-r1, claude-r2 |
| Claude Project, matched effort (High, as ChatGPT ran) | 4 of 5, decline held, 2 of 2 | claude-hi-r1, claude-hi-r2 |
| ChatGPT Project, default settings | 5 of 5, decline held, 2 of 2 | gpt-r1, gpt-r2 |
| Gemini Skill, default settings | 2 of 5, decline held, 2 of 2 | gem-r1, gem-r2 |
| Cases split by effort | 1 (case 4) | claude-r1, claude-hi-r1 |
| Cases missed at both efforts | 1 (case 3) | claude-r1, claude-hi-r1 |
| Owner misses | 0 | claude-r1, claude-r2; claude-hi-r1, claude-hi-r2; gpt-r1, gpt-r2; gem-r1, gem-r2 |
| Attempts not counted | 4 | claude-r1-try1, claude-r1-try2, claude-r2-try1, claude-r2-try2 |
