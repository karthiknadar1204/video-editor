import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { serveLocalFile } from "../src/media-storage";

test("Node can proxy Bun's full, open-ended, bounded and suffix media responses on a persistent connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cutroom-media-range-"));
  const path = join(dir, "playback.mp4");
  const size = 100585;
  const fixture = Buffer.alloc(size);
  for (let i = 0; i < size; i++) fixture[i] = i % 251;
  await writeFile(path, fixture);
  const app = new Hono();
  app.get("/", c => serveLocalFile(path, new Headers({
    "Content-Type": "video/mp4", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  }), c.req.header("Range")));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    // Next's rewrite proxy uses Node's HTTP parser, so exercise the on-wire response with that parser.
    const client = `
      import http from "node:http";
      import assert from "node:assert/strict";
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const size = Number(process.argv[2]);
      function open(range, method = "GET") {
        const headers = { "Accept-Encoding": "identity;q=1, *;q=0", ...(range && { Range: range }) };
        return new Promise((resolve, reject) => http.request(process.argv[1], { agent, headers, method }, resolve).on("error", reject).end());
      }
      async function read(range, start, end) {
        const res = await open(range);
        assert.equal(res.statusCode, range ? 206 : 200);
        if (range) assert.equal(res.headers["content-range"], "bytes " + start + "-" + end + "/" + size);
        if (res.headers["content-length"]) assert.equal(Number(res.headers["content-length"]), end - start + 1);
        else assert.equal(res.headers["transfer-encoding"], "chunked");
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        assert.equal(body.length, end - start + 1);
        for (let i = 0; i < body.length; i++) assert.equal(body[i], (start + i) % 251);
      }
      try {
        const head = await open(undefined, "HEAD");
        assert.equal(head.statusCode, 200);
        assert.equal(Number(head.headers["content-length"]), size);
        for await (const chunk of head) assert.equal(chunk.length, 0);
        for (let i = 0; i < 10; i++) {
          await read("bytes=0-", 0, size - 1);
          await read("bytes=23-78", 23, 78);
          await read("bytes=-16", size - 16, size - 1);
          await read(undefined, 0, size - 1);
          const interrupted = await open("bytes=0-");
          interrupted.destroy();
        }
        const invalid = await open("bytes=" + size + "-");
        assert.equal(invalid.statusCode, 416);
        assert.equal(invalid.headers["content-range"], "bytes */" + size);
        invalid.resume();
      } finally { agent.destroy(); }
    `;
    const { stderr } = await promisify(execFile)("node", ["--input-type=module", "-e", client, server.url.href, String(size)], { timeout: 10_000 });
    expect(stderr).toBe("");
  } finally { await server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
