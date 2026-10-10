# Writing Assistant

An intention-driven assistant for planning a short paragraph, writing your own sentences, and getting advisory feedback.

## Screenshot walkthrough

*Image placeholders below will be replaced with screenshots of the app.*

1. ![Screenshot placeholder: draft settings](docs/screenshots/01-draft-settings.svg)

   **Set the direction:** add a topic, audience/task, planned sentence count, and optional word range.

2. ![Screenshot placeholder: intention sequence](docs/screenshots/02-intention-sequence.svg)

   **Plan the paragraph:** generate an ordered sequence of sentence purposes, then edit or reorder it.

3. ![Screenshot placeholder: writing hints](docs/screenshots/03-writing-hints.svg)

   **Find a starting point:** select an intention and request ideas, vocabulary, connectives, or structure patterns.

4. ![Screenshot placeholder: notes and sentence plan](docs/screenshots/04-notes-and-plan.svg)

   **Turn notes into a plan:** explore slots, missing details, and ordering advice while writing your own sentence.

5. ![Screenshot placeholder: sentence check](docs/screenshots/05-sentence-check.svg)

   **Review the sentence:** see an advisory intention verdict and targeted issues without an automatic rewrite.

## The problem

Knowing a topic does not always make it clear what the next sentence should accomplish. Writers may also have useful ideas but struggle to organize or express them in English. Writing Assistant breaks the paragraph into communicative purposes and offers guidance while keeping the writer responsible for the final wording.

## How it works

**Plan → Hint → Write → Check**

1. **Plan:** choose the topic and writing task; generate and refine a sequence of intentions.
2. **Hint:** select a purpose; request hints or turn rough notes into a sentence plan.
3. **Write:** compose the sentence yourself; the sentence and notes autosave together.
4. **Check:** request feedback on the primary purpose and its connection to earlier writing.

## Features

- **Editable intention sequences:** generate exactly 3–8 purposes; add, edit, delete, and reorder up to eight intentions.
- **Length settings:** planned sentence count, optional paragraph word range, and live word-count advisories.
- **Three help levels:** Hint, Structure, and Example keep ideas, patterns, and complete examples separate.
- **Rough-note planning:** slots, gaps, ordering advice, and matched keywords help organize supplied ideas.
- **Advisory sentence checks:** yes/partly/no verdicts with targeted issues; checked means reviewed, not necessarily accepted.
- **Persistent writing and feedback:** SQLite saves drafts, notes, sentences, and current checks across restarts.
- **Autosave and recovery:** paired browser recovery copies, explicit conflict choices, and stale-response rejection protect ongoing edits.
- **Windows launcher:** start both servers, open the website, and choose demo mode or either configured Gemini model.

## Design decisions

- **The user writes the sentence:** guidance stays separate from the editor; examples are opt-in and never inserted automatically.
- **Schema-validated LLM output:** Pydantic validates JSON; invalid output gets one controlled repair attempt before a readable error.
- **One task per LLM call:** sequence generation, hints, planning, and checking each have a separate prompt and output contract.
- **Swappable LLM client:** a provider-independent interface has Gemini and deterministic fake implementations.
- **Fake LLM in tests:** business tests run offline; SDK adapter tests use an in-memory HTTP transport and a synthetic key.
- **Guarded persistence:** revisions and context fingerprints reject stale results; database transactions end before model waits.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite, plain CSS |
| Backend | Python, FastAPI, Uvicorn |
| Data and validation | SQLite, SQLModel, Pydantic v2 |
| LLM | Gemini through the official `google-genai` SDK; fake client for offline use |
| Tests | pytest, Vitest, React Testing Library; optional Playwright/Edge acceptance scripts |

## Run locally

**Prerequisites:** Python 3.12 (verified; backend supports 3.11+), Node.js 24 with npm, and Git. Windows is the verified platform. Clone the repository and run these commands from its root in PowerShell:

```powershell
py -3.12 -m venv backend/.venv
./backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.lock.txt
npm.cmd --prefix frontend ci
```

Double-click **[Start Writing Assistant.bat](<Start Writing Assistant.bat>)**:

- **D / Enter:** offline demo; no API key required.
- **L:** Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`).
- **F:** Gemini 3.6 Flash (`gemini-3.6-flash`).

The launcher opens **http://127.0.0.1:5173** after both servers are ready. Keep its terminal open; **Ctrl+C** stops both servers. Stop and relaunch to change models. Ports 8000 and 5173 must be free.

For a terminal-only startup command with automatic browser opening:

```powershell
./backend/.venv/Scripts/python.exe scripts/dev.py --mode fake --open-browser
```

For live assistance, put `GEMINI_API_KEY` in a root `.env` or `backend/.env`, then choose **L** or **F**. Use [backend/.env.example](backend/.env.example) as the template if you do not already have one. Process environment overrides backend `.env`, which overrides root `.env`. Launcher choices apply only to that run. Live assistance sends writing context to Google; startup and health checks make no model calls. Never commit your key or expose it through a `VITE_` variable.

Draft data is stored in `backend/data/app.db`; browser recovery copies stay in localStorage.

To run the tests and production build:

```powershell
./backend/.venv/Scripts/python.exe -m pytest backend/tests -c backend/pyproject.toml
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
```

Recorded V1 verification: **263 backend tests and 107 frontend tests passed**, plus the production build and Windows browser acceptance. See [QA_CHECKLIST.md](QA_CHECKLIST.md) for acceptance steps and [PROMPT_REVIEW.md](PROMPT_REVIEW.md) for prompt evaluation limits.

## Limitations and roadmap

V1 is a local, single-user tool for one short paragraph. Feedback is advisory, not factual verification; live model access and semantic quality have not been evaluated. Recovery depends on browser storage remaining available.

The [spec](WRITING_ASSISTANT_V1_SPEC.md) deliberately leaves these areas outside V1; they are possible future scope, not committed features:

- Paragraph coherence and document-level review.
- English-level selection, learning profiles, and grammar lessons.
- Idea expansion, evidence tools, citation search, and full-text rewriting.
- User accounts, cloud deployment, and streaming responses.
- Plagiarism checking and AI-detection features.

For implementation details, see [SOLUTION_DESIGN.md](SOLUTION_DESIGN.md).
