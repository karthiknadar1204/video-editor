import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { exportFile } from "../../worker/paths";
import { publicWatch, renderSequence } from "./project-export";
import { wakeExportWorker } from "./export-jobs";
import { auth } from "./auth";
import { projects } from "./projects";
import { mcp } from "./mcp";
import { wakeFrameWorker } from "./frames";
import { wakeAnalysisWorker } from "./analysis-worker";

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/projects", projects);
app.route("/api/mcp", mcp);
app.route("/api/watch", publicWatch);
wakeExportWorker();
wakeFrameWorker();
wakeAnalysisWorker();
setInterval(wakeAnalysisWorker, 30_000).unref();
let rendering = false;

app.post("/api/export", (c) => {
  if (c.req.header("Sec-Fetch-Site") === "cross-site") return c.text("Open the editor to export.", 403);
  if (rendering) return c.text("An export is already running. Try again in a moment.", 409);
  rendering = true;
  c.header("Cache-Control", "no-store, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamText(c, async (stream) => {
    try {
      await stream.writeln("Rendering");
      await renderSequence(chunk => stream.write(chunk));
      await stream.writeln("Ready");
    } catch (error) {
      console.error("Export failed", error);
      await stream.writeln("Failed");
    } finally {
      rendering = false;
    }
  });
});

app.get("/api/export", async (c) => {
  const file = Bun.file(exportFile);
  if (!(await file.exists())) return c.text("Render the sequence first.", 404);
  return new Response(file, { headers: {
    "Content-Type": "video/mp4",
    "Content-Disposition": 'attachment; filename="earthrise.mp4"',
    "Cache-Control": "no-store",
  } });
});

export default { hostname: "127.0.0.1", port: Number(process.env.API_PORT ?? 4000), idleTimeout: 0, fetch: app.fetch };
