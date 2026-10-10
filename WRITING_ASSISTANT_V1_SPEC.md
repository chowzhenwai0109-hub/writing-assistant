# Writing Assistant — V1 Build Spec (for Codex)

> Read this file at the start of every session. Build **one stage at a time**. Do not start a stage until the previous checkpoint passes. Do not add features that are not listed here.

> Approved design decisions: read the stage-relevant sections of `SOLUTION_DESIGN.md` alongside this spec. It resolves the review findings and is part of the build contract. Build and verify all stages without live Gemini calls until the user explicitly requests live evaluation; mark semantic model quality as deferred, not passed.

---

## 1. Product summary

An **intention-driven short-paragraph writing assistant** (up to eight planned sentences). It helps a writer who knows the topic but not what each sentence should do, or who has ideas but struggles to express them in English. Each intention describes a primary communicative purpose; secondary functions are allowed.

Core loop: **Plan → Hint → Write → Check**

1. **Macro:** user gives a topic/task → app produces an ordered **intention sequence** (one communicative purpose per sentence). User edits it.
2. **Micro:** user selects one intention → app gives hints (entities, keywords, connectives, sentence-structure patterns). User may type rough notes → app returns a **sentence plan**. User writes the sentence themselves → app **checks** whether it fulfils the intention.

Principles:
- The user stays in control. The LLM proposes; it does not decide.
- The app does **not** write the sentence unless the user asks for help level 3 (example).
- Local app and SQLite storage. Single user. No auth, no deployment. Gemini is a remote provider: a user-triggered live request sends writing context to Google. This build uses no live model requests; health and CRUD never require a key.

## 2. Non-goals for V1 (do NOT build)

Paragraph coherence review, document-level review, English level selector, idea-expansion/evidence tools, grammar lessons, learning profile, user accounts, cloud deployment, streaming responses, full-text rewriting, plagiarism or AI-detection features, citation search.

## 3. Tech stack (fixed — do not substitute)

| Layer | Choice |
|---|---|
| Backend | Python 3.11+, **FastAPI**, Uvicorn |
| Validation / schemas | **Pydantic v2** (all API bodies and all LLM outputs) |
| Database | **SQLite** via SQLModel (file: `backend/data/app.db`) |
| LLM access | One `LLMClient` abstraction; Gemini adapter using the official `google-genai` SDK (Stage 2). Env: `LLM_PROVIDER=gemini`, `GEMINI_API_KEY`, `LLM_MODEL=gemini-3.5-flash-lite` (alternative `gemini-3.6-flash`), `LLM_MODE=fake` by default. Structured JSON outputs validated with Pydantic. No live calls during staged builds. |
| Frontend | **React + TypeScript + Vite**, plain CSS or Tailwind, `fetch` for API calls. No heavy state libraries (use React state + a small hooks layer). |
| Tests | `pytest` (backend), `vitest` (frontend, minimal) |
| Run | Two loopback dev servers: `uvicorn` (port 8000) and `vite` (port 5173, proxy `/api` → 8000). `scripts/dev.ps1` starts and stops both on Windows; `scripts/dev.py` owns their lifecycle and also runs directly on other platforms. |

Secrets: support the existing root `.env` and optional `backend/.env`, both git-ignored. Precedence: process environment > backend file > root file > defaults. Provide `backend/.env.example`; never expose the key to Vite or browser responses/logs. Node 24 LTS and Python 3.11+ are prerequisites; a verified project-local Node runtime under ignored `.tools/` is supported.

## 3.1 Repo layout

```
writing-assistant/
  WRITING_ASSISTANT_V1_SPEC.md   # canonical spec filename
  SOLUTION_DESIGN.md            # resolved behavior and stage mapping
  PROGRESS.md                  # stage tracker (see §9)
  backend/
    app/
      main.py                  # FastAPI app, CORS for localhost:5173
      db.py                    # engine/session
      models.py                # SQLModel tables
      schemas.py               # Pydantic API schemas
      routers/                 # drafts.py, intentions.py, assist.py
      llm/
        client.py              # LLMClient interface + provider adapter
        fake.py                # FakeLLMClient (deterministic, used in tests)
        schemas.py             # Pydantic models for LLM outputs (§5)
        prompts/               # one .md/.txt template per task
        service.py             # generate_intentions, get_hints, make_plan, check_sentence
    tests/
    scripts/smoke_llm.py       # manual real-LLM smoke test
    pyproject.toml / requirements.txt
    .env.example
  frontend/
    src/ (api/, components/, pages/, hooks/, types/)
    vite.config.ts
```

