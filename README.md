# Kairo

Kairo is a self-hosted calendar workspace for ordinary Google events, Todoist tasks, and ICS events you may or may not attend. It runs with TanStack Start, SQLite storage, and a background sync worker.

## Start locally

Requires Node 24 and pnpm 10. Copy `.env.example` to `.env`, then set `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` to separate random values of at least 32 characters. Put your Google OAuth web client ID and secret in `.env`, or point `GOOGLE_OAUTH_CLIENT_FILE` at its JSON file. Set `TODOIST_CLIENT_ID` and `TODOIST_CLIENT_SECRET` from your Todoist app.

```sh
pnpm install
pnpm dev
```

In another terminal, run `pnpm worker` for background sync. Open `http://localhost:3000`, create the first owner account, then connect Google Calendar from the sidebar. Registration closes after that account exists. `pnpm dev` applies migrations before starting Vite.

## Docker

```sh
docker compose up -d
```

This pulls the image CI publishes to `ghcr.io/the-snesler/kairo:latest` on every push to `main`. To build locally instead, swap `image:` for the commented `build: .` lines in `compose.yaml` and run `docker compose up --build -d`.

The app and worker share the database in the `kairo-data` volume. Set `BETTER_AUTH_URL` to the exact HTTPS URL used in your browser when deploying behind a reverse proxy. Forward requests and response headers, including cookies and `Origin`, to port 3000. Serve HTTPS at the proxy; do not put this app directly on a public HTTP origin. Keep the encryption key and SQLite backup together; credentials cannot be decrypted without that key.

The JSON client file is ignored by Git and Docker. For Docker, put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`, or mount your JSON file into the container and set `GOOGLE_OAUTH_CLIENT_FILE` to that in-container path.

## OAuth configuration

Create a Google OAuth **Web application** credential. Add the exact redirect URI `https://YOUR_HOST/api/google/callback` (or `http://localhost:3000/api/google/callback` for local development). The app requests Google Calendar access and offline refresh. A Google OAuth app left in external **Testing** status can issue refresh tokens that expire after seven days; publish or configure the consent screen appropriately for long-running sync. Kairo stores access/refresh tokens encrypted in SQLite using `ENCRYPTION_KEY`.

Create a Todoist app and register the exact redirect URI `https://YOUR_HOST/api/todoist/callback` (or `http://localhost:3000/api/todoist/callback` locally). Set its client ID and secret in `.env`, then use **Connect Todoist** in Settings. Kairo requests `data:read`, encrypts access and refresh tokens in SQLite, rotates refresh tokens during background sync, and asks for reconnection if authorization expires. Reconnecting the same Todoist account reuses its task connection, tasks, and scheduled blocks. Connecting a different account over existing tasks is rejected to protect those mappings. The task due date stays separate from reserved work time. Drag a task onto the calendar to create a Google-backed work block. Task completion/write access is not included in this release.

## Using Maybe

Add an ICS feed in the sidebar. Undecided events appear with a dashed outline. Open one and choose **Yes**, **Maybe**, **No**, or **Undecided**. Yes and Maybe create one Google copy on the chosen default or Maybe calendar; No hides it unless **Show declined** is on. Configure calendar roles in Settings. The decision and projection mapping live in SQLite, so retries and restarts do not create duplicate copies. Removing a feed stops polling and hides its source events while retaining decisions and existing Google copies. Direct Google edits and deletions of app-managed projections appear in Settings for an explicit choice: restore from the feed, keep the Google edit as an independent event, or remove the decision and its Google copy.

Timed tasks are mirrored to the **Tasks** calendar selected in Settings. Tasks use the **Default** calendar unless you choose a separate writable calendar. Changing the Tasks calendar moves existing task mirrors; click its selected Tasks role to return to Default.

## AI duration estimates

Tasks without a Kairo override or a Todoist duration can get an AI estimate; otherwise they default to 30 minutes. This is off by default. Set `GEMINI_API_KEY` to opt in; `AI_PROVIDER` (default `gemini`) and `AI_MODEL` (default `gemini-3.5-flash-lite`) are optional. When enabled, the worker sends open task titles, descriptions, and project names to the provider shortly after startup and then hourly. Estimates are stored in `task_estimate` and refreshed when the task text changes or after 14 days.

## Data and recovery

Kairo keeps Google sync cursors, feed revisions, decisions, projection IDs, tasks, and work blocks in SQLite. The worker polls every five minutes; **Sync now** triggers the same logic. Connection and feed errors appear in the app. Revoked Google or Todoist authorization marks the connection for reconnection. An expired Google sync cursor triggers a full calendar sync. Failed or partial ICS downloads do not withdraw prior events.

For a consistent backup while Kairo is running, use SQLite's online backup command and save the encryption key separately:

```sh
docker compose exec kairo pnpm --filter @kairo/db exec node -e 'const D=require("better-sqlite3");new D(process.env.DATABASE_URL).backup("/app/data/kairo-backup.db")'
docker compose cp kairo:/app/data/kairo-backup.db ./kairo-backup.db
```

To restore, stop the container, replace the database in the volume with a verified backup, keep the same `ENCRYPTION_KEY`, and restart. Do not copy a running `.db` file without its WAL state. For local development, the database is `data/kairo.db` by default.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Migrate and run the local app |
| `pnpm build` | Build the production app |
| `pnpm start` | Run the built server |
| `pnpm worker` | Run background sync locally |
| `pnpm db:migrate` | Apply migrations |
| `pnpm typecheck` | Check TypeScript |
| `pnpm test` | Run integration and core tests |

### Current boundaries

The timed grid uses the browser timezone. Recurring Google instances display, but editing a series or individual occurrence is disabled until the requested scope can be applied explicitly. Todoist tasks are read-only; their scheduled blocks are editable. The first owner account is enforced by a database trigger in this single-user release.
