import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import ImageKit, { NotFoundError } from "@imagekit/nodejs";
import { projectExportDir } from "../../worker/paths";
import type { exportVersion } from "./db/export-schema";
import { imageKitCredentials, serveLocalFile } from "./media-storage";

type Version = Pick<typeof exportVersion.$inferSelect, "id" | "projectId" | "storage" | "title">;
const folder = (v: Version) => "/cutroom/" + v.projectId + "/exports/" + v.id;
const fileName = (attempt: number) => attempt + ".mp4";
const localFolder = (v: Version) => join(projectExportDir(v.projectId), "versions", v.id);

export async function publishOutput(v: Version, attempt: number, file: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (v.storage === "local") {
    await mkdir(localFolder(v), { recursive: true, mode: 0o700 });
    await rename(file, join(localFolder(v), fileName(attempt)));
    return null;
  }
  const client = new ImageKit({ privateKey: imageKitCredentials().privateKey, timeout: 120_000, maxRetries: 0 });
  const bytes = Bun.file(file);
  const uploaded = await client.files.upload({ file: bytes, fileName: fileName(attempt), folder: folder(v),
    isPrivateFile: true, useUniqueFileName: false, overwriteFile: false }, { signal });
  if (!uploaded.fileId) throw new Error("The output upload returned no file.");
  const info = await client.files.get(uploaded.fileId, { signal });
  if (!info.isPrivateFile || info.filePath !== folder(v) + "/" + fileName(attempt) || info.size !== bytes.size) {
    throw new Error("The private output upload could not be verified.");
  }
  return uploaded.fileId;
}

export async function forgetOutput(v: Version, attempt: number) {
  if (v.storage === "local") {
    try { await unlink(join(localFolder(v), fileName(attempt))); }
    catch (error) {
      // A missing parent or a non-directory in its place means this output was never published.
      if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
    }
    return;
  }
  const client = new ImageKit({ privateKey: imageKitCredentials().privateKey, timeout: 30_000, maxRetries: 1 });
  const path = folder(v);
  try {
    for (let skip = 0; ; skip += 100) {
      const files = await client.assets.list({ type: "file", path: path + "/", skip, limit: 100 });
      const file = files.find(item => item.filePath === path + "/" + fileName(attempt));
      if (file?.fileId) { await client.files.delete(file.fileId); return; }
      if (files.length < 100) return;
    }
  } catch (e) { if (!(e instanceof NotFoundError)) throw e; }
}

export async function streamOutput(v: Version, attempt: number, request: Request, download: boolean) {
  const headers = new Headers({ "Content-Type": "video/mp4", "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Accept-Ranges": "bytes" });
  if (download) headers.set("Content-Disposition", "attachment; filename=\"cutroom.mp4\"; filename*=UTF-8''" +
    encodeURIComponent(v.title + ".mp4").replaceAll("'", "%27"));
  const range = request.headers.get("Range") ?? undefined;
  if (v.storage === "local") return serveLocalFile(join(localFolder(v), fileName(attempt)), headers, range);
  const { privateKey, urlEndpoint } = imageKitCredentials();
  const src = new ImageKit({ privateKey }).helper.buildSrc({ urlEndpoint, src: folder(v) + "/" + fileName(attempt),
    transformation: [{ original: true }], signed: true, expiresIn: 60 });
  const remote = await fetch(src, { headers: range ? { Range: range } : undefined, method: request.method === "HEAD" ? "HEAD" : "GET",
    redirect: "error", signal: request.signal });
  if (![200, 206, 416].includes(remote.status)) throw new Error("Output unavailable.");
  for (const name of ["Content-Range", "Content-Length"]) {
    const value = remote.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(remote.body, { headers, status: remote.status });
}