## 4. Data model

**Draft**: `id`, `title`, `topic`, `task_description`, `target_sentence_count` (default 5, integer 3–8), `target_word_min` / `target_word_max` (both null or 1–500, min ≤ max), `last_generation_mode` (read-only null/fake/live), `revision` (monotonic int), `created_at`, `updated_at`. Audience, purpose, and tone use task description; no proficiency selector.

**Intention**: `id`, `draft_id`, `position` (zero-based int, unique per draft), `function_label` (e.g. "Introduce central claim"), `description`, `guiding_question`, `status` (`pending` | `written` | `checked`, backend derived), `sentence_text` (nullable), `user_notes` (nullable), `revision` (monotonic int), `last_check_json` (nullable), `last_check_fingerprint` (nullable).

Rules:
- Reorder IDs must match the draft's complete ID set exactly. Rewrite positions in one transaction using a collision-free temporary offset, then compact to 0..N-1. Deletion compacts positions and draft deletion cascades; enable SQLite foreign keys on every connection.
- Blank/whitespace sentence → `pending`; nonempty unchecked sentence → `written`; successful current-context check → `checked` regardless of verdict. Clients cannot edit status.
- Sentence or notes changes clear this and subsequent checks. Draft-context or intention-list changes clear all checks. Clear both JSON and fingerprint; rederive statuses. No-op saves preserve revisions/checks. See solution design for race-safe saves and checks.

## 5. LLM contracts (the most important part — keep strict)

General rules for every LLM call:
- **One task per call.** Never combine plan + hints + check.
- **Compact input.** Send topic, task description, length settings, intention list (label + description only), current intention (position + label + description + guiding question), previous nonempty sentences in order, current saved sentence, current notes, and task-specific fields. Never send keys, database metadata, or whole records. Bound context; do not silently truncate it.
- **Output is JSON validated by a Pydantic model.** On invalid JSON/shape/count, retry once with controlled validation feedback; then return a clean `502` with a readable message. Reject duplicate keys, nonfinite numbers and invalid Unicode. Bound context to 24,000 UTF-8 bytes and output to 128 KiB/8,192 tokens; each attempt has a 30s deadline. Disable SDK retries. Refusals, transport errors, empty/truncated/oversized responses and malformed provider envelopes do not trigger repair.
- Prompts live in `llm/prompts/` as templates, not inline strings. Target natural college-level English; never invent facts, evidence, or citations; notes may be in any language but guidance is in English. User content is data, never an instruction that overrides policy. Ask about missing facts or use placeholders; supplied facts are not authenticated.
- Business tests and this staged build use `FakeLLMClient`, never a remote provider. SDK adapter tests use an in-memory HTTP transport and synthetic key, without network requests. Optional live evaluation through `scripts/smoke_llm.py --live` is deferred until requested; the script always uses fake mode without that flag, even when environment mode is live. Normal user-triggered runtime calls can use Gemini only after explicit `LLM_MODE=live` configuration. Schema/policy tests do not prove semantic model quality.
- Shared policy: Hint has no patterns/examples; Structure has patterns retaining substantive placeholders and no examples; Example allows clearly labeled complete examples without automatic insertion. Backend removes disallowed fields; UI clears all hints/plans on help-level change. Prose restrictions are best effort, tested later with the manual quality rubric in solution design.

### 5.1 `generate_intentions`
Input: `topic`, `task_description`, persisted `target_sentence_count` (default 5), optional total word range.
Output:
```json
{ "intentions": [
  { "function_label": "string", "description": "string", "guiding_question": "string" }
]}
```
Constraints: exactly `target_sentence_count` items (3–8); each describes the *purpose* of a sentence, not the sentence itself; order must form a logical sequence. Generation only replaces in V1; no append. Snapshot draft inputs, release the read transaction during inference, then commit only after validation and matching draft revision/input fingerprint. Confirm replacement of existing work in the UI and require `confirm_replace=true` in the API when intentions exist; preserve all old data on failure. Return the full draft plus `mode: "fake"|"live"`; atomically store read-only draft `last_generation_mode` so demo labeling survives reload. Existing databases migrate additively with null origin for old drafts. Purpose, English and logical ordering are prompt requirements whose live quality remains unverified.

