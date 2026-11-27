# Cutroom

A browser-based video editor built with Next.js, Hono, Bun, and Remotion. Edit footage, audio, titles, and captions on a private timeline. Every saved change can be undone or redone across sessions. The public Apollo 8 sample also supports MP4 export.

## Run locally

Use Bun 1.3.3, Node 22.19.0, Docker Compose, and FFmpeg 6 or later (including ffprobe). On first setup, start PostgreSQL and the local mail inbox from the repository root.

```sh
bun install --frozen-lockfile
docker compose up -d --wait
cp -n apps/api/.env.example apps/api/.env.local
openssl rand -hex 32
```

Paste the generated value into `BETTER_AUTH_SECRET` in `apps/api/.env.local`. Then migrate the development database and start the app.

```sh
MIGRATION_DATABASE_URL=postgresql://cutroom_owner:local-owner@127.0.0.1:55432/cutroom bun run db:migrate
bun run dev
```

Open [My projects](http://127.0.0.1:3000/projects), create an account, and follow the verification link in [Mailpit](http://127.0.0.1:8025). Choose **New project**, enter a title, and pick a horizontal, vertical, or square canvas. Your empty timeline is saved immediately. Sign-out and password reset are available from the workspace and sign-in screens.

The [public sample](http://127.0.0.1:3000) plays and exports a fixed ten-second sequence. Its first export downloads Remotion’s matching headless Chrome. Footage and fonts are bundled.

## How it fits together

| Folder | Responsibility |
| --- | --- |
| `apps/web` | Account screens, project dashboard and canvas, and the public preview. |
| `apps/api` | Hono serves accounts and project data. Drizzle schema and SQL migrations live here. |
| `apps/worker` | Node process that bundles the composition and renders H.264 video with AAC audio. |
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
| `POST` or `GET /api/projects/:id/export` | Render a saved revision or download its completed MP4. |
| `POST /api/export` and `GET /api/export` | Render the public sample and download the completed MP4. |

## Commands

| Command | Result |
| --- | --- |
| `bun run dev` | Start Next.js and Hono together. |
| `bun run --cwd apps/web dev` or `bun run --cwd apps/api dev` | Start either development process on its own. |
| `bun run render` | Run the worker once and write the MP4 under `.renders/`. |
| `bun run typecheck` | Check the apps, shared packages, and tests. |
| `bun run build` followed by `bun run start` | Run the production Next.js build with Hono. |
| `bun run db:generate --name change_name` | Generate a SQL migration after changing the Drizzle schema. Review and commit the SQL and snapshots. |
| `bun run db:migrate` | Apply pending migrations using the supplied `MIGRATION_DATABASE_URL`. |
| `bun run test:migrations` | Reopen a saved project across schema versions in a disposable local database. |
| `bun run test:timeline` | Check frame boundaries, linked clips, ripple edits, and inverse changes. |
| `bunx playwright install chromium` then `bun run test` | Run the browser suite with Compose running. It starts isolated servers on ports 3100 and 4100, migrates `cutroom_test`, and writes exports to `.renders/test`. |
| `E2E_PRODUCTION=1 bun run test` | Run the same suite against a production build. GitHub Actions runs this and the migration check on pushes and pull requests. |

To use an existing installation of Google Chrome for the test, set `TEST_BROWSER_CHANNEL=chrome`. To supply a worker browser on a machine with restricted downloads, set `REMOTION_BROWSER_EXECUTABLE` to its executable. If you change Hono’s port, set `API_PORT` for Hono and `API_ORIGIN` for Next.js before development startup or production build.

The [timeline guide](docs/timeline.md) covers editing controls, frame rules, saving, and verification. See the [Phase 1 verification notes](docs/first-render.md) for the public sample and the [implementation plan](docs/implementation-plan.md) for later editing and agent milestones.

## Hosted configuration

### Private media

Local development uses `CUTROOM_MEDIA_STORAGE=local` and stores files under `.local/media` outside the web root. `CUTROOM_MEDIA_DIR` can point to another private directory. The API host needs `ffmpeg` and `ffprobe` on its PATH, with H.264 and AAC encoding support.

For hosted uploads, set `CUTROOM_MEDIA_STORAGE=imagekit`, `IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_PRIVATE_KEY`, and `IMAGEKIT_URL_ENDPOINT` on the API server. Use an ImageKit key with access to upload, read, list, and remove files in the project's media folder. The browser receives a ten-minute grant bound to a server-selected path, file size, and privacy settings. Hono verifies the uploaded file ID and path, decodes the original, and stores a seekable playback copy and a thumbnail. Owner-authorized delivery links expire after five minutes. The original is retained byte-for-byte for export. Configure the account to restrict unsigned media delivery. [ImageKit private media settings](https://imagekit.io/docs/media-delivery-basic-security)

Uploads support MP4, MOV, WebM, M4A, MP3, WAV, and Ogg, up to 64 MiB and one hour per asset. The provider's account limits also apply. Clips can use ready footage immediately. Transcript status records whether the file has audio suitable for later transcription. The API checks for abandoned uploads at startup and every fifteen minutes. Unfinished uploads expire after 24 hours.

The local browser suite tests a rotated MOV with real video decoding and byte-range reads. With ImageKit credentials configured, run `E2E_LIVE_IMAGEKIT=1 bun --env-file=apps/api/.env.local run test tests/imagekit-live.spec.ts` to upload a short synthetic portrait recording and verify its original, private thumbnail, and playback.

### Database and authentication

The project uses separate Neon staging and production branches. Apply each migration to staging, verify it, then apply it to production. For each branch, give the migration job the direct `cutroom_owner` URL as `MIGRATION_DATABASE_URL`. Give the API the pooled `cutroom_app` URL as `DATABASE_URL`. The application role has table read/write access in `public`.

Set the following separately in each hosted API's secret store. Use that environment’s HTTPS origin for `BETTER_AUTH_URL`, an independent random `BETTER_AUTH_SECRET`, a transactional provider's SMTP connection URL as `SMTP_URL`, and its verified sender as `MAIL_FROM`. Hosted mail uses TLS. Point Next.js's private `API_ORIGIN` at Hono when building and running the web service. Terminate HTTPS at the web ingress and have it supply the trusted client IP for per-client authentication rate limits.
