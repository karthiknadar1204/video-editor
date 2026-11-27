import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const whisper = {
  version: "1.8.3",
  sourceCommit: "2eeeba56e9edd762b4b38467bab96c2517163158",
  sourceHash: "089b898aa83b24a8321e0fd554eeb0967fb03dd687e27f6374c72d3363b5b429",
  modelRevision: "5359861c739e955e79d9a303bcbc70fb988958b1",
  modelHash: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  fixtureHash: "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
};
export const analysisVersion = "whisper.cpp-" + whisper.version + "/base.en-" + whisper.modelHash.slice(0, 16) + "/sow-2/sheet-1";
export const whisperDir = process.env.CUTROOM_WHISPER_DIR ?? fileURLToPath(new URL("../../.local/whisper-" + whisper.version, import.meta.url));
export const cliPath = join(whisperDir, "build", "bin", "whisper-cli");
export const modelPath = join(whisperDir, "ggml-base.en.bin");
export const fixturePath = join(whisperDir, "source", "samples", "jfk.wav");