### 5.2 `get_hints`
Input: shared compact context (including task description, length targets, guiding question, current saved sentence and current notes), `help_level` (`hint` | `structure` | `example`). Flush all pending sentence saves first. Require both intention and draft revisions before inference; revalidate both revisions and context fingerprint afterward. Hints are read-only and ephemeral.
Output:
```json
{
  "intention_summary": "string",
  "relationship": "e.g. cause-effect, condition, contrast, elaboration",
  "entities": [{ "label": "string", "why_needed": "string" }],
  "keywords": [{ "phrase": "string", "note": "string" }],
  "connectives": [{ "word": "string", "use": "string" }],
  "structures": [{ "pattern": "string with [placeholders]", "note": "string" }],
  "examples": [{ "sentence": "string", "why_it_works": "string" }]
}
```
Level rules (enforced in backend, not just prompt): `hint` → `structures` and `examples` empty; `structure` → `examples` empty; `example` → all fields. Keep lists short (≤5 entities, ≤6 keywords, ≤4 connectives, ≤3 structures, ≤2 examples). Keywords, connectives and structures are **separate categories**.

### 5.3 `make_plan` (sentence plan from user notes)
Input: same context as 5.2 + nonblank `user_notes` (up to 4,000 characters, any language) + `help_level`. Require both intention and draft revisions. Save submitted notes and capture the post-save context atomically before inference; reject excessive candidate context before saving. Model failure retains successfully saved notes; success returns the saved intention and both post-save revisions. UI flushes all sentence/notes buffers first, so its plan request normally saves identical notes without advancing revisions. Plans are ephemeral and never insert text into the sentence editor.
Output:
```json
{
  "slots": [{ "role": "subject|action|condition|consequence|detail|other", "content": "string" }],
  "gaps": [{ "missing": "string", "question": "string" }],
  "ordering_suggestion": "string",
  "matched_structures": [{ "pattern": "string retaining [substantive placeholders]", "note": "string" }],
  "matched_keywords": [{ "phrase": "string", "note": "string" }],
  "examples": [{ "sentence": "string", "why_it_works": "string" }]
}
```
Hint clears matched structures and examples; Structure clears examples and requires a substantive placeholder in each pattern; Example permits labeled complete examples. Slots are fragments; ordering advice describes roles, not a finished sentence. Caps: 6 slots, 5 gaps, 3 patterns, 6 keywords, 2 examples. Do not claim that schemas guarantee sentence-free prose.

### 5.4 `check_sentence`
Input: shared compact context, `sentence`, `expected_revision`, `expected_draft_revision`. Nonblank text up to 4,000 characters is required; candidate context/revisions are validated before saving exact submitted text and snapshotting atomically. Release the transaction during inference, then persist feedback only if both revisions and fingerprint match. Checks have no help-level dependency; submitted text occupies `current_sentence` in model context, without duplication.
Output:
```json
{
  "fulfils_intention": "yes|partly|no",
  "summary": "string",
  "issues": [{
    "type": "off_intention|overclaim|missing_info|repetition|unclear_relation|unestablished_info|other",
    "message": "string",
    "suggestion": "string"
  }]
}
```
Treat as advisory feedback, not ground truth. Never rewrite the whole sentence. Focus on primary intention and relationships to prior text. Brief grammar/word-choice advice is allowed under `other` when meaning is unclear; no grammar lessons or factual verification. Preserve fragments/multiple sentences and advise when one sentence per intention is not followed. Cap issues at 5.

Store `{result: <validated output>, mode: "fake"|"live"}` in `last_check_json` and its context fingerprint. Successful persistence advances intention and draft revisions once, sets checked for every verdict and returns result, fingerprint, final revisions, mode, saved intention and full `draft`. Changed submitted text additionally advances both revisions before inference. Failure retains committed text; unchanged failed rechecks preserve valid feedback. All intention responses hide invalid/stale/legacy feedback without mutating storage. UI flushes all buffers, verifies returned/persisted context, and reads saved data before retrying an uncertain check; provenance persists on reload. See solution design for cancellation and conflict recovery.

