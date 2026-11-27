# First-render fixture

The source clip is a ten-second, 1280 × 720 montage at 30 fps. It uses two moving crops of NASA photograph AS08-14-2383 and two excerpts from the Apollo 8 crew’s onboard recording. The source MP4 contains the visual cut and speech. The project adds the title during preview and export. [Photograph and credit](https://science.nasa.gov/resource/apollo-8s-iconic-earthrise/) · [Public-domain recording and provenance](https://commons.wikimedia.org/wiki/File:Earthrise_conversation.ogg)

## Picture and sound

All frame numbers start at zero. An interval includes its first frame and ends immediately before its final frame number.

| Time | Expected result |
| --- | --- |
| 0.000–5.000 s | Wide crop of the photograph. The title is absent through frame 149. |
| 5.000–10.000 s | Tighter crop. “Earthrise” appears on frame 150 and stays through frame 299. |
| 0.000–6.350 s | First 6.35 seconds of the source recording. After the opening radio noise, Bill Anders notices Earth. |
| 6.350–7.850 s | Deliberately inserted silence lasting 1.5 seconds. |
| 7.850–10.000 s | Source recording from 14.20 to 16.35 seconds. Anders asks Jim for film. |

The first spoken passage is “Oh, my God! Look at that picture over there! Here's the Earth coming up. Wow, is that pretty!” The second is “You got a color film, Jim?” These were checked against the timed flight journal and a separate speech decode of the source recording. The times above mark the edited source ranges. [Apollo 8 Flight Journal, lunar orbit 4](https://www.apollojournals.org/afj/ap08fj/16day4_orbit4.html)

The bundled Inter Latin variable font uses the SIL Open Font License. The preview and render load the same WOFF2 file. [Font license](../apps/web/public/fonts/LICENSE.txt)

## Repeat the check

1. Run `bun run build` and `bun run start`. Open the editor, play with sound, and listen across the pause.
2. Select **Title in** and step backward and forward. The readout should switch between frames 149 and 150. Use **Opening shot** to return to the start.
3. With the local database and mail services running, use `bun run test` for the development proxy or `E2E_PRODUCTION=1 bun run test` for the production build. The test starts isolated servers, observes intermediate export progress, downloads the MP4, opens its bytes in a separate native HTML video element, compares the title region to screenshots, and measures the decoded speech and silence.
4. For a stream-level inspection, run `ffprobe -v error -show_entries stream=codec_name,width,height,avg_frame_rate,nb_frames,duration -of compact .renders/earthrise.mp4`. Expect 300 H.264 frames and an AAC audio stream. The video duration is exactly 10.000 seconds. AAC padding can extend the container duration by less than one video frame.

## Initial local baseline

Measured November 27, 2026 on an Apple M4 running macOS 27.2.1. The API used Bun 1.3.3. The worker used Node 22.19.0, Remotion 4.0.547, its bundled Chrome Headless Shell 158.0.8127.2, and two concurrent render frames.

| Measurement | Observed | Measurement boundary |
| --- | ---: | --- |
| First decoded preview | 288 ms | Navigation start to the preview video's first `loadeddata` event in a fresh browser context against the running production build. |
| Worker export | 11.55 s | Starting the standalone worker to its exit, including composition bundling and MP4 encoding. The browser was already installed. |
| Peak worker memory | 2.43 GiB | Highest sum of resident memory for the worker and its descendants, including Chrome and the encoder, sampled about every 200 ms. Shared pages can be counted more than once. |

The downloaded video had 300 frames. The title region was dark at frame 149 and contained the title at frame 150 in both players. The encoded pause decoded to silence, and both speech passages were intelligible to a separate speech decoder. Both development and production runs delivered progress before the download became available. These measurements cover the local worker. Repeat this measurement on the BullMQ worker host before choosing its render capacity.
