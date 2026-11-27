# Cutroom

A browser-based video editor built with Next.js, Hono, Bun, and Remotion. The first milestone previews and exports a ten-second Apollo 8 sequence.

## Run locally

Use Bun 1.3.3 and Node 22.19.0. Start both services from the repository root.

```sh
bun install --frozen-lockfile
bun run dev
```

Open **http://127.0.0.1:3000**. Play the sequence with sound, select **Title in**, then use **Previous frame** to check the cut. Choose **Export MP4** and then **Download MP4**. The first export downloads Remotion’s matching headless Chrome. Footage and fonts are included in the repository.

## How it fits together

| Folder | Responsibility |
| --- | --- |
| `apps/web` | Next.js preview, playback controls, export button, and bundled media. |
| `apps/api` | Hono on Bun. `POST /api/export` starts the worker and streams progress. `GET /api/export` downloads the most recent completed MP4. |
| `apps/worker` | Node process that bundles the composition and renders H.264 video with AAC audio. |
| `packages/timeline` | The sequence as data, including dimensions, frame rate, clip placement, and title timing. |
| `packages/composition` | The Remotion component and local font used by both the browser and worker. |
| `tests` | A browser test that renders a real MP4, downloads it, and checks frames and audio. |

Next.js forwards `/api` to Hono on port 4000 in development and in the production build. Both services bind to loopback. The worker uses a temporary directory and replaces `.renders/earthrise.mp4` only after encoding succeeds. A second browser export receives HTTP 409 while the first is running. This local milestone uses one fixed sequence and one output file.

## Commands

| Command | Result |
| --- | --- |
| `bun run dev` | Start Next.js and Hono together. |
| `bun run --cwd apps/web dev` or `bun run --cwd apps/api dev` | Start either development process on its own. |
| `bun run render` | Run the worker once and write the MP4 under `.renders/`. |
| `bun run typecheck` | Check the apps, shared packages, and tests. |
| `bun run build` followed by `bun run start` | Run the production Next.js build with Hono. |
| `bunx playwright install chromium` followed by `bun run test` | Run the end-to-end check. It starts the development server if the app is offline, or checks the running build. |

To use an existing installation of Google Chrome for the test, set `TEST_BROWSER_CHANNEL=chrome`. To supply a worker browser on a machine with restricted downloads, set `REMOTION_BROWSER_EXECUTABLE` to its executable. If you change Hono’s port, set `API_PORT` for Hono and `API_ORIGIN` for Next.js before development startup or production build.

The fixture transcript, cut timing, and initial measurements are in the [Phase 1 verification notes](docs/first-render.md). The [implementation plan](docs/implementation-plan.md) describes the later editing and agent milestones.