## 6. REST API

```
GET    /api/health
POST   /api/drafts                      {title, topic, task_description}
PATCH  /api/drafts/{id}                 draft fields/settings + expected_revision
GET    /api/drafts
GET    /api/drafts/{id}                 (includes intentions)
DELETE /api/drafts/{id}
POST   /api/drafts/{id}/intentions/generate     {mode: "replace", expected_revision, confirm_replace}
POST   /api/drafts/{id}/intentions              add one
PATCH  /api/intentions/{id}             edit label/description/question/sentence_text/user_notes + expected_revision
DELETE /api/intentions/{id}
PUT    /api/drafts/{id}/intentions/order        {ordered_ids: [...], expected_revision}
POST   /api/intentions/{id}/hints       {help_level, expected_revision, expected_draft_revision}
POST   /api/intentions/{id}/plan        {user_notes, help_level, expected_revision, expected_draft_revision}
POST   /api/intentions/{id}/check       {sentence, expected_revision, expected_draft_revision}
```
Create draft accepts optional length settings. Add/delete intentions also use expected draft/intention revisions as defined in solution design. All errors, including request validation: `{ "detail": "..." }` (string). Missing resource → 404; stale/conflicting operation or cap → 409; malformed input → 422; LLM failures/refusals → 502; timeout → 504; unavailable provider/config/key in live mode → 503. Responses and request limits are defined in solution design; never return provider internals.

## 7. Frontend

**Pages**
1. **Drafts list**: create new draft (title, topic, task description with audience/purpose/tone guidance, planned sentence count, optional total word range), open, delete with confirmation.
2. **Workspace** (3 panels):
   - **Left — Intention sequence:** ordered list with status badges; add, edit, delete, reorder (up/down buttons); "Generate sequence" button with replacement confirmation; edit draft settings. Up to 8 intentions; users may delete down to zero. No append generation.
   - **Middle — Current sentence:** shows the selected intention and its guiding question; textarea for the sentence; textarea for "my rough notes"; buttons: *Get hints*, *Make plan from my notes*, *Check my sentence*; autosave of sentence/notes.
   - **Right — Guidance:** help-level selector (Hint / Structure / Example); renders hints, plan, and check results in clearly separated sections (Entities, Keywords, Connectives, Structures, Gaps, Issues).

UX requirements: loading state from the stage that introduces each request; readable errors; preserve text and offer unsaved sentence recovery from browser localStorage after reload (Stage 4); extend recovery to notes in Stage 5. Stage 3 metadata/settings use explicit Save and protect dirty cancellation/navigation with confirmation. Disable duplicate/conflicting actions while pending; never automatically replay uncertain mutations. Sentence/notes autosave debounces 600ms, serializes writes across the draft with independent intention buffers, and guards revisions. Save indicators: Saving / Saved / Unsaved. Ignore stale response IDs/context. Guidance is ephemeral except checks; current checks persist and reload. Show total words from current editor buffers and advisory target mismatch; targets never block writing. See solution design for conflict recovery and browser-safe identifier limits.

## 8. Build stages and checkpoints

**Working rules for every stage**
1. Read this spec's sections relevant to the stage plus `PROGRESS.md`. Do not re-read the whole repo.
2. Implement only the stage's scope. No refactors outside it.
3. Run the stage's checks. Fix failures before continuing.
4. Update `PROGRESS.md`, then commit with message `stage N: <name>`. Record a completed stage by its commit subject in the same commit; report its resulting hash outside that commit to avoid self-reference.
5. **Stop and report** (what was done, what was verified, any deviations). Do not start the next stage.

---

### Stage 0 — Scaffold and run
Scope: repo layout (§3.1), FastAPI app with `/api/health`, path-stable SQLite setup and foreign keys, backend-only root/backend env loading, React+Vite app showing backend health, Vite proxy, `.env.example`, Windows-compatible dev start/stop script, `.gitignore`, `PROGRESS.md`, README with run instructions. No CRUD or LLM implementation yet.
Checkpoint:
- [x] Both servers start with one command.
- [x] Frontend page displays "backend: ok" from `/api/health`.
- [x] `pytest` runs (two tests pass: health/database and settings precedence).
- [x] Frontend typecheck/build and minimal vitest pass; browser verifies health through Vite proxy.
- [x] Both child servers stop with the launcher; no live Gemini call occurs and secrets remain ignored.

