import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { cliPath, fixturePath, modelPath, whisper, whisperDir } from "./whisper";

async function hash(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function verified(path: string, sha: string) {
  return await Bun.file(path).exists() && await hash(path) === sha;
}
async function run(args: string[]) {
  const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  if (await proc.exited !== 0) throw new Error(args[0] + " failed.");
}
async function download(url: string, path: string, sha: string) {
  if (await verified(path, sha)) return;
  const partial = path + ".part";
  await run(["curl", "--http1.1", "--fail", "--location", "--silent", "--show-error", "--retry", "3",
    "--max-time", "300", "--continue-at", "-", url, "--output", partial]);
  if (!await verified(partial, sha)) throw new Error("The downloaded file did not match its pinned SHA-256: " + partial);
  await rename(partial, path);
}

await mkdir(whisperDir, { recursive: true });
const archive = join(whisperDir, "source.tar.gz"), source = join(whisperDir, "source"), build = join(whisperDir, "build");
await download("https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/" + whisper.sourceCommit, archive, whisper.sourceHash);
await download("https://huggingface.co/ggerganov/whisper.cpp/resolve/" + whisper.modelRevision + "/ggml-base.en.bin?download=true", modelPath, whisper.modelHash);
await mkdir(source, { recursive: true });
await run(["tar", "-xzf", archive, "--strip-components=1", "-C", source]);
if (!await verified(fixturePath, whisper.fixtureHash)) throw new Error("The speech fixture checksum did not match.");
const cmake = process.env.CUTROOM_CMAKE ?? "cmake";
await run([cmake, "-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DGGML_METAL=OFF",
  "-DGGML_OPENMP=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF"]);
await run([cmake, "--build", build, "--config", "Release", "--target", "whisper-cli", "--parallel", "4"]);
console.log("whisper.cpp " + whisper.version + " installed. Local binary SHA-256 " + await hash(cliPath));
