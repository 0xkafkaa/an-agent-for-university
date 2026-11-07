# Architecture and implementation plan

## Repository inspection

The initial repository was an empty directory, without Git metadata, package files, application code, or Pi integration. There were no reusable project components or existing tests. The machine provided Node 26, npm, and Pi. The implementation reuses Pi's existing CLI, authentication, tool registration, and session lifecycle; it does not build another agent runtime.

## Current architecture (Phases 1–5)

```text
Browser (public/) ── localhost HTTP (src/server.js) ─┬─ AcademicService ── SQLite / read-only ICS
                                                  └─ ChatManager ── Pi SDK ── chosen provider
                                                                      └─ 14 guarded academic tools ── AcademicService
Pi CLI ── .pi/extensions/academic.ts ── shared academic tools ── AcademicService
```

- `src/config.js`: reads ignored private settings, validates HTTPS URL and runtime settings; no secrets embedded in reusable code.
- `src/store.js`: prepared SQLite calendar and record statements. WAL and busy timeout support simultaneous Pi/UI access. Record updates/deletions use atomic version checks.
- `src/migrations.js`: transactional, versioned migrations (current schema 2), preserving version-1 calendar data. Future schema versions are rejected; migration failures roll back both DDL and the schema version.
- `src/records.js`: persistent assignment/exam CRUD, shared argument/output schemas, runtime validation, Paris-local date/time checks, filtering/pagination and deadline indicators. `AcademicService.records` exposes it to both UI and Pi.
- `src/record-tools.js`: registers the assignment/exam tools with typed schemas, structured output, and real user confirmation for deletion.
- `src/overview.js`: deterministic, read-only dashboard projection of one SQLite snapshot and one captured Paris clock. Summarizes all records without the paginated CRUD list limit, computes date/time-aware deadline states, exam countdowns/timing, and known class/exam conflicts. Unknown dates/timing stay unknown. No model, network call, writes or schema changes.
- `src/overview-tool.js`: registers `get_academic_overview` with strict no-argument validation and structured output. Very large model-facing responses become an explicitly labeled counts summary pointing to filtered list/calendar tools; structured results remain complete.
- `src/intervals.js`: pure half-open interval union/subtraction, independent of timezones. Used for class/exam exclusions and inter-session breaks.
- `src/planning-policy.js`: validated study preferences and preview request schemas. Optional persistent defaults come from local configuration; per-request overrides never write settings.
- `src/planning.js`: deterministic free-period detection, workload projection/prioritization, conservative uncertainty exclusions, bounded greedy session allocation, and explicit shortfalls/insights. Runs inside one read-only SQLite snapshot with a frozen Paris clock, with no model/network dependency.
- `src/planning-schema.js` and `src/planning-tool.js`: structured output contract and `suggest_study_plan` registration, including explicit truncation notices for very large model-facing results.
- `src/calendar.js`: pure calendar parsing, bounded expansion, duplicate selection, Paris date boundaries, French seed definitions, interval overlap detection. `ical.js` implements RFC recurrence expansion; `luxon` handles Paris date arithmetic and IANA timezone conversion.
- `src/service.js`: owns synchronization, snapshot replacement, offline behavior, query composition, French overrides, timer lifecycle. Concurrent refresh calls in a process share one request. Separate UI/Pi processes may both refresh safely; there is no additional background daemon.
- `src/server.js`: loopback HTTP, same-origin write protections, whitelisted static UI assets and cancellable POST/NDJSON chat endpoints. Non-chat endpoints remain independent of the LLM.
- `src/academic-agent.js`: shared 14-tool registration and factual academic instructions/current Paris context for CLI and embedded chat.
- `src/chat.js`: bounded in-memory conversations, streamed events, one-time approval capabilities, request deduplication, cancellation, timeouts and safe errors. No chat database migration.
- `src/chat-tools.js`: wrappers around the existing academic handlers, with one write per user turn, exact-action approval before mutation, version-aware update previews and redaction. No duplicated CRUD implementation.
- `src/pi-chat.js`: lazy Pi SDK initialization with existing Pi auth/default model, in-memory session/settings, empty discovered resources and an academic-only active tool allowlist. Thinking/compaction/retry/cache-warming defaults are explicitly controlled; no automatic model calls on page entry.
- `.pi/extensions/academic.ts`: the registration point for current and future academic tools. Tool handlers call the service, never a model-generated database substitute. Long-lived resources begin on session startup, not extension discovery.
- `public/`: dependency-free desktop browser UI, safe text rendering of untrusted content, calendar columns, conflicts and explicit local-occurrence confirmation. `client.js` shares HTTP/text utilities, and `records.js` implements assignment/exam forms, filters, pagination, editing, completion and confirmed deletion. `dashboard.js` renders the default home dashboard using safe text nodes and refreshes on entry, visible polling, and explicit refresh. `planning.js` renders free periods, proposed sessions, uncertainty, policy and uncovered work, plus temporary preview controls. Planning and overview refresh independently so an overview failure does not hide the planning error/workload.

