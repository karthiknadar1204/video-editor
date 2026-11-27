"use client";

import { useEffect, useState } from "react";
import { z } from "zod";

const metadata = z.object({ title: z.string(), revision: z.int() });
export function WatchPlayer({ token }: { token: string }) {
  const [video, setVideo] = useState<z.infer<typeof metadata> | null>(null), [unavailable, setUnavailable] = useState(false);
  const base = "/api/watch/" + encodeURIComponent(token);
  useEffect(() => {
    const cancel = new AbortController();
    void fetch(base, { cache: "no-store", signal: cancel.signal }).then(async r => {
      if (!r.ok) throw new Error();
      setVideo(metadata.parse(await r.json()));
    }).catch(() => { if (!cancel.signal.aborted) setUnavailable(true); });
    return () => cancel.abort();
  }, [base]);
  return <main className="watch-page"><header><span className="brand-symbol" aria-hidden="true" />Cutroom</header>
    {unavailable ? <h1>This watch link is unavailable.</h1> : video ? <article>
      <video controls playsInline preload="metadata" src={base + "/media"} aria-label={video.title} onError={() => setUnavailable(true)} />
      <div><h1>{video.title}</h1><p>Revision {video.revision}</p></div></article> : <p role="status">Loading video…</p>}
  </main>;
}
