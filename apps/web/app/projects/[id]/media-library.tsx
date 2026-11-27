import { assetSchema, type Timeline } from "@editor/timeline";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { SourceInspector } from "./source-inspector";
import "./source-inspector.css";

type Asset = Timeline["assets"][number];
const ticketSchema = z.object({ id: z.uuid(), upload: z.object({ method: z.enum(["PUT", "POST"]), url: z.string(), fields: z.record(z.string(), z.string()) }) });
const receiptSchema = z.object({ fileId: z.string() });
type Ticket = z.infer<typeof ticketSchema>;

async function responseData(response: Response) {
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : "The upload service is unavailable.");
  return value;
}

function transfer(file: File, ticket: Ticket, signal: AbortSignal, progress: (n: number) => void): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(Math.round(e.loaded / e.total * 100)); };
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.onerror = () => reject(new Error("The upload connection was interrupted."));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error("Storage rejected the upload (" + xhr.status + ").")); return; }
      if (ticket.upload.method === "PUT") { resolve(undefined); return; }
      const receipt = receiptSchema.safeParse(xhr.response);
      if (receipt.success) resolve(receipt.data.fileId);
      else reject(new Error("Storage did not confirm the file."));
    };
    xhr.open(ticket.upload.method, ticket.upload.url);
    xhr.responseType = "json";
    if (ticket.upload.method === "PUT") { xhr.send(file); return; }
    const data = new FormData();
    for (const [key, value] of Object.entries(ticket.upload.fields)) data.append(key, value);
    data.append("file", file);
    xhr.send(data);
  });
}

type Job = { file: File; ticket?: Ticket; uploaded?: { fileId?: string } };

export function MediaLibrary({ id, timeline, revision, onJump, onAdded, onInsert, close }: {
  id: string; timeline: Timeline; revision: number; onJump: (id: string, frame: number) => void;
  onAdded: () => Promise<void>; onInsert: (asset: Asset) => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const job = useRef<Job | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "transfer" | "processing" | "failed">("idle");
  const [progress, setProgress] = useState(0);
  const [inspecting, setInspecting] = useState<Asset | null>(null);
  const path = "/api/projects/" + id + "/assets";
  useEffect(() => { dialog.current?.showModal(); return () => controller.current?.abort(); }, []);
  const busy = state === "transfer" || state === "processing";

  async function abandon() {
    const old = job.current;
    job.current = null;
    controller.current?.abort();
    controller.current = null;
    if (old?.ticket) await fetch(path + "/" + old.ticket.id, { method: "DELETE" }).catch(() => {});
  }
  async function upload(work: Job) {
    if (controller.current) return;
    job.current = work;
    const active = new AbortController();
    controller.current = active;
    const signal = active.signal;
    setState("transfer"); setNote(""); setProgress(0);
    try {
      if (!work.uploaded) {
        if (work.ticket) await fetch(path + "/" + work.ticket.id, { method: "DELETE", signal });
        work.ticket = ticketSchema.parse(await responseData(await fetch(path, { method: "POST", signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: work.file.name, type: work.file.type, size: work.file.size }) })));
        work.uploaded = { fileId: await transfer(work.file, work.ticket, signal, setProgress) };
      }
      if (!work.ticket) throw new Error("Choose the file again.");
      setState("processing");
      const result = await responseData(await fetch(path + "/" + work.ticket.id, { method: "POST", signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(work.uploaded) }));
      assetSchema.parse(result);
      await onAdded();
      job.current = null;
      setNote(work.file.name + " is ready."); setState("idle");
    } catch (error) {
      if (!signal.aborted) { setState("failed"); setNote(error instanceof Error ? error.message : "Upload failed."); }
    } finally { if (controller.current === active) controller.current = null; }
  }
  function pick(file?: File) {
    if (!file || busy) return;
    void abandon().then(() => upload({ file }));
  }
  function cancel() {
    void abandon();
    setState("idle"); setNote("Upload cancelled.");
  }
  return <dialog className="media-dialog" ref={dialog} aria-label="Media library" onCancel={e => { if (busy) e.preventDefault(); else close(); }}>
    <div className="studio-panel-title"><h2>Media library</h2><button disabled={busy} className="studio-plain" onClick={close} aria-label="Close media library">×</button></div>
    {inspecting ? <SourceInspector key={inspecting.id} projectId={id} asset={inspecting} fps={timeline.fps} revision={revision}
      onJump={onJump} back={() => setInspecting(null)} /> : <>
    <label className="upload-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}>
      <span aria-hidden="true">↑</span><strong>Choose footage</strong><small>Drop video or audio here · up to 64 MiB</small>
      <input aria-label="Choose footage" type="file" accept="video/mp4,video/quicktime,video/webm,audio/*" disabled={busy}
        onChange={e => { pick(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
    </label>
    {busy && <div className="upload-progress"><strong>{job.current?.file.name}</strong><progress max={100} value={state === "transfer" ? progress : undefined} />
      <span>{state === "transfer" ? "Uploading · " + progress + "%" : "Preparing playback and thumbnail…"}</span> <button onClick={cancel}>Cancel upload</button></div>}
    {note && <p aria-live="polite">{note} {state === "failed" && job.current && <button onClick={() => job.current && void upload(job.current)}>Retry upload</button>}</p>}
    <ul className="media-items">{[...timeline.assets].reverse().map(a => <li key={a.id}>
      {a.metadata?.thumbnail || !a.metadata ? <img src={a.metadata?.thumbnail ?? "/media/opening.jpg"} alt="" /> : <span className="audio-tile">♫</span>}
      <div><strong>{a.name}</strong><small>{(a.duration / timeline.fps).toFixed(1)} s · {a.metadata ? a.metadata.mediaType === "audio" ? "Audio" : a.metadata.width + " × " + a.metadata.height : "Sample footage"}</small>
        <small>{a.metadata && !a.metadata.hasAudio ? "Playable · No audio" : "Playable"}</small></div>
      <button aria-label={"Inspect " + a.name} disabled={busy} onClick={() => setInspecting(a)}>Inspect</button>
      <button aria-label={"Insert " + a.name} disabled={busy} onClick={() => onInsert(a)}>Insert</button>
    </li>)}</ul></>}
  </dialog>;
}
