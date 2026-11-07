# Academic Manager

A macOS-first, local academic assistant powered by Pi. **MVP Phases 1–5 are implemented:** calendar, assignments, exams, dashboard, read-only study planning and embedded Pi AI chat. All academic records are persistent; scheduling calculations are deterministic.

## Run

Requires Node.js **24+** (built-in SQLite) and npm. The Pi SDK is included; browser AI uses your existing Pi login. Calendar, forms, dashboard and deterministic planning require no model.

```sh
npm ci
# If config.local.json does not already exist:
cp config.example.json config.local.json
# Edit calendarUrl locally; never commit or paste the token into agent conversations.
chmod 600 config.local.json
npm start
```

Open **http://localhost:3210** (or **http://127.0.0.1:3210**). Configuration and database files are private; the feed is never sent to Pi tools or browser responses.

- Day/week calendar; Monday-start weeks; all displayed times in Europe/Paris.
- Previous/next: arrow keys. Today: `t`. Forms and navigation work with Tab/Enter.
- Startup refresh, periodic refresh (15 minutes by default), and manual refresh.
- The UI remains immediately available while refresh runs. Last successful synchronization and refresh errors are visible.
- No model request is required to view the calendar or modify local French occurrences.
- Both overlapping events remain visible and are flagged.
- French lessons recur Tuesday/Thursday, 14:30–16:30. Modify/cancel a single occurrence using its card, with confirmation. Start/end edits use explicit ISO timezone offsets to avoid ambiguous DST input.
- Assignments/Exams have manual creation/editing forms, filtering, pagination, and confirmed deletion. Assignments can also be marked completed.
- The Dashboard is the home page, with today/week views, attention items, exam countdowns, known scheduling conflicts, candidate free periods and study recommendations.

### The Campus workspace

The frontend has a cohesive desktop redesign: persistent sidebar, lime/violet accents, real-data summary cards, source-colored calendars, cleaner record editors and read-only study previews. Light/dark mode is saved locally; fonts and icons are self-hosted, with no runtime CDN requests or additional framework/build step.

- **⌘K / Ctrl+K** opens a keyboard-friendly page/action palette; **⌥1–⌥5** switches pages.
- Assignment status tabs are functional filters; detailed date filters and planning controls expand when needed.
- Hash routes such as `/#calendar` support bookmarks and browser back/forward.
- Missing calendar totals are shown as unknown, not fake zeros; no example academic data is seeded.
- **AI Assistant** provides streamed Pi chat, visible tool activity, approval dialogs and cancellation. The floating **Ask Campus** button opens the same conversation from other pages. Prompt cards fill the composer without sending.

See [frontend design and keyboard guide](docs/frontend.md). Restart the local server and refresh the browser after upgrading the UI; no database migration is needed.

### French recurrence dates

No term dates were provided. At first initialization, lessons start in the current Paris week and have no end date. To choose a different starting date, set `frenchStartDate` (`YYYY-MM-DD`) **before first launch**. The initial recurrence definitions are persisted and are not reseeded or shifted on later launches. No historical lessons before that starting date are implied.

## Academic dashboard

The **Dashboard** opens by default and works without Pi or an LLM. It refreshes on entry, via **Refresh dashboard**, and every minute while visible. It reads the local database; the separate calendar synchronizer continues its startup/periodic refreshes.

- **Today:** classes/French lessons, dated assignments (including completed work), scheduled or known ongoing exams, and conflicts.
- **This week:** Monday–Sunday timetable with classes, assignment deadlines, exams, incomplete assignments dated this week, and all known conflicts. Select a day to open its class calendar. Undated work is shown separately, never assigned an invented date.
- **Needs attention:** overdue assignments; incomplete deadlines within 7 Paris calendar days; exams not ready for preparation within 14 days; remaining conflicts within 7 days; missing deadlines/exam dates; and incomplete near-term exam timing.
- **Coming up:** incomplete approaching assignments and exams within 30 days, plus known ongoing exams. Countdown days are Paris calendar days, not elapsed 24-hour periods.

All windows **include today and exclude midnight after the last day**: a 7-day window is today through today + 6 days. A date-only deadline is not overdue until the following Paris day; a deadline with a known time is checked precisely. Completed work does not trigger overdue/approaching alerts, and finished exams are not flagged for preparation. Past conflicts remain in the weekly timetable but are excluded from actionable attention items.

