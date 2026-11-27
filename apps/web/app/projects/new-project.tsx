"use client";

import { useRef, useState, type FormEvent } from "react";
import { canvasFormats } from "@editor/timeline";

const labels = { landscape: "Horizontal · 16:9", portrait: "Vertical · 9:16", square: "Square · 1:1" };

export function NewProject() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: data.get("title"), format: data.get("format") }),
      });
      if (response.status === 401) { window.location.replace("/account"); return; }
      const body = await response.json();
      if (!response.ok || typeof body.id !== "string") throw new Error(body.error || "Could not create the project.");
      window.location.assign("/projects/" + body.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project.");
      setBusy(false);
    }
  }

  return <>
    <button className="action" onClick={() => dialog.current?.showModal()}><span aria-hidden="true">+</span> New project</button>
    <dialog ref={dialog} aria-labelledby="new-project-title">
      <h2 id="new-project-title">New project</h2>
      <form onSubmit={create} className="stack">
        <label>Project title<input name="title" required maxLength={120} autoFocus /></label>
        <label>Canvas format<select name="format">{canvasFormats.map(format => <option value={format} key={format}>{labels[format]}</option>)}</select></label>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions"><button className="quiet" type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button className="action" disabled={busy}>{busy ? "Creating…" : "Create project"}</button></div>
      </form>
    </dialog>
  </>;
}