The **Campus** desktop visual layer adds `public/ui.js` (safe icons, badges and empty states) and `public/shell.js` (local theme, command palette, keyboard navigation and hash history). Manrope typography and SVG assets are self-hosted. The existing browser modules and HTTP APIs remain in use—no React/Next.js server, build infrastructure or database migration. Embedded chat adds pinned Pi SDK/pi-ai/typebox dependencies, not another server or browser framework. Full design, accessibility, privacy and visual-test details are in [frontend.md](frontend.md).

Source snapshot persistence rather than materialized occurrences avoids stale expanded rows and synchronization duplicates. Event IDs are stable across recurrence moves. Expanding exceptions independently ensures an occurrence moved into a different query week is not lost. Cancellation of the series suppresses its exceptions; cancellation of an occurrence does not affect other occurrences.

### Calendar tables (introduced in version 1)

| Table | Columns / constraints |
|---|---|
| `calendar_sources` | `id` PK (`university` only), `ics` nullable, `last_synced_at`, `last_attempt_at`, `sync_error` |
| `local_events` | `uid` PK, `ics` required, `created_at` required |
| `occurrence_overrides` | composite PK (`uid`, `recurrence_id`), FK to local event, `cancelled` boolean, `replacement_json`, `modified_at`; cancellation/replacement consistency CHECK |

The feed URL is configuration, not a database field. University data has no edit endpoint. Only the university snapshot can be replaced through successful synchronization. Override operations verify both the local UID and original occurrence identity; confirmation must be explicit. Record deletion tools require an actual Pi confirmation dialog and refuse deletion without UI; HTTP deletion requires same-origin/CSRF protection and explicit browser confirmation. Bulk operations are not exposed.

### Assignment/exam tables (implemented in version 2)

The migration implements the following fields, with an additional positive integer `version` on each table for optimistic concurrency. It also constrains timezone to Europe/Paris, titles/subjects to nonblank text, and topics to a JSON array.

```sql
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  course TEXT,
  description TEXT,
  due_date TEXT,                 -- nullable YYYY-MM-DD; date-only deadlines remain date-only
  due_time TEXT,                 -- nullable HH:MM; never infer midnight/end-of-day
  timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high')),
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
  estimated_minutes INTEGER CHECK(estimated_minutes > 0),
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  CHECK(due_time IS NULL OR due_date IS NOT NULL)
);
CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  exam_date TEXT,
  start_time TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  duration_minutes INTEGER CHECK(duration_minutes > 0),
  location TEXT,
  topics_json TEXT NOT NULL DEFAULT '[]',
  preparation_status TEXT NOT NULL
    CHECK(preparation_status IN ('not_started','in_progress','ready')),
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  CHECK(start_time IS NULL OR exam_date IS NOT NULL)
);
CREATE INDEX assignments_due ON assignments(status, due_date);
CREATE INDEX exams_date ON exams(exam_date);
```

Unknown information remains NULL. Local dates and times are intentionally separate, so a known date with unknown time is not converted into an invented timestamp. Application validators must validate actual dates/timezones and JSON types as well as SQL constraints. Versioned migrations are implemented in `src/migrations.js`. IDs are UUIDs; timestamps are UTC; date/time fields are Paris-local. Omitting a field during update preserves it, while explicit null clears nullable fields. A date-only deadline is overdue only after that Paris date has passed. Invalid/nonexistent/ambiguous Paris wall times are rejected. The service validates inputs independently of Pi, including immutable/unknown fields and single-record update versions.

## Small implementation phases

### 1 — Calendar (implemented)

1. Private configuration, SQLite schema and persistence.
2. ICS source snapshot fetch/validate/replace with offline fallback.
3. Local Tuesday/Thursday French recurring definitions and per-occurrence overrides.
4. Daily/weekly queries and conflict detection; localhost calendar UI.
5. Read-only Pi tools sharing the service.
6. Tests for DST, recurrence/exception/cancellation, deduplication, schedule updates/deletion, offline cache, override persistence, and HTTP safety.

