# Footage analysis worker

## Install the English speech model

Use Bun, FFmpeg, CMake, curl, tar and a C/C++ compiler on macOS or Linux. From the repository root, install the workspace packages and build the CPU-only recognizer.

```sh
bun install --frozen-lockfile
bun run --cwd apps/worker setup:whisper
```

The installer verifies downloaded bytes, builds the CLI, and prints the local executable's SHA-256. It keeps the model and the upstream speech fixture in the ignored `.local/whisper-1.8.3` directory. For a separate worker host, build for that host and set `CUTROOM_WHISPER_DIR` to the same installation directory during setup and runtime. The worker needs read access to `build/bin/whisper-cli` and `ggml-base.en.bin`. A CMake executable outside the search path can be supplied using `CUTROOM_CMAKE`. Model installation happens during setup; processing uploaded footage runs locally.

| Component | Version or checksum |
| --- | --- |
| whisper.cpp | v1.8.3, commit `2eeeba56e9edd762b4b38467bab96c2517163158` |
| Source archive SHA-256 | `089b898aa83b24a8321e0fd554eeb0967fb03dd687e27f6374c72d3363b5b429` |
| English base GGML model | Repository revision `5359861c739e955e79d9a303bcbc70fb988958b1`, 147,964,211 bytes |
| Model SHA-256 | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| Upstream JFK WAV SHA-256 | `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e` |

The public human-speech fixture ships in the verified whisper.cpp source archive. The upstream CLI describes word timestamps as experimental. [Pinned whisper.cpp release and speech example](https://github.com/ggml-org/whisper.cpp/tree/2eeeba56e9edd762b4b38467bab96c2517163158#word-level-timestamp-experimental) · [Pinned model](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1)

## Check speech and source frames

```sh
bun test apps/worker/test/analysis.test.ts
CUTROOM_TEST_WHISPER=1 bun test apps/worker/test/analysis.test.ts
bun run --cwd apps/worker benchmark:speech
```

The first command needs FFmpeg and the worker packages. It generates silent red/blue video, decodes its audio, and checks the contact-sheet pixels, timestamp labels and source positions. The other commands use the installed native recognizer and real speech. In Linux CI, install FFmpeg, CMake and a C++ compiler before running setup. Cache the verified model between runs using its SHA-256 as part of the cache key.

Each request works from a staged local original. FFmpeg produces 16 kHz mono PCM on the source clock. Missing audio and near-digital silence at or below −80 dBFS produce zero words. For sustained leading silence the worker gives the recognizer a source offset with 100 ms of pre-roll. Whisper uses English, four CPU threads, one-word output segments, and word-boundary splitting. Times are measured in milliseconds. If one native segment contains multiple words, its subdivisions are marked estimated. A video can still produce its source contact sheet if transcription fails. The sheet shows up to six separately decoded source frames and their source timestamps.

## Measured speech timing

On an Apple M4 with FFmpeg 8.0.1 and the pinned CPU build, three runs on the 11-second JFK WAV took 793, 738 and 712 ms, including decoding and recognizer startup. The median runtime was 0.067 seconds per second of audio. The build used CMake 3.31.6; the workstation executable's SHA-256 was `ea19bbd4ad78ceea28856c20f579391fbcb9b715884753bb4ae858abc19f48fb`. Executable hashes depend on the compiler, platform and build path.

The published 22-word sentence had zero word errors after case and punctuation normalization. A second input prefixed the recording with exactly 2,000 ms of silence and also had zero word errors. Across its 22 matching word starts, the median deviation from the known shift was 160 ms and the maximum was 700 ms. This measures timing stability on one speaker. Absolute boundary accuracy requires independently annotated word times. Use transcript search to find a passage, listen at the boundary, and correct timing before a precise cut.
