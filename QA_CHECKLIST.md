# V1 acceptance checklist

Recorded offline acceptance results are summarized in README.md. The browser scripts use
isolated SQLite databases and fake requests; they preserve the user's real drafts.
The Stage 7 script copies a fresh source snapshot without .env/database, links
already installed dependencies, and runs the actual batch from another directory,
records browser opening after readiness, restarts both servers and verifies saved
writing/feedback. An actual default-browser window is not opened during the test.

## Setup and launcher

- Install locked Python/frontend dependencies and Node 24 using README.md.
- Double-click Start Writing Assistant.bat from a folder with spaces in its path.
- Choose D or press Enter for demo; the local browser opens once both servers are ready.
- L chooses Gemini 3.5 Flash-Lite; F chooses Gemini 3.6 Flash. Selection applies to
  this launch; no .env or key edits. Switching requires Ctrl+C and another launch.
- Without dependencies, display a readable setup error. Occupied ports must fail
  without stopping another application. Ctrl+C stops both owned process trees.
- Health/startup never call Gemini, including when a live model is selected.

## Offline writing workflow

- Create a draft with topic, task/audience/tone, planned count and optional word range.
- Generate, edit and reorder intentions; verify exact planned count and advisory word totals.
- Select intention 2; get hints at all three help levels with the correct field visibility.
- Add non-English rough notes; make a plan at all levels, keeping examples separate.
- Write and check a sentence; feedback appears and status becomes checked for any verdict.
- Change help level: hints/plans disappear; valid saved checks remain.
- Edit notes/current/earlier writing: affected feedback disappears immediately and stays invalidated after save.
- Reload and restart both servers: settings, sequence, sentence, notes and current feedback survive.
- Cancel replacement/deletion and dirty navigation; confirm original writing is retained.
- Failed/lost assistance replies retain writing; refresh uncertain check outcomes without automatic replay.
- Type during inference: suppress stale guidance; preserve newer writing and resolve revision conflicts explicitly.
- Lose a writing save, reload, inspect and explicitly restore a paired recovery copy.
- Check keyboard focus, readable error/save states and no horizontal overflow on a narrow viewport.

## Remaining manual evaluation

- A fresh clone still requires dependency/runtime installation; those downloads are
  not automated by the batch file. Repeat the setup commands on another machine
  before claiming installation portability beyond the verified Windows workspace.
- Follow PROMPT_REVIEW.md and the solution-design rubrics when live evaluation is
  authorized. API access, costs, response time and semantic quality are not passed
  by offline tests. Do not submit writing to a live provider as part of setup QA.
