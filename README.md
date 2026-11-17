# MZP Quiz

MZP Quiz is an offline-first live quiz competition system. It uses a React + TypeScript frontend, a Fastify backend, SQLite persistence, and WebSockets for live session and leaderboard updates.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer

The server's `dev`, `start`, `db:migrate`, and `test` npm commands rebuild `better-sqlite3` for the currently active Node.js runtime before running. This prevents native-module ABI mismatches when switching Node versions. If you start the server outside these npm scripts, run `npm rebuild better-sqlite3` first.

## Install

```bash
npm install
```

## Local data and configuration

The server creates its application data directories before opening SQLite. Set `MZP_DATA_DIR` during development to keep the files easy to inspect:

```bash
MZP_DATA_DIR=./.local-data npm run dev:server
```

This creates `.local-data/database.sqlite`, `.local-data/media`, `.local-data/backups` and `.local-data/logs`. The directory is ignored by Git and is never deleted or reset by the application.

Without `MZP_DATA_DIR`, development uses `.local-data`; packaged Windows operation will use `%APPDATA%\\MZP Quiz`, while other platforms use their conventional user data location (`$XDG_DATA_HOME/mzp-quiz` or `~/.local/share/mzp-quiz`).

Timestamps are stored as Unix milliseconds. The database enables SQLite foreign-key enforcement and WAL journaling. JSON settings/configuration are validated before being stored as JSON text.

## Start development

Run both applications:

```bash
npm run dev
```

Or run them independently:

```bash
npm run dev:server   # Fastify on http://127.0.0.1:3001
npm run dev:web      # Vite on http://127.0.0.1:5173
```

For a development data location, copy `.env.example` to an environment appropriate for your shell, or prefix the server command as shown above. The frontend uses `VITE_API_URL`, defaulting to `http://127.0.0.1:3001`.

## Administrator access

Set `MZP_ADMIN_TOKEN` in the server environment before starting the application. It must contain 24-128 URL-safe characters. Generate a strong local secret with Node.js:

```bash
export MZP_ADMIN_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
```

Keep the value private and do not commit it. The admin interface asks for this token and stores the authenticated session in browser session storage. Administrative HTTP operations require the token; the admin WebSocket role uses authenticated subprotocols. A missing token disables administrative operations rather than granting access.

Generate a token once and reuse it for later runs. In each new terminal, set the same saved value before starting the app:

```bash
export MZP_ADMIN_TOKEN='your-saved-token'
npm run dev
```

The generated token is only available in the terminal session where it was created; it is not automatically entered in the browser. Paste the same token into the admin sign-in screen. If you generate a new token, restart the server with that value and sign in with it. Never share the token in chat, logs, or source control.

Participant registration is event-specific and does not require an internet account. Registration returns a random participant token once; the contestant screen stores it locally for that browser. Participants can only access their own submission records. Disabling a participant revokes token use without deleting historical results.

This application does not currently encrypt HTTP/WebSocket traffic. Use it on a trusted local network; do not expose it to an untrusted network or the public internet.

## Database commands

Migrations run automatically when the server opens the database. They can also be checked explicitly:

```bash
npm run db:migrate
```

The migration runner records applied versions in `schema_migrations` and safely skips versions already applied. It does not recreate an existing database. Migration 4 adds event participants, submissions, score transactions, buzzer results, score-reset audit records, and event score generations; migration 5 scopes a participant's current answer to a live session and stores elapsed answer time for scoring; migration 6 repairs older buzzer tables by adding the persisted score-generation column when it is missing. All preserve existing records.

Create a consistent SQLite backup while the server is stopped or running:

```bash
npm run db:backup
# Optional explicit destination:
npm run db:backup -- /path/to/quiz-backup.sqlite
```

Restore only after stopping the server, and keep the existing database as a separate safety copy:

```bash
npm run db:restore -- /path/to/quiz-backup.sqlite
```

Restore validates SQLite integrity before replacing the database file. The restore command does not delete the source backup, submissions, or audit records contained in it.

## API

All API responses use `{ status, data }` for success and `{ status, error: { code, message } }` for errors.