Dashboard conflict checks join classes/French lessons with exams whose start time **and** duration are known. Unknown times/durations never become fabricated busy intervals, and are explicitly flagged as incomplete checks. The Calendar tab itself remains the read-only university/local lesson view; the dashboard adds the exam/deadline overlay without writing calendar events.

The dashboard displays the last calendar sync and warns when the cache is missing, refresh failed, or cached events could not be expanded. Missing calendar data never hides assignments/exams. No detected conflicts is **not** a guarantee of available study time. Study recommendations below use actual interval subtraction and explicit preferences/uncertainty. Scheduled notifications remain future work. The overview and study plan are read-only projections of SQLite snapshots; the database schema remains version 2.

## Study planning

The Dashboard generates a study preview on open, visible refresh, or request—**without an LLM**. Set a date, 1–14 days, optional course/topic and optional total study-minute cap; use **Today**/**Tomorrow** for a one-day preview. **Generate recommendations** does not create or reserve events. Open **Customize this study preview** and **Fine-tune study preferences** to change temporary settings; these fields apply only to that preview, and **Use local defaults** resets them.

The planner merges actual class/French/exam intervals, adds event buffers, subtracts them from Paris-local study windows, clips past time, and respects minimum/maximum block lengths, breaks and daily caps. All-day/overnight events, recurrence overrides and both DST transitions are handled deterministically. Ambiguous/nonexistent study-window boundaries are skipped with a warning, not shifted silently.

Defaults are editable **planning preferences**, not invented facts about your availability: 08:00–20:00 every day, 25–60 minute sessions, 10-minute breaks, 15-minute event buffers, 180 study minutes/day, and a 60-minute starter budget when effort is unknown. For persistent preferences, add the `planning` object from `config.example.json` to ignored `config.local.json` and restart. Multiple non-overlapping same-day windows and selected weekdays are supported; `24:00` is a valid window end. Do not replace your private feed URL or publish the local config.

Work prioritization is transparent: overdue recovery, then earliest dated work, then undated work; date/time ties use priority, in-progress state and budget size. Completed assignments, ready exams, and already-started/past exam preparation are excluded. Known exam intervals still block time regardless of preparation status. Subject matching uses stored titles, courses and exam revision topics. An unmatched explicitly requested subject produces a **requested study topic**, never a fabricated assignment/exam or database row.

- Recorded assignment effort stays unchanged and is **total estimated effort, not measured remaining work**. Unknown assignment/exam effort gets a clearly labeled starter suggestion. A user-requested minute budget is not an effort estimate. For a single matching unknown-effort task, an explicit subject + minute request supplies its preview budget; otherwise the minute request caps total allocation.
- Date-only deadlines/exams are planned **before their date**, not at invented midnight/end-of-day deadlines. Same-day unknown-time work is left unallocated for clarification. Overdue assignment proposals are explicitly recovery work and never reported as on-time completion.
- Candidate free periods are shown before allocating proposals; only gaps meeting the minimum block length are listed. Workload details show allocated/unallocated budgets and reasons. Small residuals or insufficient periods remain visible; the deterministic greedy allocator is not an optimality or impossibility proof.
- **Missing/unreadable university cache:** availability and sessions are withheld, but workload stays available. **Stale cache (>24 hours), refresh failures or incomplete timing:** results are marked provisional. Offline cached planning never fetches or calls a model.
- Unknown exam dates cannot be placed and produce warnings. For a future/current exam with no known duration, the rest of the horizon after its possible start is conservatively excluded—**not assigned as an actual exam duration**. Unknown start with known duration uses the date's latest possible finish bound, including spillover and buffers. A past exam with unknown finish is explicitly flagged rather than assigned an invented ongoing interval; confirm it has ended before relying on provisional periods. Point/zero-duration class events conservatively exclude their date.

Plans only know recorded/published commitments; they cannot guarantee personal availability. Sessions, estimates, statuses and calendar data are never modified by planning. There is no session execution tracking, automatic calendar booking, notification scheduling or cloud service. The independent `AcademicService.suggestStudyPlan()` can be reused by a future local notification scheduler.

## Assignments and exams

Open **Assignments** or **Exams** in the navigation. All operations work offline, without Pi or a model. No sample academic records are seeded.

- Assignments: title, course, description, due date/time, priority, status, estimated minutes, and creation/modification timestamps.
- Exams: subject, date/time, duration, location, revision topics (one per line), preparation state, and creation/modification timestamps.
- Leave unknown dates, times, duration, effort, location and topics blank. A date without a time stays date-only; an unknown deadline stays NULL. A time requires a date.
- All local dates/times use Europe/Paris. Nonexistent/ambiguous DST times are rejected rather than guessed.
- Filter by search, inclusive dates, Paris-relative periods, status/preparation, course/priority, known/unknown dates, or overdue assignments. Date filters exclude undated work; clear them to see everything.
- Date-only assignments become overdue on the following Paris day, never at an invented time. Completed assignments are not overdue.
- Every update/completion/deletion requires the current record version. A stale editor gets a conflict instead of silently overwriting Pi's or another tab's changes; choose Edit again to reload.
- Delete prompts for explicit confirmation. Bulk operations are not supported. Notifications/reminders are not scheduled in this phase.

**Upgrading from Phase 1:** stop the app and Pi, then restart both. Startup transactionally migrates SQLite from version 1 to 2, preserving the calendar cache and French overrides. Back up `.local` while both processes are stopped if desired. Do not delete the database to upgrade.

## Embedded AI chat

Open **AI Assistant**, type a question and press **Send to Pi** (Enter; Shift+Enter adds a line). It uses Pi’s configured model and existing authentication, including ChatGPT/OpenAI Codex login. Opening the app or assistant never initializes a model or makes an AI request. No simulated responses or sample conversations are used.

- Replies stream into the conversation. Expand **Tool activity** to see actual academic tool calls and completion/failure.
- Every academic write—including creation, editing and completion—requires a one-time approval of the exact proposed action. Updates show the current record and proposed changes. Deletions keep the existing real confirmation boundary. Denying, closing or letting approval expire does not authorize a write.
- Only **one academic change per message** is allowed; bulk requests cannot be emulated with repeated writes. Current-version checks still prevent overwriting browser/Pi changes made while approval is pending.
- **Stop reply** cancels generation and pending approvals. It does **not** undo changes already approved and committed. Review tool activity before retrying any write; failed/disconnected requests are not automatically retried.
- **New chat** confirms before clearing conversation memory; academic SQLite records are untouched. History stays in server memory, not SQLite or browser storage. This tab’s opaque session ID is kept in sessionStorage to restore history on reload. Chats expire after 30 minutes of inactivity (checked on access); server restart forgets them. Limits: 8 conversations, 100 visible messages per chat, 8,000 characters per user message, 24 tool calls per turn, 3-minute turns and 2-minute approvals.
- Only the 14 academic tools are exposed. No shell/file tools, project instructions, arbitrary extensions, skills, prompt templates or MCP servers are discovered. Calendar/stored text is untrusted; university events remain read-only. Shared tools use the same SQLite services as manual forms.
- Sending transmits your message and queried academic data to your selected model provider under your Pi account/provider terms. There is no academic cloud sync. Credentials stay in Pi’s server-side authentication storage and are never returned to the browser. Do not paste secrets into chat.

If authentication/model access fails, the UI gives a safe error while non-AI features continue working. Run `pi`, use `/login` and `/model` if needed, then **New chat**. Model selection follows Pi’s defaults when a chat first starts. To explicitly override it, add `"ai": { "provider": "<Pi provider ID>", "model": "<Pi model ID>" }` to ignored local configuration and restart. Do not add credentials. An explicitly selected unavailable model fails rather than silently switching providers. No login cookies are extracted from ChatGPT or your browser.

See [chat implementation and safety](docs/chat.md).

## Pi terminal

From this directory, run your existing `pi` installation and trust the project extension. In an existing Pi session, use `/reload`.

`.pi/extensions/academic.ts` registers:

- `get_calendar_events` — date and day/week view
- `get_today_schedule` — today or a supplied date
- `get_week_schedule` — current week or the week containing a supplied date
- `get_academic_overview` — today/week, upcoming deadlines, exam countdowns/preparation, conflicts and missing information; no arguments
- `suggest_study_plan` — candidate free periods, prioritized real workload and read-only session suggestions; optional `date`, `days`, `subject`, `minutes` and temporary `preferences`
- `create_assignment`, `update_assignment`, `list_assignments`, `complete_assignment`, `delete_assignment`
- `create_exam`, `update_exam`, `list_exams`, `delete_exam`

Try “Add a probability assignment due next Friday”, “What exams do I have next month?”, “What needs my attention today?”, “Do I have time to study linear algebra tomorrow?” or “Plan my study sessions around my classes.” Pi resolves natural language using the current Paris date/time, queries records for exact IDs/versions, and asks for clarification when dates or matches are ambiguous. Missing academic information must not be invented. Use `/reload` after upgrading to register the new tools.

Deletion tools require Pi's actual user confirmation dialog and fail closed in non-interactive modes; a model-supplied `confirmed` argument cannot bypass this. The other record tools also work programmatically without a model.

These tools read the same SQLite data as the UI, with validated arguments and structured results. Pi starts calendar refresh on session startup, stops timers and closes the database on shutdown, and is instructed to query tools rather than conversational memory. Calendar text is explicitly untrusted content. The tools never expose the feed URL and never write university events.

Authentication stays with Pi: **existing Pi ChatGPT/OpenAI Codex credentials are reused**, not copied into this app. Authentication must match the selected provider: `openai` uses **Sign in with ChatGPT** via `/login openai`; `openai-codex` uses the separate legacy Codex flow. An existing legacy login does not authenticate `openai` models. If needed, launch the bundled Pi with `npx --no-install pi --no-extensions`, use `/login openai` and choose **Sign in with ChatGPT**, then start **New chat** in Campus. Do not copy/rename credential entries or supply an API key for subscription login. This app does not read browser cookies or ChatGPT app credentials. Model unavailability does not prevent local calendar access. The same tools and current Paris context power the embedded browser assistant. Terminal deletion requires Pi UI confirmation; the browser adds approval for every academic write.

## Data and privacy

- `.local/academic.sqlite`: cached university ICS, French recurrence definitions, occurrence overrides, sync timestamps, assignments and exams. Contains sensitive schedule information; excluded from version control.
- `config.local.json`: private feed URL and settings, excluded from version control.
- SQLite snapshots replace the entire read-only university source in a single atomic update. Removed events disappear; failed refreshes preserve the last good response. Occurrences are expanded on demand and keyed by source, UID, and recurrence identity.
- Fetches are HTTPS-only, timeout after 15 seconds, refuse redirects, and accept at most 5 MiB. Raw network/parser errors are not returned or stored because they could contain tokens.
- Local HTTP listens only on loopback, rejects unexpected Hosts, and requires same-origin + CSRF token for writes. No CORS or cloud synchronization; optional AI requests go through the server only after Send. This is not a multi-user security boundary; other processes running as your macOS user can access your data.
- Back up the `.local` directory while the application and Pi are stopped (SQLite WAL may contain recent writes). Protect backups as private data.

## Checks

```sh
npm run check
npm test
# Optional real desktop browser test (temporary profile, no personal login):
ACADEMIC_BROWSER='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' npm test
```

Tests use synthetic fixtures, fake fetchers, temporary SQLite files, and loopback HTTP servers. They never contact the private feed or a real model provider. The real Pi SDK is exercised with an isolated in-memory credential store and deterministic provider stream, not personal credentials. Coverage includes v1→v2 migration/rollback, CRUD persistence, unknown dates, DST validation/countdowns, attention-window boundaries, overnight/cross-week conflicts, read-only snapshots, interval arithmetic, study limits/buffers/breaks, allocation invariants, conservative unknown exam handling, offline/missing caches, filtering/pagination, stale edits, Pi tool handlers, confirmation refusal, approval expiry/replay/isolation, streamed Unicode, cancellation/disconnection, model failures, tool isolation, lazy initialization, and existing calendar regressions. The optional Chromium/Brave test exercises the actual dashboard, light/dark themes, command-palette keyboard navigation, history, self-hosted fonts, study previews/preferences, limits, safe text rendering, day navigation, forms, editing, completion and deletion dialogs, plus chat streaming, safe formatting, approval/denial, reload recovery, cancellation and clearing history without deleting academic records; it is skipped unless `ACADEMIC_BROWSER` is set.

## ICS scope

Supported: VEVENT fields, UTC/floating/Paris times, feed-supplied VTIMEZONE definitions, all-day/exclusive end dates, RRULE, EXDATE, date/date-time RDATE, individual RECURRENCE-ID edits (including cross-week moves), STATUS:CANCELLED, and SEQUENCE/DTSTAMP-based duplicate resolution. Paris has built-in modern EU DST rules; supplied VTIMEZONE takes precedence. Floating event times use Europe/Paris.

Explicit limitations: `RANGE=THISANDFUTURE`, period-valued RDATE, and unknown TZIDs without a supplied VTIMEZONE reject synchronization instead of silently creating an inaccurate calendar. Recurrence expansion is limited to 100,000 steps per series per query. Malformed/unsupported refreshes retain the previous cache. Historical pre-1996 Paris rules are not supplied by the fallback timezone. The app is designed for current academic calendars, not an archival timezone engine.

See [architecture and phased plan](docs/architecture.md).
