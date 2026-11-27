"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import "./export-history.css";

const result = z.object({ id: z.uuid(), revision: z.int(), attempt: z.int(), status: z.enum(["queued", "rendering", "uploading", "completed", "failed", "cancelled"]),
  progress: z.int(), error: z.string().nullable(), downloadUrl: z.string().nullable(), watchPath: z.string().nullable(), createdAt: z.string(), expiresAt: z.string() });
const history = z.object({ items: z.array(result), nextOffset: z.number().nullable() });
type Row = z.infer<typeof result>;
const running = (r: Row) => ["queued", "rendering", "uploading"].includes(r.status);
const label = (r: Row) => r.status === "rendering" ? "Rendering " + r.progress + "%" : r.status.charAt(0).toUpperCase() + r.status.slice(1);

const editsPage = z.object({ edits: z.array(z.object({ revision: z.int(), label: z.string(), target: z.int().nullable() })), nextRevision: z.int().nullable() });
function ExportEdits({ path }: { path: string }) {
  const [page, setPage] = useState<z.infer<typeof editsPage>>();
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  async function load(through?: number) {
    setLoading(true); setError(false);
    try {
      const response = await fetch(path + "/edits" + (through === undefined ? "" : "?through=" + through), { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = editsPage.parse(await response.json());
      setPage(old => ({ ...data, edits: [...(old?.edits ?? []), ...data.edits] }));
    } catch { setError(true); }
    finally { setLoading(false); }
  }
  return <details className="export-edits" onToggle={event => {
    if (event.currentTarget.open && !page && !loading) void load();
  }}><summary>Edits in this version</summary>
    {page && (page.edits.length ? <ol>{page.edits.map(edit => <li key={edit.revision}>r{edit.revision} · {edit.label}{edit.target !== null ? " (r" + edit.target + ")" : ""}</li>)}</ol> : <small>Initial project</small>)}
    {loading && <small>Loading edits…</small>}
    {error && <span role="alert">Could not load edits. </span>}
    {!loading && (error || page?.nextRevision != null) && <button type="button" onClick={() => void load(page?.nextRevision ?? undefined)}>{error ? "Try again" : "Earlier edits"}</button>}
  </details>;
}

export function ProjectExports({ project, disabled }: { project: { id: string; revision: number }; disabled: boolean }) {
  const base = "/api/projects/" + project.id;
  const [rows, setRows] = useState<Row[]>([]), [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0), visiblePages = useRef(1);
  const refresh = useCallback(async (more = false) => {
    const count = visiblePages.current + Number(more);
    const token = ++generation.current;
    const versions = new Map<string, Row>();
    let offset: number | null = 0, fetched = 0;
    while (offset !== null && fetched < count) {
      const res = await fetch(base + "/exports?offset=" + offset, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load export history.");
      const page = history.parse(await res.json());
      if (token !== generation.current) return;
      for (const row of page.items) versions.set(row.id, row);
      offset = page.nextOffset;
      fetched++;
    }
    visiblePages.current = fetched;
    setRows([...versions.values()]);
    setNext(offset);
  }, [base]);
  const active = rows.some(running);
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { if (document.visibilityState !== "hidden") await refresh(); }
      catch { if (mounted) setError("Could not load export history."); }
      if (mounted) timer = setTimeout(poll, active ? 850 : 10_000);
    }
    void poll();
    return () => { mounted = false; generation.current++; clearTimeout(timer); };
  }, [active, refresh]);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);

  async function change(url: string, method: "POST" | "DELETE", data?: object) {
    setBusy(true); setError(""); generation.current++;
    try {
      const res = await fetch(url, { method, headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not update the export.");
      const updated = result.parse(await res.json());
      generation.current++;
      setRows(old => [updated, ...old.filter(r => r.id !== updated.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update the export."); }
    finally { setBusy(false); }
  }
  const current = rows.find(r => r.revision === project.revision);
  const latest = rows[0];
  const download = current?.downloadUrl ? current : latest?.downloadUrl ? latest : null;
  function show() { setOpen(true); void refresh().catch(() => setError("Could not load export history.")); }
  return <div className="export export-controls">
    {error && !open && <span role="alert">{error}</span>}
    <button type="button" className="export-history-trigger" onClick={show} aria-label="Export history">Exports</button>
    {download?.downloadUrl && <a className="action" href={download.downloadUrl} download>
      {download.revision === project.revision ? "Download MP4" : "Download revision " + download.revision} <span aria-hidden="true">↓</span></a>}
    {current && running(current) ? <button type="button" className="action" onClick={show}>{label(current)}</button> :
      current && (current.status === "failed" || current.status === "cancelled") ? <button type="button" className="action" onClick={show}>Review export</button> :
      !current?.downloadUrl && <button type="button" className="action" disabled={disabled || busy}
        onClick={() => void change(base + "/export", "POST", { revision: project.revision })}>Export MP4 <span aria-hidden="true">↓</span></button>}
    {open && <dialog ref={dialog} className="export-history" aria-label="Export history" onClose={() => { visiblePages.current = 1; setOpen(false); }}>
      <header><h2>Export history</h2><button type="button" aria-label="Close export history" onClick={() => dialog.current?.close()}>Close</button></header>
      {error && <p role="alert">{error}</p>}
      {!rows.length && <p>No exports yet. Export a saved revision to download or share it.</p>}
      <ul>{rows.map(r => {
        const path = base + "/exports/" + r.id;
        return <li key={r.id}><div className="export-heading"><strong>Revision {r.revision}</strong><span data-state={r.status}>{label(r)}</span></div>
          <small>{new Date(r.createdAt).toLocaleString()} · Attempt {r.attempt}</small>
          {r.status === "completed" && <small>Available through {new Date(r.expiresAt).toLocaleDateString()}</small>}
          {r.status === "rendering" && <progress aria-label="Render progress" value={r.progress} max={100} />}
          {r.error && <p>{r.error}</p>}
          <ExportEdits path={path} />
          <div className="export-links">
            {running(r) && <button disabled={busy} onClick={() => void change(path + "?attempt=" + r.attempt, "DELETE")}>Cancel export</button>}
            {(r.status === "failed" || r.status === "cancelled") && <button disabled={busy} onClick={() => void change(path + "/retry", "POST", { attempt: r.attempt })}>Retry export</button>}
            {r.downloadUrl && <a href={r.downloadUrl} download>Download MP4</a>}
            {r.status === "completed" && (r.watchPath ? <><a href={r.watchPath} target="_blank" rel="noreferrer">Open watch link</a>
              <button onClick={() => void navigator.clipboard.writeText(new URL(r.watchPath!, location.origin).href).catch(() => setError("Copy the link from the address bar of the watch page."))}>Copy link</button>
              <button disabled={busy} onClick={() => void change(path + "/share", "DELETE")}>Revoke watch link</button></> :
              <button disabled={busy} onClick={() => void change(path + "/share", "POST", {})}>Create watch link</button>)}
          </div></li>;
      })}</ul>
      {next !== null && <button onClick={() => void refresh(true).catch(() => setError("Could not load older exports."))}>Load older exports</button>}
    </dialog>}
  </div>;
}