- `GET /api/health` — application health
- `GET /api/health/database` — database connection and migration status
- `GET /api/dashboard` — event, round and question totals
- `POST /api/admin/auth` — validate the configured administrator token
- `POST/GET/PUT /api/events` and `POST/GET/PUT /api/events/:eventId/rounds` — manage events and rounds (mutations require admin authorization)
- `GET /api/events/:eventId/rounds/:roundId/questions` — list questions without answer keys
- `POST /api/admin/rounds/:roundId/questions`, `GET/PUT /api/admin/questions/:questionId`, `POST /api/admin/questions/:questionId/duplicate`, and `PUT /api/admin/rounds/:roundId/questions/order` — manage questions and protected answer data
- `POST/GET /api/events/:eventId/participants` — register and list enabled event participants
- `GET /api/admin/events/:eventId/participants` and `PATCH /api/admin/participants/:participantId` — administer participants
- `POST /api/sessions/:sessionId/answers` and `POST /api/sessions/:sessionId/buzzer` — submit participant-token-authenticated answers or buzzer requests
- `GET /api/sessions/:sessionId/submissions/:questionId` — read the authenticated participant's own submission
- `GET /api/events/:eventId/leaderboard` — public standings
- `GET /api/admin/events/:eventId/submissions` and `POST /api/admin/submissions/:submissionId/grade` — review submissions and grade manually judged answers
- `POST /api/admin/events/:eventId/scores/adjust` and `/api/admin/events/:eventId/scores/reset` — audited score adjustment and confirmed score-generation reset

Administrative routes and mutations require `Authorization: Bearer <MZP_ADMIN_TOKEN>`. Public question and leaderboard responses omit answer keys and internal validation data. Public participant registration is intentionally event-scoped; duplicate normalized identities within one event are rejected.

## Scoring and live competition

- Multiple choice and true/false answers are checked against the stored answer key. Written, short, and quick-question text answers use Unicode normalization, case folding, whitespace normalization, and exact matching only. Rapid-fire answers are host-judged per prompt in Live Control.
- Manually judged answers remain pending until an administrator grades them. Unsupported/interactive question types do not receive automatic correctness credit.
- Each question's configured points are awarded for a correct answer. Incorrect answers receive no penalty unless the question explicitly configures penalty points. A speed bonus is applied only when its threshold and points are configured.
- Rapid-fire question points are divided as evenly as possible across their prompts; any remainder points go to the earliest prompts. The host selects one contestant and marks each spoken answer correct or incorrect; each judgment automatically advances to the next unanswered or passed prompt, skipping already-judged prompts. Passing advances to the next unanswered prompt. Passed prompts can be revisited while the timer is running, and **Next Rapid-Fire Prompt** can also be used to advance manually.
- The server records submission timestamps, rejects submissions outside the active question window, and uses per-participant request limits. Answer changes are disabled by default; when enabled in event settings, a participant can replace their answer before the deadline. Scoring is transactional and duplicate-safe.
- Buzzer requests are ordered by server receipt; only one request can win a buzzer question. No physical buzzer hardware integration is included.
- Standings order by total points, correct-answer count, case-insensitive display name, then participant ID. Round and event totals are derived from persisted score transactions.
- Reset requires an explicit confirmation and advances the event's score generation. It does not delete submissions, scores, or reset audit history. Administrative score adjustments are also persisted as score transactions.
- WebSocket clients receive sanitized live-session and leaderboard updates. OBS output is available through the event-specific Browser Source URLs in the admin Events page.

## Run a local test competition

1. Install dependencies with `npm install`.
2. Set `MZP_ADMIN_TOKEN` as described above, then start the server and web app with `npm run dev`. By default they use `http://127.0.0.1:3001` and `http://127.0.0.1:5173`.
3. Open the admin dashboard, enter the admin token, create an event, add rounds/questions, and start its live session.
4. Open **Live Control** and start the event session. For rapid fire, create multiple prompt/accepted-answer pairs in the Question Editor. In the live session, reveal the question and select a contestant. **Mark Correct** and **Mark Incorrect** automatically advance to the next unanswered or passed prompt; **Pass Prompt** advances to the next unanswered prompt. Passed prompts can be revisited before time expires, and **Next Rapid-Fire Prompt** remains available for manual advancement. For multiple-choice questions, select and confirm the contestant's spoken option there; reveal the answer separately when ready.
5. Add the event's OBS Browser Source URL from the Events page to show the live question, confirmed choice, timer, or leaderboard.
6. Use the participant and leaderboard panels to manage event records and scores. To test score reset, use the admin score controls and confirm; prior submissions and audit records remain stored.