### Stage 1 — Data layer and CRUD (no LLM)
Scope: models (§4), draft settings/update and intentions endpoints (§6 except generate/hints/plan/check), response/error contracts, revision checks, pending/written save transitions, invalidation and reorder logic.
Checkpoint:
- [x] Pytest covers: create/list/get/delete draft, add/edit/delete intention, reorder, status reset rule.
- [x] Deleting a draft removes its intentions.
- [x] Length settings persist and reject invalid merged ranges; no-op saves preserve revisions/checks.
- [x] Stale/overlapping writes preserve data; reads use consistent snapshots; failed reorder rolls back.
- [x] Context edits invalidate affected feedback, blank sentences become pending, clients cannot set status/checks.
- [x] Database constraints, non-reused IDs, the eight-intention cap and restart persistence are verified.

### Stage 2 — LLM layer + intention generation
Scope: `LLMClient` + provider adapter, `FakeLLMClient`, Pydantic LLM schemas (§5), prompt template for `generate_intentions`, retry-once-on-invalid-JSON logic, `/intentions/generate` endpoint, persistent generation provenance with additive migration, `scripts/smoke_llm.py`.
Checkpoint:
- [x] Tests with fake client: exact saved count (3–8), order/settings; one repair then 502; missing live key/config returns 503.
- [x] Replacement confirmation, rollback, bounded context/output, timeout, stale snapshots and overlapping/deleted drafts preserve data; generation provenance persists and Stage 1 databases upgrade safely.
- [x] All LLM shapes are strict; offline SDK transport verifies configuration, disabled retries, sanitized errors and cleanup.
- [x] Fake smoke call succeeds, including with live environment mode; live sequence-quality smoke is explicitly deferred until requested (not a blocking build checkpoint).

### Stage 3 — Macro frontend
Scope: drafts list/settings page, workspace left panel (generate replacement confirmation, add, edit, delete, reorder, status badges), word-target advisories, API client + types, errors/loading from first use. Use `last_generation_mode` for a persistent “Last generated in demo mode” label when fake.
Checkpoint:
- [x] Create a draft, generate a sequence, edit and reorder it, reload the page — state/settings/demo provenance persist.
- [x] Draft/intention add/edit/delete, destructive confirmation, status badges and eight-item controls work.
- [x] Word counts, derived averages and advisory count/word mismatches follow the documented conventions without blocking actions.
- [x] Backend errors are readable; metadata survives conflicts/uncertain saves until explicit resolution; stale reads and duplicate actions are guarded.
- [x] Frontend tests/build and a real-browser isolated-DB workflow pass, including mobile layout and native modal focus/Escape.

### Stage 4 — Micro hints
Scope: `get_hints` prompt + service + endpoint, help-level enforcement in backend, middle/right panels, help-level selector, sentence autosave ordering/recovery, stale-response guards and frontend tests.
Checkpoint:
- [x] Tests: level rules enforced even if fake LLM returns forbidden fields; list length caps applied; unknown fields rejected and retained Structure patterns require substantive slots.
- [x] UI shows Entities / Keywords / Connectives separately; Structures at levels 2–3 and Examples only at level 3. Help level changes clear guidance without calling the provider.
- [x] Fake smoke at all levels and adversarial extra-field checks pass; live hint-quality evaluation deferred until requested.
- [x] Sentence buffers debounce/coalesce, serialize writes, flush before hints and on selection; read-first retry, explicit conflict/recovery choices and deleted-intention retention preserve local work.
- [x] Both revisions and client/server fingerprints reject stale hints; 172 backend tests, 56 frontend tests, production build and isolated real-browser workflows pass offline.

