# Build the agent-first video editor

A creator uploads an interview and asks, "Tighten this, keep my last take, and add captions." Codex edits the timeline. The creator listens across each cut, restores a moment they want to keep, and exports the result. Build that workflow first.

| Milestone | Working result |
| --- | --- |
| [First render](#phase-1-render-one-clip-before-building-the-editor) | A ten-second clip looks and sounds the same in the browser and in a downloaded MP4. |
| [First agent demo](#phase-5-make-the-first-real-codex-edit) | Codex changes a selected title in the open editor, sees the rendered frame, and the user can undo the edit after refresh. |
| [First useful release](#phase-9-test-and-release) | A creator can delegate a rough cut, review its timing by ear, correct it, and share a specific export. |
| [Expanded editing](#phase-10-expand-the-editing-vocabulary) | Codex can place B-roll against speech, mix music, cut to beats, and apply selected properties of a reference video. |

Use one account owner per project for the first release. Start with 30 fps, a five-minute edited timeline, and horizontal, vertical, and square canvases. Longer source files can supply several short clips. Treat these as initial product choices and test them with real footage.

## How the pieces connect

| Part | Responsibility |
| --- | --- |
| Next.js | Serve sign-in, the dashboard, the editor, and the public watch page. Run the interactive timeline and Remotion Player in the browser. |
| Hono running on Bun | Own authentication, authorization, uploads, project reads and writes, job requests, and live events. Serve browser requests and the editor's Model Context Protocol (MCP) endpoint under the same origin. |
| Shared TypeScript editing module | Apply operations to a timeline and calculate their inverses and affected ranges. The browser, Hono, and tests use the same editing rules. |
| Neon Postgres and Drizzle | Store the saved timeline, revisions, credentials, edit history, conversations, and job records. Check schema changes into Git as migrations. |
| ImageKit | Store and deliver footage, thumbnails, and finished videos. Keep stable file identifiers in Postgres. Generate private delivery URLs when a browser or worker needs them. |
| Private Codex runner | Use Codex app-server for a persistent in-app conversation, streamed replies, and Stop. Give the runner project-scoped access to the Hono MCP endpoint. |
| Remotion and background workers | Use one composition for the browser preview, Codex's frame checks, and final rendering. Use Trigger.dev for jobs. Run Chrome, FFmpeg, and speech analysis in workers with their required native dependencies. |

**A manual edit** starts in Next.js. The browser previews the change immediately. Hono checks the operation and saves one project revision. Other open editors receive that revision.

**An in-app request** starts in the chat panel. Hono authenticates the user, captures the project and selection, and starts a Codex turn. Codex reads or edits the project through Hono's MCP tools. An external Codex client can call those same tools with its own project key. Chat activity and committed timeline revisions travel as separate events. [Codex app-server](https://developers.openai.com/codex/app-server/) · [Codex MCP](https://developers.openai.com/codex/mcp/)

**An export** starts with a saved revision. Hono records a snapshot and queues a job. The worker reads that snapshot and its assets, renders the video, uploads the result, and records the export. The creator can continue editing during the render.

## Phase 1. Render one clip before building the editor

1. Create a Bun workspace with a Next.js app, a Hono API, a worker, and shared timeline and composition packages. Give each process a local start command. Pin the working runtime, Remotion, and renderer versions.
2. Route requests under `/api` to Hono. Keep the editor and API on the same public origin in development and production. Check that streaming responses reach the browser incrementally.
3. Record or license a ten-second test clip. Include speech, a known pause, and a visible change halfway through. Keep its expected timestamps and a hand-checked transcript with the test fixture.
4. Describe the first timeline as data. Give it one video track, a clip, and a title that appears at second five. Load the same document in Remotion Player and the worker. Package the same fonts for both. [Remotion server rendering](https://www.remotion.dev/docs/ssr)
5. Render an MP4 in the intended worker environment. Record the time to first preview, export duration, and worker memory for this fixture. Reuse that baseline when rendering changes.

**Pass when** an independent player opens the MP4, speech is audible, and frame 149 has no title while frame 150 has the title in both preview and export.

## Phase 2. Set up the database, accounts, and private projects

1. Create separate development, test, staging, and production database environments. Use synthetic media and users in test. Put database URLs, auth secrets, email credentials, ImageKit private keys, and worker credentials in the relevant runtime's secret store.
2. Connect Hono to Postgres through Drizzle. Use a migration credential for schema changes and a separate application credential for normal requests. Generate and review SQL migrations. Apply them to an empty database and a database containing an earlier project before deploying. [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
3. Mount Better Auth in Hono. Create its account, user, session, and verification tables through the migration workflow. Configure trusted origins and secure production cookies. Implement sign-up, email verification, sign-in, sign-out, session expiry, and password reset. Use a local mail catcher in development and a transactional sender in production. [Better Auth with Hono](https://better-auth.com/docs/integrations/hono)
4. Create the dashboard and new-project dialog. Ask for a title and canvas format. Generate an empty timeline and open the editor. On the dashboard, show saved projects, last edit time, and a thumbnail when available.
5. Resolve ownership in Hono on every project-scoped request. Derive the user ID from the verified credential. Check that requested clips, media, jobs, and exports belong to that project. Use the same checks for browser sessions and MCP keys.

Add each group of records when its feature arrives.

| Records | Fields and rules that matter |
| --- | --- |
| Projects | Owner, title, canvas dimensions, fps, timeline JSON, document format version, edit revision, and timestamps. The format version tells the app how to read old projects. The revision detects concurrent edits. |
| Assets and analysis | Project ID, storage ID, source identity, media type, dimensions, duration, rotation, audio presence, processing state, and analysis version. Store timed transcript words and scene references against the original asset. |
| Edits | Project, base and resulting revision, actor, request ID, grouped operations, inverses, source ranges, affected timeline ranges, and summary. Enforce unique project revisions and unique request IDs within a project. |
| Agent sessions and runs | User, project, conversation ID, selection snapshot, base revision, status, tool results, and committed edit ID. Keep enough history to resume the correct conversation after refresh. |
| Credentials and jobs | Store hashes, scope, expiry, and revocation for external MCP keys. Store a job's unique request key, inputs, attempt, state, progress, output, and error. |
| Exports and shares | Store the immutable render snapshot, asset and font versions, worker job ID, result file ID, and completion state. Bind each revocable share token to one completed export. |

Use foreign keys for ownership relationships and indexes for listing a user's projects, reading revisions in order, and finding active jobs. Keep large media files in media storage. Keep the project timeline and edit history in Postgres.

**Pass when** two test accounts can create and reopen their own projects. Copying a project URL into the other account denies access. A reset link works once, sign-out invalidates the session, and a database migration preserves an existing project.

## Phase 3. Build the editing rules, saving, and undo

1. Separate an **asset** from a **clip**. An asset is the original file. A clip references a piece of it. Give each clip a stable ID, track, source start, timeline start, and duration. A title clip carries text and styling instead of a source file.
2. Use whole frames for timeline positions. Let the start frame belong to the clip and the end frame belong to the next clip. Document track order, legal overlaps, source bounds, and minimum clip length. Keep transcript time relative to the original file.
3. Implement add, move, trim either edge, split, delete, edit text, reposition, and change volume. Add a ripple delete that closes a gap on the designated tracks. Keep linked speech, picture, and captions together. Preserve music anchored to the project unless the request includes it. Reject edits that would move a locked track.
4. Give every caller one way to submit an edit. Send the project, expected revision, unique request ID, and operation group. Validate the complete group. Save the resulting document, history entry, and revision together. On an identical retry, return the saved result. Reject reuse of the same request ID with different operations. On a conflicting revision, return the current revision so the caller can reload.
5. Persist inverse operations for the entire group. Start with chronological undo and redo. A new edit after an undo clears the redo branch. Restoring one suggested cut later creates a new edit against the current timeline.
6. Publish committed revisions over Server-Sent Events. Use the saved revision history to replay missed changes or reload the snapshot. Start with one Hono instance. Add shared event delivery before running multiple instances. Have every reconnect compare its last revision with Postgres.

**Pass when** a clip placed at timeline second 5 with source start 12 splits at timeline second 7 into pieces starting at source seconds 12 and 14. A duplicate request creates one split. Two tabs cannot silently overwrite each other. Undo, refresh, and redo reproduce the expected frames.

## Phase 4. Build the editor screen and media library

Design the screen around the moment a creator asks for an edit and then checks it.

| Area | User interaction |
| --- | --- |
| Left panel | Keep the agent conversation visible. Show the targeted project, clip, or time range next to the prompt. Offer requests the available footage supports. Show live activity, Stop, and completed edits. |
| Main preview | Provide play, pause, scrub, frame step, timecode, canvas fit, and caption safe zones. **Play changes** starts just before a cut so the viewer hears the transition. |
| Timeline below the preview | Show video, audio, and caption tracks, clip names, selection, playhead, trim handles, snap, zoom, undo, and redo. Let the user drag clips or select and edit them by keyboard. |
| Media drawer and clip inspector | Show upload progress and transcript readiness per asset. Selecting a clip opens its position, style, and volume controls while the conversation stays visible. |
| Project bar | Show project name, canvas format, save state, history, and export progress. A failed save must identify the unsaved change and offer recovery. |

1. In an empty project, lead with **Add footage**. Hono authorizes an upload. The browser uploads directly to ImageKit. Verify file ID, project ownership, type, and size server-side before marking the asset ready. [ImageKit media security](https://imagekit.io/docs/media-delivery-basic-security)
2. Probe the uploaded file. Save its duration, orientation, dimensions, and audio metadata. Make a thumbnail. Produce a smaller playback copy when the original is expensive to seek. Keep the original available to the render worker.
3. Distinguish upload, playback, and transcript readiness. Let the user arrange playable footage during transcription. Handle upload cancellation, retry, unsupported formats, and uploaded files that never attach to a project.
4. Connect timeline controls to the phase 3 edit interface. Preview each drag locally and commit one edit on release. Preserve selection by clip ID. Show which edits are unsaved while offline and wait for a successful save before export. Offer keyboard focus, accessible control names, and text equivalents for status colours.
5. Make the layout usable on a small screen. Keep preview and playback accessible, use a switchable chat or timeline panel, and preserve the selected target when switching. Prioritize desktop authoring and phone playback for the first release.

**Pass when** a creator can upload a phone video, rotate or fit it correctly, trim it, add a title, and reopen it on another device. Test keyboard-only editing, a failed upload, and a save interrupted by loss of connection.

## Phase 5. Make the first real Codex edit

1. Start a private, long-running Codex runner for the in-app chat. Bind each conversation and run to its authenticated owner and project. Pin the tested app-server version. Keep the OpenAI credential inside the runner. Limit the runner to authorized editor tools and isolate users' workspaces. Let Hono enforce a per-user allowance before starting a model turn or an expensive render.
2. Expose a Streamable HTTP MCP endpoint in Hono. Give the in-app runner a short-lived project credential. For external Codex, add **Connect Codex**, display a revocable project key once, and show the last successful connection.
3. Start with five tools. Read project state, list assets, inspect selection, update a title, and render a frame. Capture the editor tab, selection, playhead, range, and revision when the user sends the request. For an external client, pair to a specific editor session or require explicit IDs.
4. Send edit tools through the same authorization and save logic as manual edits. If the selected clip was deleted or the revision changed, reread the project before editing. Never infer a target from another user's or tab's recent activity.
5. Run the first frame check against the committed revision. Return the timestamp, revision, and a native MCP image attachment. Queue slower frame requests and expose job status so a tool timeout cannot start a second render.
6. Stream user-readable activity into chat. Persist tool outcomes and the final edit receipt. On Stop, interrupt the Codex turn. Discard uncommitted work and show any edit already saved. A disconnected browser can reattach to its run.

**Pass when** the creator selects one title and asks, "Change this to Behind the scenes." The right timeline updates, Codex receives a viewable image, and Undo works after refresh. Repeat from an external Codex client. Revoke its key and confirm that its next tool call fails.

## Phase 6. Teach the editor to understand footage

1. Decode audio in a worker. Start with Whisper.cpp as the proposed transcription engine and benchmark its word timing on the speech fixture. Package the selected model with a recorded version. Give users subtitle import and correction when speech timing is unavailable or inaccurate. [Whisper.cpp](https://github.com/ggml-org/whisper.cpp)
2. Save the original transcript and timing quality. Mark line-level imports with estimated word times. Avoid making automatic fine-grained cuts from coarse timings. Cache analysis by asset identity, model, and settings.
3. Sample timestamped frames into a contact sheet for each source video. Expose it alongside asset metadata. Add transcript lookup by phrase and time range. Return results that identify both the asset and the specific source range.
4. Map source ranges onto every surviving use of an asset. A trimmed introduction may appear nowhere on the timeline. A repeated clip may appear twice. Let Codex request one clip or all uses explicitly.
5. Show what the agent can inspect. Original footage stays in hosted media storage in this web design. Transcripts and requested stills can reach the selected model. Keep private media URLs, raw prompts, and transcript text out of routine operational logs.

**Pass when** searching for a known sentence finds its source time and all corresponding timeline positions after a split. A silent clip becomes usable without a transcript. A retried analysis job produces one result, and Codex can distinguish a source contact sheet from an edited frame.

## Phase 7. Deliver the rough cut, captions, and review

1. Build one high-level rough-cut tool over the edit module. Accept a clip or range, pause threshold, breathing room, and repeated-take preference. Identify gaps between timed words and calculate cuts within the chosen range.
2. Begin with pauses. Add repeated-take detection against exact or normalized phrases next. A repeated slogan and a restarted sentence can look alike in a transcript. Flag uncertain matches for review and keep enough source context to restore a passage.
3. Create the proposed rough cut and captions against one base revision. Caption surviving words in timeline order. Account for splits, trimmed source starts, and reused footage. Offer a readable default and one word-highlight style with font, colour, and placement controls.
4. Render candidate frames around caption changes, crops, and overlays. Give Codex the actual images so it can adjust a caption covering a face. Let it inspect audio timing through the transcript and give the creator playable excerpts for judging cadence.
5. Commit the finished request as one edit group. If another edit landed during analysis, recalculate against the new revision. Keep a failed or stopped draft out of the saved timeline. A post-commit frame check uses the resulting revision.
6. Calculate the receipt from the committed operations. For example, **Removed 8 pauses · saved 14 seconds** opens a list of cuts. Each entry can play before and after. Offer **Restore this passage** and **Undo this edit**. Recalculate linked caption timing when restoring a passage.

**Pass when** Codex tightens the fixture, keeps a deliberate repetition on request, and captions only surviving speech. A creator can listen across the cuts, restore one removed phrase with its captions, and undo the edits in order after reopening the project.

## Phase 8. Export, download, and share the chosen version

1. Finish pending saves before export. Capture the timeline revision, asset versions, font versions, composition version, and export settings. Hold those assets while the export needs them.
2. Record the export and its job request durably. Dispatch it with a stable idempotency key. If dispatch fails after the database save, a retry must pick up the pending request. Expose start and status through both the editor and MCP. [Trigger.dev idempotency](https://trigger.dev/docs/idempotency)
3. Render an H.264 MP4 with audio using the shared composition. Report queued, rendering, uploading, completed, failed, and cancelled states. Handle races between completion and cancellation. Record one final state per attempt.
4. Publish the output only after upload succeeds. Add progress, cancel, retry, download, and export history. Retry transient errors against the original snapshot. Report missing source media with the asset name.
5. Create a revocable link to one completed export. Authorize playback separately from project editing. Start with MP4 playback. Add adaptive streaming when multiple playback qualities are needed. Bound the lifetime of any media URL already issued when a link is revoked.

**Pass when** a creator exports, changes a caption during the render, and exports again. The original MP4 keeps the old caption. The second MP4 has the new one. Both play on a phone. Revoking one watch link prevents new playback authorization for that export.

## Phase 9. Test and release

Run each phase's acceptance check as soon as the feature exists. Keep the following test sets for ongoing changes.

| Test set | Cases and evidence |
| --- | --- |
| Timeline rules | Use fixed inputs for trims, splits, source reuse, linked tracks, locks, caption timing, and ripple edits. Compare exact frames. Verify that applying a group and its inverse restores the original document. |
| Database and HTTP | Run against real Postgres. Test a fresh install, an upgrade, ownership checks, two simultaneous saves, duplicate request IDs, interrupted saves, and durable undo. Check rows and revisions as well as responses. |
| Auth and media access | Use two browser accounts and two external keys. Test sign-out, expiry, password reset, a copied asset ID, a key for another project, revocation, and a public watch link. Verify direct access to an original private file also requires authorization. |
| MCP contract | Use an MCP client to discover tools and invoke them with fixed inputs. Verify scope, stale selection, errors, image content type, and retry behaviour. Keep a short smoke test using a real Codex session for both chat entry points. |
| Browser UX | Use Playwright to cover sign-in, upload, speech readiness, manual trim, chat, Stop, review, Undo, reload, export, and sharing. Exercise keyboard navigation and phone playback. Record the failing step and retain a trace. |
| Media parity | Test portrait phone footage, rotation metadata, variable source frame rates, silent video, audio-only input, missing media, and custom fonts. Compare decoded export frames with preview frames using a tolerance for compression. Check audible sync at known cues. |
| Editorial quality | Keep owned clips with intentional pauses, repeated slogans, false starts, accents, and background music. Record expected cuts and phrases to preserve. Listen to the transitions and read the captions at actual playback size. |
| Worker and run recovery | Interrupt analysis, disconnect chat, stop a candidate edit, restart a render, and fail an output upload. Verify one committed edit or export and a recoverable user-visible state. |
| Performance and cost | Measure upload-to-playback, transcript turnaround, time to first edit, frame-check latency, and render duration on the same fixtures. Record media size, resolution, hardware, and queue time. Set operating limits from staging measurements. |

1. **For each pull request**, run type checks, timeline tests, migration and API integration tests, deterministic MCP tests, and a short browser flow. Use a predictable agent response for ordinary UI tests so model variability does not hide a timeline regression.
2. **In staging**, use isolated credentials, real private media delivery, the deployed worker, and a real Codex run. Exercise the full speech fixture and the failure cases. Set upload, concurrent job, and model-use limits before inviting users.
3. **Before production**, restore a database backup into staging. Verify an older project opens and exports. Deploy compatible schema changes before processes that depend on them. Keep the previous application and composition versions available for rollback and in-flight jobs.
4. **After launch**, trace one request by project revision, agent run, edit group, and job ID. Monitor stuck jobs, render failures, save conflicts, latency, and model and media costs. Define retention and deletion for original footage, transcripts, thumbnails, conversations, and exports.

**Release walkthrough.** Start with a fresh account. Upload an interview. Ask Codex to tighten it and add captions. Play three changed moments. Restore one phrase. Move one caption by hand. Export and open its share link on a phone. Reopen the project and use history to find the exact edits and revision behind that video.

## Phase 10. Expand the editing vocabulary

Ship these independently after the rough-cut workflow works with real footage.

| Order | Add | Acceptance scenario |
| --- | --- | --- |
| 1 | Speech-driven B-roll | "Show the product when I mention the battery" places the selected image or clip over the matching phrase and preserves the speaker's audio. |
| 2 | Music ducking and sound effects | Lower music during speech and restore it smoothly. Listen to preview and export with headphones at the same cut. |
| 3 | Beat detection and beat-synced cuts | Build a beat grid from imported music. Place selected shots on that grid. Check a known click track within one timeline frame. Undo the pass once. |
| 4 | Reference video analysis | Measure shot length, cuts per minute, brightness, and saturation. Show the measurements. Apply only the pacing or colour changes the creator selects. Keep reference footage out of the export. |
| 5 | Reusable elements and edit styles | Save and reuse lower thirds, titles, callouts, and caption presets. Add a talking-head recipe that combines existing tools and yields one reviewable edit. |
| 6 | Speed changes, keyframes, and custom graphics | Verify source-to-timeline mapping and audio sync through a speed change. Introduce agent-authored drawing code only with isolated execution, asset permissions, and a per-frame budget. |

Use OpenCardboard's batch editing and music tools as behavioural references. Use Motion's frame inspection and shared browser and worker composition as references for visual review. [OpenCardboard edit tools](https://github.com/rakesh0x/OpenCardboard/tree/5498e9e/packages/tools/src/tools) · [Motion frame inspection](https://github.com/TechWithEmmaYT/ai-video-editor-app/blob/ec9b403/lib/agent/tools/frames.ts) · [Motion composition](https://github.com/TechWithEmmaYT/ai-video-editor-app/blob/ec9b403/remotion/main.tsx)