When serving the web app from another origin, add that exact origin to `MZP_ALLOWED_ORIGINS` as a comma-separated value. The default only allows the local Vite origins; arbitrary browser origins are rejected.

## Verify

```bash
npm run build
npm test
```

The test suite creates isolated temporary SQLite databases and removes them after each test.

## Structure

```text
apps/
  server/
    src/database/       paths, connection, migrations and repositories
    src/game/           live engine, validation, scoring and competition services
    src/app.ts          Fastify routes, authorization and safe error handling
    tests/              isolated database and API tests
  web/ React + TypeScript + Vite admin and OBS overlay
packages/
  shared/                Zod schemas and shared domain types
```

Migration 2 expands supported round/question types and adds backend-only answer-key and manual-judging data. Migration 4 adds competition registration and scoring persistence without resetting existing data.

Known limitations: admin and participant bearer tokens travel over unencrypted HTTP/WebSocket connections; written-answer matching is exact after normalization rather than semantic; buzzer support is server-side only; and there are no internet accounts, cloud services, or Windows installers in this phase. Media remains a validated managed-path reference.

## OBS Studio overlays (Step 7)

The app includes read-only Browser Source overlays. They use the public session API and the existing public WebSocket channel, so they do not expose admin controls or unrevealed answer keys and work without an internet connection.

Use the event ID from the admin event page in these URLs:

```text
http://127.0.0.1:5173/overlay/main?eventId=EVENT_ID
http://127.0.0.1:5173/overlay/question?eventId=EVENT_ID
http://127.0.0.1:5173/overlay/timer?eventId=EVENT_ID
http://127.0.0.1:5173/overlay/leaderboard?eventId=EVENT_ID
http://127.0.0.1:5173/overlay/round?eventId=EVENT_ID
http://127.0.0.1:5173/overlay/announcement?eventId=EVENT_ID
```

The overlay studio offers ten layouts: Classic Quiz, Competition, Minimal, Rapid Fire, Neon Pulse, Studio Panel, Ticker, Spotlight, Card Grid, and Lower Third. Selecting a style updates the live preview immediately; save the overlay settings to use it by default in OBS. Adjust **Overlay content size** to scale the question panel, choices, and timer together; the compact 72% default leaves more room for the broadcast, and the preview reflects size changes immediately. Use **Show overlay panel background** to keep the current framed panel or make it fully transparent; in transparent mode, the question and answer rows keep their own readable backgrounds. Live Control first reveals the question type, then the host can reveal the question and each multiple-choice option one at a time. The audience sees option letters before their text, and each option's text appears in its choice row when revealed. For rapid fire, the overlay shows only the current prompt as the main question, with numbered circles below it: green for correct, red for incorrect, and amber for passed. The host advances prompts from Live Control; accepted answers appear only after the host reveals the answer. The host can also confirm the contestant's spoken option, then separately reveal the answer. Reopening the question clears staged reveals and the confirmed choice. Overlay content is anchored near the bottom of the Browser Source to leave the upper area clear for the live broadcast; the event and round labels appear beneath the question and answers. Recommended OBS Browser Source settings are 1920×1080 for a Full HD canvas or 1280×720 for an HD canvas. A configured background image is served from the local application asset route.

On the admin **Events** page, select an event to see its event-specific URLs for the main, question, timer, leaderboard, round, and announcement overlays. Click **Copy** beside the desired URL, then paste it into an OBS Browser Source; there is no need to replace an event ID manually. Open the **OBS Overlays** page to select a layout, adjust colors, opacity, typography, countdown style, spacing, branding, lower-third text, and local image assets. Settings are stored in the event's existing `settings_json`; assets are validated and stored below the application media directory. The preview uses the same live WebSocket state as OBS.

If an overlay stops updating, confirm that the Fastify server is running on port 3001, that the Browser Source URL uses the same host as the web app, and that the browser can reach `/ws`. The overlay reconnects automatically every two seconds after a temporary WebSocket disconnect.
# mzp-quiz
