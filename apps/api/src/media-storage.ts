import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, open, link, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ImageKit from "@imagekit/nodejs";
import type { projectAsset } from "./db/schema";
import { MediaError, originalName, prepareMedia } from "./media";

type Upload = typeof projectAsset.$inferSelect;
const localRoot = resolve(process.env.CUTROOM_MEDIA_DIR ?? fileURLToPath(new URL("../../../.local/media", import.meta.url)));
const localFolder = (row: Upload) => join(localRoot, row.projectId, row.id);
const remoteFolder = (row: Upload) => "/cutroom/" + row.projectId + "/" + row.id;
const now = () => Math.floor(Date.now() / 1000);

function credentials() {
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY, publicKey = process.env.IMAGEKIT_PUBLIC_KEY, urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;
  if (!privateKey || !publicKey || !urlEndpoint?.startsWith("https://")) throw new MediaError("ImageKit uploads are not configured.", 503);
  return { privateKey, publicKey, urlEndpoint };
}

export function storageMode() {
  if (process.env.CUTROOM_MEDIA_STORAGE === "local") return "local";
  credentials();
  return "imagekit";
}

export function uploadTarget(row: Upload, base: string) {
  if (row.storage === "local") return { method: "PUT", url: base + "/original", fields: {} };
  const { privateKey, publicKey } = credentials();
  const fields = { fileName: originalName(row.mime), folder: remoteFolder(row), isPrivateFile: "true",
    useUniqueFileName: "false", overwriteFile: "false", checks: '"file.size" <= ' + row.size };
  const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const iat = now();
  const message = encode({ alg: "HS256", typ: "JWT", kid: publicKey }) + "." + encode({ ...fields, iat, exp: iat + 600 });
  const token = message + "." + createHmac("sha256", privateKey).update(message).digest("base64url");
  return { method: "POST", url: "https://upload.imagekit.io/api/v2/files/upload", fields: { ...fields, token } };
}

async function writeOriginal(body: ReadableStream<Uint8Array> | null, row: Upload, folder: string) {
  if (!body) throw new MediaError("The upload was empty.", 400);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temp = join(folder, crypto.randomUUID() + ".part");
  const handle = await open(temp, "wx", 0o600);
  const reader = body.getReader();
  try {
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > row.size) throw new MediaError("The file exceeds its authorized size.", 413);
      await handle.writeFile(chunk.value);
    }
    if (bytes !== row.size) throw new MediaError("The upload was interrupted. Try the file again.", 422);
    await link(temp, join(folder, originalName(row.mime)));
  } finally {
    await reader.cancel().catch(() => {});
    await handle.close();
    await rm(temp, { force: true });
  }
}

export async function storeLocalOriginal(row: Upload, request: Request) {
  if (row.storage !== "local") throw new MediaError("Use the authorized upload URL.", 403);
  if (request.headers.get("content-length") && Number(request.headers.get("content-length")) !== row.size) throw new MediaError("Unexpected upload size.", 422);
  try { await writeOriginal(request.body, row, localFolder(row)); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new MediaError("This upload already contains a file.", 409);
    throw error;
  }
}

function signedURL(row: Upload, file: string) {
  const { privateKey, urlEndpoint } = credentials();
  return new ImageKit({ privateKey }).helper.buildSrc({ urlEndpoint, src: remoteFolder(row) + "/" + file,
    transformation: [{ original: true }], signed: true, expiresIn: 300 });
}

export async function processUpload(row: Upload, fileId: string | undefined, base: string, fps: number) {
  const remote = row.storage === "imagekit";
  const folder = remote ? await mkdtemp(join(tmpdir(), "cutroom-ingest-")) : localFolder(row);
  try {
    const client = remote ? new ImageKit({ privateKey: credentials().privateKey, maxRetries: 1, timeout: 60_000 }) : null;
    if (client) {
      if (!fileId) throw new MediaError("Missing uploaded file ID.", 400);
      const details = await client.files.get(fileId);
      if (details.fileId !== fileId || details.filePath !== remoteFolder(row) + "/" + originalName(row.mime)
        || !details.isPrivateFile || details.size !== row.size) throw new MediaError("The uploaded file does not match this project.", 422);
      const source = await fetch(signedURL(row, originalName(row.mime)), { redirect: "error", signal: AbortSignal.timeout(90_000) });
      if (!source.ok) throw new MediaError("Could not retrieve the private original.", 503);
      await writeOriginal(source.body, row, folder);
    }
    if (!await Bun.file(join(folder, originalName(row.mime))).exists()) throw new MediaError("Upload the file before attaching it.", 422);
    const result = await prepareMedia(folder, row.mime, row.size, base, fps);
    if (client) {
      for (const fileName of result.metadata.thumbnail ? ["playback.mp4", "thumbnail.jpg"] : ["playback.mp4"]) {
        await client.files.upload({ folder: remoteFolder(row), fileName, file: Bun.file(join(folder, fileName)),
          isPrivateFile: true, useUniqueFileName: false, overwriteFile: true });
      }
    }
    return { ...result, id: row.id, name: row.name, src: base + "/playback" };
  } finally { if (remote) await rm(folder, { recursive: true, force: true }); }
}

export async function removeAbandoned(row: Upload) {
  if (row.storage === "local") { await rm(localFolder(row), { recursive: true, force: true }); return; }
  const client = new ImageKit({ privateKey: credentials().privateKey, maxRetries: 1 });
  const path = remoteFolder(row);
  for (const file of await client.assets.list({ type: "file", path: path + "/" })) {
    if (file.fileId && file.filePath?.startsWith(path + "/")) await client.files.delete(file.fileId);
  }
}

export async function serveAsset(row: Upload, kind: string, range: string | undefined) {
  const name = kind === "original" ? originalName(row.mime) : kind === "playback" ? "playback.mp4"
    : kind === "thumbnail" && row.asset?.metadata?.thumbnail ? "thumbnail.jpg" : null;
  if (!name) throw new MediaError("Media not found.", 404);
  const headers = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  if (row.storage === "imagekit") {
    headers.set("Location", signedURL(row, name));
    return new Response(null, { status: 307, headers });
  }
  const path = join(localFolder(row), name);
  const size = (await stat(path)).size;
  const file = Bun.file(path);
  headers.set("Content-Type", kind === "original" ? row.mime : kind === "thumbnail" ? "image/jpeg" : row.asset?.metadata?.mediaType === "audio" ? "audio/mp4" : "video/mp4");
  headers.set("Accept-Ranges", "bytes");
  if (!range) { headers.set("Content-Length", String(size)); return new Response(file, { headers }); }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = match && !match[1] ? Math.max(0, size - Number(match[2])) : Number(match?.[1]);
  const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end || start >= size) {
    headers.set("Content-Range", "bytes */" + size);
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Length", String(end - start + 1));
  headers.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
  return new Response(file.slice(start, end + 1), { status: 206, headers });
}
