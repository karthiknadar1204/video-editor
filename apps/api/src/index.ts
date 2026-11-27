import { Hono } from "hono";
import { auth } from "./auth";
import { mcp } from "./mcp";
import { publicWatch } from "./project-export";
import { projects } from "./projects";
import { sampleExports } from "./sample-export";

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/projects", projects);
app.route("/api/mcp", mcp);
app.route("/api/watch", publicWatch);
app.route("/api/export", sampleExports);

export default { hostname: "127.0.0.1", port: Number(process.env.API_PORT ?? 4000), idleTimeout: 0, fetch: app.fetch };
