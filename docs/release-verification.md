# Verify a local release

Cutroom runs on loopback. The release walkthrough uses a production Next.js build, the Hono API, the private Codex runner, native Whisper and the Remotion worker. Mailpit receives test mail. Postgres runs on Neon. BullMQ uses local Redis. The live staging checks also use ImageKit and OpenAI.

## Checks to repeat

Start Docker Compose and install the recognizer as described in the README. Run these commands from the repository root.

```sh
bun run typecheck
bun run test:timeline
bun run test:migrations
bun test apps/api/test/local-range.test.ts apps/api/test/queue.test.ts
CUTROOM_TEST_WHISPER=1 bun test apps/worker/test apps/runner/test packages/composition/test
E2E_PRODUCTION=1 CUTROOM_TEST_WHISPER=1 bun run test
```

Run the production Chromium suite on the machine holding the Neon test credentials. It uses an isolated Neon database, local Redis and a deterministic Responses fixture. The pinned Codex CLI connects to the actual MCP server. GitHub Actions runs the checks that do not require database credentials. Live runs disable traces because the browser handles private media URLs and credentials.

| What to check | Evidence |
| --- | --- |
| Accounts and editing | Verify email, reset a password, sign out, try a second account, lose a save response, edit from two tabs, reload, and undo. The browser tests assert database revisions, keyboard operations and decoded footage. |
| Editorial decisions | A fixture repeats two excerpts of Apollo 8 speech with a deliberate 1.4-second gap. The expected edit removes a redundant take and keeps both instances of “you got a color film jim”. Human-reviewed boundaries provide a stable reference. Native recognition has its own real-speech test. |
| Agent review | Both editor chat and an external Codex client inspect two candidate images, commit one group and check a saved frame. The creator can audition a repeated take, a pause and a caption, restore a passage, move a caption and find the exported revision after reopening. |
| Output parity | Decode the encoded MP4 and compare picture, glyph colours and placement. Check real audio and timed cues. Exercise rotated phone footage, silent and audio-only input, source trims and variable input timestamps. |
| Recovery and access | Retry the same export, cancel, interrupt a leased job, fail publication, remove an original, and retry against its original revision. A signed-out mobile Chromium context seeks approved media, then loses access on revocation. |
| Database compatibility | Migrate a fresh database and an older schema. Also restore a pre-upgrade staging dump into an isolated database, migrate it, and open and render a saved legacy project through the browser. |

### Live integration

Supply the selected Neon branch’s direct owner connection as `E2E_MIGRATION_DATABASE_URL` and pooled application-role connection as `E2E_DATABASE_URL` in a private environment. Select only the two release walkthroughs when targeting a shared staging database. They create synthetic private projects and may incur provider charges. The migration process uses the owner role. The API and media worker use the application role.

```sh
env -u OPENAI_API_KEY E2E_RELEASE_TARGET=staging E2E_RELEASE_METRICS=1 \
  E2E_PRODUCTION=1 E2E_LIVE_CODEX=1 E2E_LIVE_IMAGEKIT=1 CUTROOM_TEST_WHISPER=1 \
  bun --env-file=apps/api/.env.local --env-file=apps/runner/.env.local \
  run test tests/rough-cut-editor.spec.ts --workers=1
```

The separate ImageKit check in `tests/export-history.spec.ts` renders two caption revisions. It plays and seeks both through the mobile watch page, verifies their caption colours and audio, revokes each link, expires only those synthetic versions, and waits for retention cleanup. For a local-only release, run the native processes on the workstation throughout these checks.

### Restore and roll back

1. Before upgrading, take a custom-format `pg_dump` of the staging database with the migration role. Keep it outside Git with owner-only permissions. Back up media separately. The database refers to originals and finished MP4s by identity.
2. Restore into a fresh Neon database with the app roles prepared. On a matching server use `pg_restore --no-owner --no-acl --single-transaction`, then grant the normal runtime role access. For this rehearsal, stock PostgreSQL 16 did not recognise Neon's column option `pg_attver`. We restored the SQL in one transaction after omitting only those column-storage directives. All table definitions, data, constraints and indexes remained in the restore.
3. Check the migration ledger and the older project before upgrading. Run pending migrations on the restored copy. The rehearsal reopened a format-1 project at revision 0 and decoded a 640 × 360, one-second MP4 containing its original clip and title. Repeat that browser check with `E2E_RESTORE=1` and `E2E_PRODUCTION=1` using the two E2E connection URLs for a disposable Neon restore. The synthetic fixture account and Mailpit inbox belong only to this rehearsal.
4. Apply compatible schema updates before restarting services. Keep the previous Git revision, its lockfile, private originals and the `releases` directory under `CUTROOM_RENDER_DIR`. Every new export pins its composition, font and source versions. For a worker-engine change, drain outstanding jobs before switching engines, or retain the previous worker and its bundle for retry.
5. For rollback, stop new writes, preserve a fresh backup, then start the prior version against a restored copy and verify an old project. The previous release predates rough-cut operations and export jobs. Keep the newer database and worker available for those projects and pending exports. Switching the web process alone does not reverse committed edits or migrations.

