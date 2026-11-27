import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { analysisVersion, transcribeSource } from "./src/analysis";
import { fixturePath } from "./whisper";

const expected = "and so my fellow americans ask not what your country can do for you ask what you can do for your country".split(" ");
const normalize = (word: string) => word.toLowerCase().replace(/[^a-z']/g, "");
const median = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  return (ordered[Math.floor((values.length - 1) / 2)] + ordered[Math.floor(values.length / 2)]) / 2;
};
function editDistance(left: string[], right: string[]) {
  let row = right.map((_, i) => i + 1);
  row.unshift(0);
  for (const [i, a] of left.entries()) {
    const next = [i + 1];
    for (const [j, b] of right.entries()) next.push(Math.min(row[j] + Number(a !== b), row[j + 1] + 1, next[j] + 1));
    row = next;
  }
  return row[right.length];
}
async function measure(path: string, durationMs: number) {
  const start = performance.now();
  const { words } = await transcribeSource({ path, durationMs, hasAudio: true });
  return { words, elapsedMs: Math.round(performance.now() - start), text: words.map(w => normalize(w.text)) };
}

const folder = await mkdtemp(join(tmpdir(), "cutroom-benchmark-"));
try {
  const shifted = join(folder, "shifted.wav"), gapMs = 2000;
  await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-i", fixturePath, "-af", "adelay=2000:all=1", "-c:a", "pcm_s16le", shifted]);
  const base = await measure(fixturePath, 11_000);
  const repeat = await measure(shifted, 11_000 + gapMs);
  const timings = [base.elapsedMs];
  for (let i = 0; i < 2; i++) timings.push((await measure(fixturePath, 11_000)).elapsedMs);
  const identicalText = base.text.join(" ") === repeat.text.join(" ");
  const drift = identicalText ? base.words.map((w, i) => Math.abs(repeat.words[i].startMs - w.startMs - gapMs)) : [];
  console.log(JSON.stringify({ analysisVersion, durationMs: 11_000, sourceWords: expected.length, recognizedWords: base.words.length,
    wordErrors: editDistance(expected, base.text), shiftedWordErrors: editDistance(expected, repeat.text), elapsedMs: timings,
    realTimeFactor: median(timings) / 11_000, knownOffsetMs: gapMs, comparableWordStarts: drift.length,
    medianOffsetErrorMs: drift.length ? median(drift) : null, maxOffsetErrorMs: drift.length ? Math.max(...drift) : null }, null, 2));
} finally { await rm(folder, { recursive: true, force: true }); }