### 2 — Assignments and exams (implemented)

- Transactional migrations, persistent CRUD, shared runtime validators, nullable deadlines/times, timestamps, version-protected single-record updates and deletion.
- Manual browser entry/edit forms, filtering, pagination and completion, available without a model.
- Create/update/list/complete/delete assignment tools and create/update/list/delete exam tools registered in the existing Pi extension.
- Clarify ambiguous natural-language dates before writing, particularly unknown exam year/time. Derive relative dates from current Paris time, supplied in tool context; do not invent missing information.
- Add tests for partial/unknown deadlines, validation, filtering, completion, date ambiguity, persistence, and existing calendar regression tests.
- Require real UI confirmation for destructive/bulk operations; do not accept a model-provided confirmation boolean as proof of user consent. Fail closed without an interactive UI. Current calendar confirmation comes from the browser form, not from a model tool.

### 3 — Academic dashboard (implemented)

- `GET /api/overview`, `AcademicService.overview()` and the read-only `get_academic_overview` Pi tool share the same deterministic projection. No migration; schema remains version 2.
- Default home dashboard: today, upcoming work, Monday–Sunday timetable, incomplete assignments, attention groups and sync/completeness warnings. Existing calendar/CRUD navigation is preserved.
- Attention policy: incomplete deadlines within 7 Paris calendar days; not-ready exams within 14; upcoming exams within 30; remaining/ongoing conflicts within 7. Windows include today with an exclusive end boundary. Historical conflicts remain in today/week displays, not actionable attention.
- Date-only/unknown times are explicit. Countdown days use Paris calendar arithmetic across DST. Known-duration ongoing exams are shown across midnight/week boundaries; missing finishes are never invented. Undated records are kept separate rather than assigned artificial urgency.
- Dashboard conflicts join class/French intervals and exams with known starts and durations. Unknown timing is flagged as a limitation; preparation-ready does not mean an exam is cancelled. Exam/deadline overlays never write calendar events. The Calendar tab remains the class/local-lesson view.
- Aggregation uses a deferred SQLite read transaction for a consistent snapshot across sources, overrides and records; its clock is captured once. `scheduleBetween` is the internal range query shared with day/week calendar views. Read failures cannot leave a transaction open. Calendar expansion errors are sanitized and do not remove persistent assignments/exams from the overview.
- Dashboard reloads on open, explicit refresh and once per visible minute; no background notification infrastructure. Every refresh is deterministic, not an LLM request. Calendar synchronization remains separate from dashboard reads.
- Service, HTTP, Pi tool and real desktop browser tests cover window edges, Paris midnight/DST/year boundaries, unknown/finished/ongoing exams, cross-week conflicts, offline/invalid caches, no writes, no pagination truncation, safe rendering, refresh and day navigation, alongside all earlier regressions.
- The separate Phase 4 study planner now supplies candidate free periods and suggestions; the overview itself remains a focused read-only academic summary.

### 4 — Intelligent planning (implemented)