### Stage 5 — Sentence plan from user notes
Scope: `make_plan` prompt + service + endpoint, notes textarea, plan rendering (slots, gaps, ordering, matched structures/keywords).
Checkpoint:
- [x] Fake tests verify strict validation, field/cap/placeholder policies, one controlled repair and both revision guards.
- [x] Fake scenarios accept non-English/sparse/adversarial notes and return English demo roles/questions; semantic translation, grounding and multilingual quality remain deferred for live evaluation.
- [x] Backend strips forbidden patterns/examples and requires substantive Structure placeholders; the manual no-finished-sentence rubric remains prepared, not claimed proven by fake tests.
- [x] Notes and sentence autosave share one queue/revision; paired recovery retains older sentence-only copies without replacing saved notes. Conflict choices display both fields; uncertain saves read first.
- [x] Atomic save/snapshot, downstream invalidation, failure retention, context limits and stale/deleted plans pass; frontend clears stale hints/plans on notes, selection, level or context changes.
- [x] 216 backend tests, 82 frontend tests, production build, all-level fake smoke and isolated real-browser notes/plan/recovery workflow pass. Stopped before Stage 6.

### Stage 6 — Intention check and status flow
Scope: `check_sentence` prompt + service + endpoint, advisory verdict/issue rendering, atomic save-then-snapshot check with stale-context rejection, `checked` transition, store fingerprint and `last_check_json`. Pending/written and invalidation were implemented in Stage 1.
Checkpoint:
- [x] Tests: all verdicts mark checked; strict output/caps/one repair, atomic saves, feedback revisions, concurrent/stale/deleted checks and rollback pass.
- [x] Fake overclaim and no-op/changed-text failure scenarios pass; persisted provenance, fingerprint validation and corrupt/legacy feedback hiding verified.
- [x] Browser verifies flush, reload, help-level independence, current/downstream invalidation, lost-response read and typing/conflict recovery. Live check quality remains deferred.

### Stage 7 — Polish and acceptance
Scope: polish existing empty/loading/error/save states, README finalization, `.env.example` complete, manual QA checklist and deferred live semantic-quality rubric. User-approved additions: double-click Windows batch launcher with readiness/browser opening; Flash-Lite/Flash selection at launch; prompt review and clarity improvements. Do not introduce earlier-stage reliability behavior only here.
Final acceptance (end-to-end, manual):
- [x] Actual Windows batch starts from a fresh source snapshot with preinstalled prerequisites/dependencies and a path containing spaces; readiness precedes browser opening. Setup on another machine remains a documented manual check.
- [x] In fake mode: create draft with length settings → generate sequence → edit it → pick sentence 2 → get hints (all 3 levels) → type notes → get plan → write sentence → check → status becomes `checked`. Validate destructive confirmation, save recovery and stale-result rejection.
- [x] Restart both servers; settings, sequence, writing and current feedback persist. Both model selections verified offline; no Gemini requests.
- [x] All pytest and vitest tests pass; production build, dependency check and real-browser acceptance pass.
- [x] Prompt review, Windows/model-switch documentation and deferred live-quality rubrics complete.

## 9. Progress tracking and token discipline

`PROGRESS.md` format (keep it under 40 lines):
```
## Current stage: N
## Done
- Stage 0 ✅ (`stage 0: scaffold and run`) — notes
## Decisions / deviations
- ...
## Next
- Stage N+1 scope in one line
```

Token-saving rules:
- One stage per session. Start by reading `WRITING_ASSISTANT_V1_SPEC.md`, relevant `SOLUTION_DESIGN.md` sections, and `PROGRESS.md` only.
- Do not paste whole files into the conversation; reference paths and show only diffs/summaries.
- Prefer small, targeted edits over rewriting files.
- Use `FakeLLMClient` for all automated tests, so tests cost no API tokens.
- No real LLM calls during this build. Live evaluations are deferred until explicitly requested; then use `smoke_llm.py`, max 1–2 calls per evaluated stage unless authorized otherwise. Fake mode is the runtime default.
- Do not re-verify earlier stages beyond running the existing test suite.
- If the spec is ambiguous, pick the simplest option, record it under "Decisions" in `PROGRESS.md`, and continue. Ask only when blocked.

## 10. Definition of done (V1)

All Stage 7 fake-mode acceptance items pass, no listed non-goal has been built, and the README lets a user with Python/Node/dependencies already installed start locally in under five minutes. API account creation, initial installs, and live Gemini quality verification are separate. Report the build as complete in fake mode and live semantic quality as unverified until explicitly evaluated.
