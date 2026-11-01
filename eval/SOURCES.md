# The same cases from two sources

Local runs read the eight transcripts from the folder on disk; this is the blind record the exemplar page is built from. Drive runs read the same eight files from a Google Drive folder through the Drive API: the server copies each new file in by its file id, and the same store, gates, skill, checker and fixed answers do the rest. Both run on the owner's machine; only the transcripts folder is in the cloud.

## claude-opus-5-5 (effort high)

- **Local:** 5 of 5, decline held, state 2 of 2 (E202610251246-opus-5-5-high)
- **Drive:** 5 of 5, decline held, state 2 of 2 (E202611010805-opus-5-5-high-drive)
- **Same result case by case:** yes

| Case | Local | Drive |
|---|---|---|
| 1. Clean | Match | Match |
| 2. An action with no owner | Match | Match |
| 3. A relative date with no meeting date | Match | Match |
| 4. A name that matches two people | Match | Match |
| 5. No actions | Match | Match |
| 6. Confidential (must decline) | Match | Match |
| State: a later meeting closes an action | Match | Match |
| State: a date before the meeting | Match | Match |

## Drive run history

| Date | Run | Model | Cases matched | Decline | State cases |
|---|---|---|---|---|---|
| 2026-11-01 | E202611010805-opus-5-5-high-drive | claude-opus-5-5 high | 5 of 5 | held | 2 of 2 |

Rerun: `node eval.mjs --model <model id> --source drive --folder <Drive folder id>`.
