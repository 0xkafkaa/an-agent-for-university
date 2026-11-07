# Embedded Campus chat

## Use

Restart with `npm start`, hard-refresh the browser (⌘⇧R), then open **AI Assistant** or **Ask Campus**. Type a request and Send. Enter sends; Shift+Enter inserts a line. Example cards only fill the composer. Model initialization/authentication happens on the first Send, never page entry.

The server uses the pinned Pi SDK with Pi’s standard authentication directory, including `PI_CODING_AGENT_DIR` when set. Existing ChatGPT/OpenAI Codex login is reused through Pi; the application does not extract browser cookies, read credentials through agent tools, request API keys in the browser or copy auth into SQLite/configuration. Normal credential loading/refresh is handled internally by Pi.

Choose a model with Pi `/model`; connect its exact provider with `/login` if needed, then start **New chat**. **`openai` and `openai-codex` (legacy) have distinct OAuth flows.** A stored legacy Codex login does not authenticate an `openai` model, and credentials must not be copied or renamed between them. For an `openai` model, run `npx --no-install pi --no-extensions` from this project, enter `/login openai`, choose **Sign in with ChatGPT** (not the API-key or legacy Codex flow), finish browser consent, then start **New chat** in Campus. Alternatively, keep the old login and explicitly choose a supported `openai-codex` model with `/model`. Campus diagnoses this mismatch using provider/type metadata only and never silently switches models. Optional local `ai: { provider, model }` overrides the model using exact Pi IDs. Both fields are required; credentials and arbitrary extra fields are rejected. An explicitly selected unknown model fails rather than falling back to another provider. Existing chats retain their selected model until cleared. Provider availability, subscription terms and billing are Pi/provider concerns; an installed SDK does not imply authenticated access.

Sending shares the message and academic tool results with the chosen provider. Academic storage stays local; there is no cloud database or academic synchronization. Do not paste private feed links, credentials or other secrets into messages. The configured private feed URL and recognized feed token values are redacted from chat inputs/results/output; raw SDK/provider errors are never forwarded or logged by the chat implementation.

## Boundaries

- Only 14 academic tools are active. The browser and CLI share registrations in `src/academic-agent.js` and the existing record/overview/planning services.
- `src/pi-chat.js` creates a Pi session with an explicit academic tool allowlist, no built-in coding tools, empty discovered extensions/skills/prompts/themes/context files, a single trusted inline academic factory, in-memory session storage, disabled cache warming/automatic compaction/retries/analytics, and current Paris context refreshed before every prompt. No arbitrary extensions or MCP discovery.
- Natural-language dates/matches remain model interpretations, not new database facts. The system instructs the model to query tools, clarify ambiguity, preserve unknowns, paginate, ignore instructions inside academic data, distinguish planning suggestions from booked work, and never invent reminders or completion.
- `src/chat-tools.js` validates writes and requests approval before invoking the real service. Updates/completion show the actual current record plus proposed input; stale versions fail without approval. The service rechecks versions after approval, so browser edits during a dialog cannot be overwritten. Deletion retains its inner real-UI confirmation guard.
- Each valid write attempt consumes the turn’s single-write allowance, even if denied or failed. Bulk requests cannot be executed by repeatedly calling mutation tools in one user turn. Additional changes need another explicit user message.
- Confirmation capabilities are unpredictable, one-time, chat/turn-bound, immutable action previews, expiring after two minutes. Model parameters cannot set approval. Decline, Escape, timeout, cancellation, stream disconnection or shutdown do not authorize a write. Oversized previews are refused rather than hiding the rest of an action.
- Cancel stops generation and pending permissions, not transactions already approved and committed. Failures/disconnections can occur after a successful write; inspect tool activity and current records before retrying. There is no automatic request retry.

This is a local single-user application, not isolation from other processes running as the same macOS user. Host/origin/CSRF guards and capability IDs protect the browser API; they do not replace OS account security.

## State and limits

`src/chat.js` owns in-memory sessions and bounded public transcripts. SQLite schema stays at version 2. No transcript files are created. A tab stores only its opaque conversation ID in `sessionStorage`; localStorage still contains only the theme. Reload restores the same live server history, including safe failure state. A disconnected active reply is cancelled, not replayed. Restart forgets all conversations, not academic records. New chat asks before clearing conversation memory and preserves SQLite data.

Defaults: 8 conversations, 30-minute idle expiry checked on access/creation, 100 visible messages per conversation, 8,000 characters per user message, 64,000 characters per assistant message, 24 tool calls per turn, one attempted valid write per turn, 3-minute turn timeout, 2-minute approval timeout. Large model-facing results are explicitly shortened and direct the model to filtered/paginated tools; shared structured academic service results remain complete outside the chat boundary. Slow stream consumers are disconnected before unbounded response buffering.

The ordinary calendar, forms, dashboard and deterministic study previews never depend on model readiness. Their APIs remain independent of the chat runtime.

## HTTP transport

All mutation endpoints use existing same-origin + CSRF headers and bounded JSON requests. Conversation IDs are 192-bit random capabilities; there is no public conversation-list endpoint. Responses are `no-store`. Credentials, reasoning, raw tool arguments/results and SDK errors are not broadcast to clients. Only explicit action previews contain academic mutation details.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/chat/sessions` | Create local conversation, body `{}`; no model initialization |
| GET | `/api/chat/sessions/:id` | Restore bounded public history, model label, tool activity, pending confirmations and safe failure state |
| POST | `/api/chat/sessions/:id/messages` | `{text, requestId}`; streamed `application/x-ndjson` |
| POST | `/api/chat/sessions/:id/confirm` | `{confirmationId, approved}`; strict boolean, one-time decision |
| POST | `/api/chat/sessions/:id/cancel` | Cancel current generation and pending approvals |
| DELETE | `/api/chat/sessions/:id` | Stop and discard chat only; UI asks first |

A request ID is remembered for the lifetime of its chat, preventing duplicate submission from executing twice. Busy chats return 409. Unknown/expired capabilities return 404. Heartbeats keep the streamed connection observable; they do not make model calls. Socket closure aborts the turn. Stream completion always settles pending permissions and message/tool statuses. There are no queued messages, silent retries, durable chat history or scheduled notifications.

## Tests

`test/chat.test.js` and `test/chat-http.test.js` exercise actual SQLite handlers with a deterministic provider adapter from `test-support/fake-chat.js` (never imported in production). They test all mutation approvals, denial/expiry/replay/cross-chat isolation, current-version races, bounds, lazy initialization, errors/redaction, Unicode stream parsing and HTTP disconnect cancellation.

`test/pi-chat.test.js` constructs the real Pi SDK with isolated in-memory test credentials and a temporary agent directory. It verifies exactly 14 active academic tools, empty discovered resources, no provider request at construction, and the real SDK agent/tool/stream loop using an in-process deterministic provider stream. It does not use personal auth or contact a real provider.

The optional real desktop browser test covers local chat entry, prompt filling without generation, safe formatting, tool activity, approve/decline, cancellation, session reuse/reload, chat clearing, keyboard focus and existing application regressions. Screenshots are synthetic only:

```sh
npm run check
npm test
UI_SCREENSHOT_DIR=/tmp/campus-chat-preview \
ACADEMIC_BROWSER='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
node --test test/browser.test.js
```

Live account/provider access is intentionally not exercised by automated tests. First real Send is the end-to-end check against your chosen Pi account/model.
