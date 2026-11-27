import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDir } from "../../worker/paths";
import { renderSequence } from "./project-render";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const archive = join(renderDir, "releases");
const releaseDir = (id: string) => join(archive, id);
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }));
  return groups.flat().sort();
}
async function fingerprint() {
  const paths = ["apps/worker/src/render.ts", "apps/worker/package.json", "bun.lock",
    ...await filesUnder("packages/composition/src"), ...await filesUnder("packages/timeline/src"), ...await filesUnder("apps/web/public")];
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = digest(await readFile(join(root, path)));
  const fonts: Record<string, string> = {}, media: Record<string, string> = {};
  for (const [path, hash] of Object.entries(files)) {
    if (path.endsWith(".woff2")) fonts[relative("apps/web/public", path)] = hash;
    if (path.endsWith(".mp4")) media[relative("apps/web/public", path)] = hash;
  }
  return { id: digest(JSON.stringify(files)), fonts, media, engine: digest(files["apps/worker/src/render.ts"] + files["apps/worker/package.json"]) };
}
let current: ReturnType<typeof fingerprint> | undefined;
export const currentExportRelease = () => current ??= fingerprint().catch(error => { current = undefined; throw error; });
let freezing: Promise<void> | undefined;

async function freeze(id: string, engine: string) {
  const target = releaseDir(id);
  if (await Bun.file(join(target, "engine")).exists()) return;
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(archive, "build-"));
  try {
    await renderSequence(async () => {}, undefined, { freeze: join(temporary, "bundle"), signal: AbortSignal.timeout(120_000) });
    await writeFile(join(temporary, "engine"), engine);
    try { await rename(temporary, target); }
    catch (error) { if (!await Bun.file(join(target, "engine")).exists()) throw error; }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function prepareExportRelease() {
  const release = await currentExportRelease();
  await (freezing ??= freeze(release.id, release.engine).finally(() => { freezing = undefined; }));
  return release;
}
export async function pinnedBundle(id: string) {
  const release = await currentExportRelease();
  if (release.id === id) await prepareExportRelease();
  const engine = await Bun.file(join(releaseDir(id), "engine")).text();
  if (engine !== release.engine) throw new Error("This export needs its original render worker.");
  return join(releaseDir(id), "bundle");
}
