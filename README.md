# Cutroom

A browser-based video editor built with Next.js, Hono, Bun, and Remotion. Ask Codex for a rough cut, play the proposed changes, restore individual passages, and share a saved revision as a private MP4. The timeline, edit history and undo survive reopening the project.

## Run locally

Use Bun 1.3.3, Node 22.19.0, Docker Compose, and FFmpeg 6 or later (including ffprobe). Use Neon for Postgres. Docker Compose starts Redis and the Mailpit inbox on loopback.

```sh
bun install --frozen-lockfile
docker compose up -d --wait
cp -n apps/api/.env.example apps/api/.env.local
openssl rand -hex 32
```

Paste the generated value into `BETTER_AUTH_SECRET` in `apps/api/.env.local`. Set `DATABASE_URL` to the pooled Neon application-role URL in that file. Put the direct Neon owner URL in `apps/api/.env.migrations.local` as `MIGRATION_DATABASE_URL`. Both files are ignored by Git.

```sh
bun run db:migrate
bun run dev
```

In a second terminal, run `bun run worker`. Keep it running for uploads, previews and exports.

Open [My projects](http://127.0.0.1:3000/projects), create an account, and follow the verification link in [Mailpit](http://127.0.0.1:8025). Choose **New project**, enter a title, and pick a horizontal, vertical, or square canvas. Your empty timeline is saved immediately. Sign-out and password reset are available from the workspace and sign-in screens.

The [public sample](http://127.0.0.1:3000) plays and exports a fixed ten-second sequence. Its first export downloads Remotion’s matching headless Chrome. Footage and fonts are bundled.

## How it fits together

| Folder | Responsibility |
| --- | --- |
| `apps/web` | Account screens, project dashboard and canvas, and the public preview. |
| `apps/api` | Hono serves accounts and project data. Drizzle schema and SQL migrations live here. |
| `apps/runner` | Private loopback service that starts a pinned Codex app-server and restricts the model to the editor’s ten project-scoped MCP tools. |
| `apps/worker` | Renders the Remotion composition, transcribes source audio with whisper.cpp, and samples source video into timestamped contact sheets. |
| `packages/timeline` | The sequence as data, including dimensions, frame rate, clip placement, and title timing. |
| `packages/composition` | The Remotion component and local font used by both the browser and worker. |
| `tests` | Playwright checks account recovery, access between two owners, the live export, frames, and audio. |

Next.js forwards `/api` to Hono on port 4000 in development and in the production build. Both services bind to loopback. Hono reads the verified session for each private request and includes the owner ID in the database query.

| Route | Purpose |
| --- | --- |
| `/api/auth/*` | Standard Better Auth routes for verification, sign-in, sign-out, sessions, and password reset. |
| `GET /api/projects` and `POST /api/projects` | List the current owner’s projects or create an empty one. |
| `GET /api/projects/:id` | Read one saved timeline. Another owner’s ID returns 404. |
| `POST /api/projects/:id/edits` | Save a group of timeline edits, undo, or redo against an expected revision. |
| `GET /api/projects/:id/events` | Subscribe to saved revisions in the owner's open editor. |
| `POST /api/projects/:id/assets` | Reserve a private upload and receive its destination and signed form fields. |
| `POST` or `DELETE /api/projects/:id/assets/:assetId` | Verify and attach uploaded media, or cancel an unfinished upload. |
| `GET /api/projects/:id/assets/:assetId/:kind` | Serve the owner's original, playback copy, or thumbnail. |
| `/api/projects/:id/rough-cuts` | List reviews or prepare a candidate. Read one review and use its `commit`, `restore` and `undo` actions. |
| `POST` or `GET /api/projects/:id/export` | Queue a saved revision or download a completed revision. |
| `/api/projects/:id/exports` | Browse export history. Each version exposes its attempts, edit history, file, retry, cancel and share controls. |
| `/watch/:token` | Play one completed export. The page and its media requests check the current link authorization. |
| `POST /api/export` and `GET /api/export` | Render the public sample and download the completed MP4. |

### Background jobs

Hono records private edit or media state in Neon and adds the job ID to BullMQ. Redis listens on `127.0.0.1:6379` by default. The worker takes the job, fetches its inputs, and saves the result. New workers also recover pending requests from Neon if dispatch was interrupted.

Keep Redis on a private interface with append-only persistence and the `noeviction` policy. The included Compose service sets both. Give the API and worker the same `REDIS_URL` and `REDIS_PREFIX`. Use a different prefix for each environment. Keep the worker’s release bundles on persistent storage for retries. When using filesystem media storage, the API and worker need the same media and render directories.

## Commands

| Command | Result |
| --- | --- |
| `bun run dev` | Start Next.js, Hono and the private Codex runner. |
| `bun run --cwd apps/web dev` or `bun run --cwd apps/api dev` | Start either development process on its own. |
| `bun run worker` | Start the BullMQ media worker. It uses the same Neon database and Redis queue as Hono. |
| `bun run render` | Run the worker once and write the MP4 under `.renders/`. |
| `bun run typecheck` | Check the apps, shared packages, and tests. |
| `bun run build` followed by `bun run start` | Run the production Next.js build with Hono. |
| `bun run db:generate --name change_name` | Generate a SQL migration after changing the Drizzle schema. Review and commit the SQL and snapshots. |
| `bun run db:migrate` | Apply pending migrations using the supplied `MIGRATION_DATABASE_URL`. |
| `bun run test:migrations` | Reopen a saved project across schema versions in a disposable Neon test database. |
| `bun run test:timeline` | Check frame boundaries, linked clips, ripple edits, and inverse changes. |
| `bunx playwright install chromium` then `bun run test` | Run the browser suite with Redis and Mailpit running. Provide the Neon test connections in the ignored root `.env.e2e.local` using `E2E_DATABASE_URL` and `E2E_MIGRATION_DATABASE_URL`. The suite starts its own API, web, runner and worker. |
| `E2E_PRODUCTION=1 bun run test` | Run the same suite on this machine against the production build and Neon test database. GitHub Actions runs the checks that do not require Neon credentials. |

To use an existing installation of Google Chrome for the test, set `TEST_BROWSER_CHANNEL=chrome`. To supply a worker browser on a machine with restricted downloads, set `REMOTION_BROWSER_EXECUTABLE` to its executable. If you change Hono’s port, set `API_PORT` for Hono and `API_ORIGIN` for Next.js before development startup or production build.

See the [timeline guide](docs/timeline.md), [release verification and operating limits](docs/release-verification.md), and [implementation plan](docs/implementation-plan.md).

## Hosted configuration

### Private media

Local development uses `CUTROOM_MEDIA_STORAGE=local` and stores files under `.local/media` outside the web root. `CUTROOM_MEDIA_DIR` can point to another private directory. The API host needs `ffmpeg` and `ffprobe` on its PATH, with H.264 and AAC encoding support.

For hosted uploads, set `CUTROOM_MEDIA_STORAGE=imagekit`, `IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_PRIVATE_KEY`, and `IMAGEKIT_URL_ENDPOINT` on the API and media worker. Use an ImageKit key with access to upload, read, list, and remove files in the project's media folder. The browser receives a ten-minute grant bound to a server-selected path, file size, and privacy settings. The worker verifies the uploaded file ID and path, decodes the original, and stores a seekable playback copy and a thumbnail. Owner-authorized delivery links expire after five minutes. The original is retained byte-for-byte for export. Configure the account to restrict unsigned media delivery. [ImageKit private media settings](https://imagekit.io/docs/media-delivery-basic-security)

Uploads support MP4, MOV, WebM, M4A, MP3, WAV, and Ogg, up to 64 MiB and one hour per asset. The provider's account limits also apply. Clips can use ready footage while source analysis runs. The worker checks for abandoned uploads on startup and through a recurring BullMQ job. Unfinished uploads expire after 24 hours.

The local browser suite tests a rotated MOV with real video decoding and byte-range reads. To verify a configured ImageKit account, run the following browser checks. They upload test footage, compare the downloaded original byte-for-byte, recover an interrupted edit, reopen the project in a mobile browser context, and render a private MP4.

```sh
E2E_LIVE_IMAGEKIT=1 bun --env-file=apps/api/.env.local run test tests/imagekit-live.spec.ts tests/media-workspace.spec.ts tests/project-export.spec.ts
```

### Inspect and search footage

Install the pinned English speech model and native recognizer on the media worker host. The installer needs CMake and a C++ compiler. It verifies the model and source checksums and keeps the build outside Git. The worker guide records the versions, fixture and timing benchmark. [Worker setup and benchmark](apps/worker/README.md)

```sh
bun run --cwd apps/worker setup:whisper
```

1. Open **Media library**, upload a recording and choose **Inspect**. Scrub the source player or inspect the timestamped contact sheet. Audio-only recordings have a player and transcript. Silent video still gets a contact sheet.
2. Choose **Import subtitles** for SRT or WebVTT. Select a word to seek to it, play the source and correct its text or timing. The version selector lets you compare the original machine transcript, the imported words and your current corrections. An imported cue provides estimated word times until you review both boundaries.
3. Search by phrase or source time. Each match shows its source interval and a button for each surviving use in the saved timeline. Select a button to seek and select that clip. Transcript changes are saved separately from timeline edits and Undo.
4. Ask Codex “Where does the speaker say ‘your country’? Show me every use in the edit.” It can search project footage and request a labelled source contact sheet or a frame rendered from a saved edit. Original recordings stay in private media storage. Requested passages and stills can reach the model. Operational logs omit prompts, passages and private URLs.

Analysis results are keyed by project, original asset, model and settings. Results survive restarts. A retry resumes missing parts, and word corrections survive retries or a model change. Previously uploaded media and the bundled sample start analysis on first inspection or search.

### Edit a title with Codex

1. Copy `apps/runner/.env.example` to `apps/runner/.env.local`. Put your OpenAI API key there. Generate a fresh secret with `openssl rand -hex 32` and set the same `CUTROOM_RUNNER_SECRET` in the API and runner env files. Keep both files private.
2. Run the database migration and `bun run dev` from the repository root. If the shell already exports a different OpenAI key, use `env -u OPENAI_API_KEY bun run dev` to select the key in the runner's local file. The editor, Hono API, and private runner use loopback ports 3000, 4000, and 4200. Only the runner needs the model credential.
3. Add a title clip and select it. In **Ask Codex**, enter “Change this to Behind the scenes.” The conversation captures the clip, playhead, range, tab, and saved revision. The assistant can inspect a rendered frame at that revision. **Undo** restores the original title after refresh.
4. Use **Stop Codex** to interrupt a turn. Any edit already committed appears in the conversation with its revision. Reloading the same editor tab reattaches to the turn. Completed requests in that tab supply context for follow-ups.
5. To connect a separate Codex client, open **Connect Codex**, create a project key, and copy it into the client's `CUTROOM_MCP_KEY` environment variable. Run the displayed `codex mcp add` command. Ask the client to read the project, then identify the title by clip ID. **Revoke project key** ends access on its next call. Keys expire in 30 days.

External MCP clients can use `place_media` to insert project library assets together. Read the saved revision with `read_project` and source IDs with `list_assets`. For a narrated ending, place video and speech at the same start frame on their respective tracks. Both insertions share one undo step. Use `start_export` with the revision returned by the edit.

Hono enforces daily per-owner allowances before starting a turn or a private render. Configure `CUTROOM_DAILY_TURNS` and `CUTROOM_DAILY_RENDERS` in the API. Repeating the same turn ID or polling a saved frame does not use another allowance. The private frame queue renders the common Remotion composition and returns the image, timestamp, and committed revision over MCP.

The regular browser suite runs the pinned Codex binary with a local model fixture and checks actual image delivery. To repeat the accepted edit against OpenAI, run the optional live tests with your runner credential:

```sh
env -u OPENAI_API_KEY E2E_LIVE_CODEX=1 bun --env-file=apps/runner/.env.local run test tests/codex-editor.spec.ts -g 'Codex edits|external Codex'
```

### Rough cut to shared MP4

1. Insert the interview on the timeline. In the media library, open **Inspect** to check the recognised words and correct any important boundaries. Imported subtitles have estimated timing until reviewed.
2. Select the clip or timeline range. Ask Codex, “Tighten long pauses, keep both takes of ‘thank you’, and add highlighted captions near the bottom. Show me a preview.” You can also open **Rough cuts** to choose the range, pause threshold, breathing room, repeated-take preference, and caption appearance yourself.
3. Play the before and after excerpts. A preview stays separate from the saved timeline until committed. A conflicting edit requires review of a recalculated candidate. Committing applies the cuts and captions in one undoable edit.
4. Reopen the review to **Restore this passage** with its words and caption timing. Use **Undo this edit** when that group is the newest applied edit. The timeline’s ordinary undo and redo also work after refresh.
5. Choose **Export MP4** after saving. You can keep editing during the render. Open **Exports** to inspect progress, cancel, retry a failed attempt, download the file, or see the edits through that version. Codex can request an export with `start_export` and follow it with `export_status`.
6. **Create watch link** lets a viewer play just that version. **Revoke watch link** blocks subsequent playback and seek requests. A loopback watch link works on the same computer. Sending links to other devices requires an accessible host.

### Database and authentication

The project uses separate Neon staging and production branches. Apply each migration to staging, verify it, then apply it to production. For each branch, give the migration job the direct `cutroom_owner` URL as `MIGRATION_DATABASE_URL`. Give the API and media worker the pooled `cutroom_app` URL as `DATABASE_URL`. The application role has table read/write access in `public`.

Set the following separately in each hosted API's secret store. Use that environment’s HTTPS origin for `BETTER_AUTH_URL`, an independent random `BETTER_AUTH_SECRET`, a transactional provider's SMTP connection URL as `SMTP_URL`, and its verified sender as `MAIL_FROM`. Hosted mail uses TLS. Point Next.js's private `API_ORIGIN` at Hono when building and running the web service. Terminate HTTPS at the web ingress and have it supply the trusted client IP for per-client authentication rate limits.