- `AcademicService.suggestStudyPlan()` is shared by `GET /api/study-plan`, same-origin/CSRF-protected `POST /api/study-plan` previews, the dashboard and the `suggest_study_plan` Pi tool. Captures one Paris clock and uses a read-only SQLite snapshot; no schema migration, event writes or external calls.
- Requests select a Paris date (today to one year ahead), 1–14 days, optional subject filter, total minute cap and temporary preference overrides. Defaults are editable local planning preferences, not invented academic facts: 08:00–20:00 daily, 25–60 minute blocks, 10 minute breaks, 15 minute buffers, 180 study minutes/day and 60 minute unknown-effort starter suggestions. Multiple windows/weekdays and 24:00 end boundaries are supported; overlapping/invalid preferences fail validation.
- Expands real calendar events including overrides and a buffer-wide surrounding range, joins all known exam intervals regardless of preparation state, unions overlaps and subtracts from local study windows. Clips past time and rounds candidate bounds inward to minutes; returns only gaps meeting the minimum block length. DST uses actual elapsed minutes inside Paris-local date windows. Ambiguous/nonexistent boundary times are skipped with warnings.
- Missing/unreadable university cache withholds availability/sessions but retains workload. Cache age over 24 hours, failed refreshes, undated exams and other uncertainty make suggestions provisional. Unknown exam starts with known duration use a conservative latest-finish bound; current/future unknown durations exclude the remaining finite horizon after the possible start. These are planning exclusions, never invented actual intervals. Past-date exams with unknown finish produce explicit warnings rather than infinite fictitious busy intervals. Point/zero-duration classes exclude their date.
- Workload includes all pending/in-progress assignments and not-ready future/undated exam preparation, without CRUD pagination truncation. Subject matching checks stored titles/courses/topics. An explicit unmatched subject becomes a requested topic, not a persisted assignment/exam. Ready/completed/already-started prep is excluded from workload but known exam commitments still occupy time.
- Priority order is overdue recovery, then earliest dated work, then undated work, with priority/progress/budget-size tie breaks. Known effort is recorded total effort, not remaining work. Unknown effort receives a labeled starter budget; explicit user-requested minutes are also labeled, not stored as an effort estimate. No unknown academic dates/times are fabricated.
- Date-only tasks use a separate conservative planning cutoff before their date, not an invented actual deadline timestamp. Same-day unknown-time work is left unallocated for clarification; overdue tasks are labeled recovery work. Session allocation is a bounded deterministic greedy heuristic, not an optimizer/impossibility proof. Respects recorded cutoffs, min/max blocks, break reservations across all periods and tasks, per-day caps and an optional total minute cap; returns uncovered budgets and reasons instead of silently discarding work.
- Recommendations and deterministic insights refresh on dashboard open/visible refresh or explicit preview/tool requests. Nothing is booked, completed or notified automatically. `buildStudyPlan` is invocation-independent, so a future local notification scheduler can reuse it without new planning logic.
- Tests cover interval union/subtraction, allocation invariants, deadlines/date-only cutoffs, French cancellation, known/unknown exam timing, stale/offline caches, no writes/fetches, weekday/local-clock rules, 23/25-hour DST days, multi-day/buffer edge cases, limits and exhaustion, large structured results, HTTP safety, actual Pi schema validation, and real browser preview/reset/error flows, alongside all prior regressions.

### 5 — Embedded Pi chat (implemented)

- Native-browser conversation with streamed responses, real tool activity, cancellation, approval/denial, new-chat confirmation and reload recovery. No model request before Send, and no simulated production responses.
- Direct in-process Pi SDK, existing server-side Pi authentication and selected model. In-memory sessions do not persist transcripts or copy credentials. Only trusted academic tools/resources are active; file/shell/codemode tools and arbitrary extensions/MCP discovery are excluded.
- Every write has a one-time, chat/turn-bound, expiring approval. Only one attempted valid write per user message prevents bulk emulation and approval spam. Current-version service checks remain authoritative after approval; denied/expired/disconnected requests fail closed. Committed approved changes are not rolled back by cancellation.
- Read-only calendar/forms/dashboard/planning remain useful without a model. Provider failures are sanitized, never raw credential-bearing SDK errors. The browser warns that Send shares selected academic data with the chosen provider; no academic cloud synchronization is introduced.
- Tests cover real SDK initialization/agent tool loop with deterministic provider streams, tool isolation, lazy initialization, Unicode chunking, HTTP protections, all mutation approvals, stale edits, replay/expiry/isolation, cancellation/disconnect, errors and real browser flows. No real provider or private academic feed is contacted. Details and limits: [chat.md](chat.md).

## Dependencies and risks

`ical.js` and `luxon` implement calendars/timezones. Pinned `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and `typebox` provide embedded AI and schemas. SQLite, HTTP, tests, and fetch use Node built-ins. The SDK reuses the standard Pi authentication directory (including `PI_CODING_AGENT_DIR`) without exposing or copying credentials; Pi handles normal token refresh. No paid dependencies, cloud database, mobile app, or cloud synchronization. Model access follows the selected provider/account’s terms.

Main risks: inconsistent upstream ICS, unsupported recurrence variants, missing term dates, ambiguous natural-language input, and private schedule leakage through logs/prompts. Current safeguards include explicit unsupported-feature failures, last-good snapshot retention, bounded fetch/recurrence work, local-only HTTP, secret-free structured tool responses, text-only UI rendering, and explicit confirmation of local changes. A real Chromium/Brave browser smoke test is available using `ACADEMIC_BROWSER` and a temporary profile, in addition to service, migration, HTTP, and tool-handler tests. No macOS packaging yet; the UI is served as a local desktop browser application. Stop and restart both Pi and the HTTP application when upgrading schema/code.
