# Campus frontend

The academic manager's desktop UI is presented as **Campus**. It uses the existing Node HTTP API and native browser modules, not a second Next.js server or a framework/build toolchain. React is not necessary for this visual redesign; SQLite, calendar synchronization, Pi authentication and academic services remain unchanged.

## Design system

- Dark persistent sidebar, light warm-gray workspace, vivid lime primary accents and violet/mint/peach semantic colors.
- Light/dark themes with browser-local preference (`campus-theme`); academic data is never stored in localStorage. Without a saved choice, the OS color preference is respected.
- Self-hosted variable **Manrope** typography. Original font from the Google Fonts Manrope directory, copyright The Manrope Project Authors. Distribution license: `public/fonts/OFL.txt` (SIL OFL 1.1). There are no runtime requests to Google Fonts or other CDNs.
- Local SVG icons, custom decorative artwork and favicon; no analytics, remote illustrations, icon libraries or paid assets.
- CSS tokens in `public/style.css` control colors, surfaces, typography and spacing. Dark surfaces, status colors, focus rings and reduced-motion preferences are supported. This is still a macOS-first desktop layout, not a mobile application.

## UI modules

- `public/ui.js`: safe SVG construction, badges, empty states, local notifications and small formatting helpers. Academic content always uses text nodes, never interpolated HTML.
- `public/shell.js`: theme preference, command palette, keyboard navigation, local clipboard actions and section links.
- `public/app.js`: sidebar/hash routing, browser back/forward support, calendar rendering and French occurrence editor.
- `public/dashboard.js`: real-data summary cards, daily/upcoming work, attention groups and weekly overview. Missing university data shows an unknown class total, not a fabricated zero. Empty attention groups are hidden visually; missing-data warnings remain explicit.
- `public/records.js`: list/editor layout, functional status tabs, advanced filters, loading states, badges and unchanged version-protected CRUD operations.
- `public/planning.js`: read-only session cards, actual budget-coverage ring (explicitly not task completion), candidate free periods and temporarily overridden planning controls. Uncertainty is kept visible; additional warnings and detailed assumptions are expandable rather than discarded.

- `public/chat.js`, `public/chat-stream.js` and `public/chat.css`: embedded Pi conversation, POST/NDJSON streaming, safe text/limited Markdown formatting (no HTML, images or external links), visible tool activity, one-time native approval dialogs, cancellation and session recovery. Prompt cards fill the composer, never auto-send. A persistent launcher returns to the same conversation from any page. Model/thinking internals, credentials and raw provider errors are not shown.

The assistant is lazy: opening the page creates only an in-memory local conversation. Only Send starts SDK/auth initialization and model generation. Login/model failures are explicit, not disguised as fabricated replies. Every academic write requires review; updates show current records alongside requested changes. Escape declines approval; the command palette cannot cover an approval dialog. Stopping never claims to roll back committed changes.

## Keyboard and navigation

- **⌘K / Ctrl+K**: open/close the page/action switcher. Search filters navigation actions, not academic record contents. Arrow keys select, Enter opens, Escape closes and restores focus.
- **⌥1–⌥5**: switch Dashboard, Calendar, Assignments, Exams and Assistant. Uses physical digit key codes so macOS Option-generated characters still work.
- In Calendar, **← / →** changes the period and **T** returns to today, unless typing or editing an occurrence.
- Native Tab/Enter, dialog focus trapping, a skip-to-content link and visible focus rings are preserved.
- Hash routes such as `/#calendar` are bookmarkable. Back/forward restores pages without a separate router/server.

## Security and data behavior

No model is called by navigation, theme switching, the command palette, fonts or visual rendering. Frontend requests stay on the loopback application origin; existing Host checks, same-origin/CSRF write protections and CSP remain in place without `unsafe-inline`. Static assets, including binary-safe font responses and the chat modules/styles, are explicitly whitelisted. Chat requests use the existing same-origin/CSRF protections and POST streaming, never credentials in query strings. A capability session ID is the only chat value kept in sessionStorage; message history stays in server memory, not browser persistence. Sending deliberately shares the message and queried academic results with the selected Pi model provider. See [chat.md](chat.md). No private feed URLs are embedded in the UI or new assets.

There is no database migration and no sample data is seeded. Decorative artwork has no academic metrics or fictitious classes. All summary values and progress indicators derive from actual API responses; unloaded/unknown values use a dash.

## Checks and visual inspection

```sh
npm run check
npm test
ACADEMIC_BROWSER='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' npm test
```

The optional desktop browser test exercises actual creation/edit/completion/deletion, preview planning, status tabs, command palette keyboard behavior, focus restoration, hash history, theme persistence, reduced motion, font loading, chat replies/tool activity, approval/denial, cancellation, history recovery and clearing, and the absence of CSP violations or third-party frontend requests.

To capture visual artifacts from **synthetic, in-memory fixtures only**:

```sh
UI_SCREENSHOT_DIR=/tmp/campus-ui-preview \
ACADEMIC_BROWSER='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
node --test test/browser.test.js
```

Screenshots cover empty/populated dashboards, record editors, calendar, assistant, command palette, study preview and dark mode. They do not use the private calendar feed or the user's database/profile. Animations are allowed to settle before screenshots are taken.