## Staging rehearsal on 27 November 2026

The release ran on an Apple M4 with 16 GiB RAM, Bun 1.3.3, Node 22.19.0 and FFmpeg 8.0.1. The input was an 8.8-second, 320 × 180 H.264/AAC recording of 255,649 bytes. The export used a 1280 × 720 canvas at 30 fps. Neon provided staging Postgres, ImageKit stored private media, and the native worker ran on the workstation.

| In-editor walkthrough | Observed time |
| --- | ---: |
| Choose file to playable footage | 7.35 s |
| Choose file to original native transcript | 8.46 s |
| Send prompt to the model receiving the first candidate image | 16.44 s |
| Send prompt to the grouped edit being saved | 29.33 s |
| Request an uncached committed frame to receive its image | 5.13 s |
| Request export to show download | 12.46 s |
| First observed queued status to active render | 0.74 s |
| First observed active render to completed upload | 9.71 s |

These are individual observations for this fixture. Browser polling samples queue transitions. Run the same walkthrough on the intended hardware before changing concurrency. These measurements predate the BullMQ worker. With native speech and rendering on this workstation, transcription and encoding incur no per-minute vendor charge. ImageKit transfer, Neon usage and host costs depend on the account.

The successful in-editor turn made nine GPT-5.5 Responses requests. OpenAI reported 38,020 input tokens, including 25,728 cached, and 627 output tokens. At the published standard rates of $5 per million uncached input tokens, $0.50 per million cached input tokens and $30 per million output tokens, the estimated model cost was **$0.093 for this edit**. Reasoning tokens are included in the output count. This estimate excludes other test runs and infrastructure. [OpenAI GPT-5.5 pricing](https://developers.openai.com/api/docs/models/gpt-5.5)

## Operating limits and retention

| Resource | Behaviour for this release |
| --- | --- |
| Source and timeline | Uploads are capped at 64 MiB and one hour per asset. A timeline can contain up to five minutes. Speech recognition runs on the CPU with the pinned English model. Estimated word boundaries do not trigger automatic precision cuts. |
| Compute | Each BullMQ worker can process two media jobs concurrently. The database admits up to 32 queued or active export attempts. The runner accepts eight concurrent turns. Per-owner daily defaults are 30 editor turns and 100 private renders. External Codex clients use their own inference credentials. |
| Recovery | A 45-second export lease is renewed every four seconds. A new worker can claim an expired job. Interrupted attempts retain their own terminal state. An explicit retry uses the frozen version and starts a fresh attempt. |
| Original footage and derived media | Retain attached originals, playback copies, thumbnails, analysis and corrected transcripts for the lifetime of the project. Unfinished uploads expire after 24 hours. The API sweeps them at startup and every 15 minutes. |
| Project history and chat | The database retains review context, edit history and conversations with the project. For an operator-assisted erasure, first revoke watch links, stop active jobs and remove the project's exported objects and version holds. Remove its source media and derived files, then delete the project rows and verify the project, private originals and watch URLs are inaccessible. Retain backups only for the operator's agreed recovery window. |
| Finished exports | Each new export expires after 30 days. A retry renews that period. The worker deletes expired files and releases source holds. Watch authorization is rechecked for every new request. Downloaded bytes or a viewer's existing buffer remain with that viewer. Legacy downloads created before export history remain owner-only on the original host. |
| Diagnostics | Follow project ID and revision into `project_edit`, `rough_cut_review`, `codex_run`, `export_version` and `export_attempt`. Check terminal errors and expired leases before retrying. The optional release measurements log only numeric timings and token categories. Keep prompts, transcript text, private media URLs and credentials out of operational logs. |
