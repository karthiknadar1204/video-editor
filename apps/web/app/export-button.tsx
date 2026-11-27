"use client";

import { useState } from "react";

type ExportState =
  | { status: "idle" | "ready" }
  | { status: "rendering"; label: string }
  | { status: "failed"; message: string };

export function ExportButton() {
  const [state, setState] = useState<ExportState>({ status: "idle" });

  async function startExport() {
    setState({ status: "rendering", label: "Preparing…" });
    try {
      const response = await fetch("/api/export", { method: "POST" });
      if (!response.ok || !response.body) {
        throw new Error(response.status === 409 ? "An export is already running." : "Couldn’t start the export.");
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("The export connection closed.");
        const lines = (pending + value).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "Ready") {
            setState({ status: "ready" });
            return;
          }
          if (line === "Failed") throw new Error("Export failed. Try again.");
          if (/^\d{1,3}$/.test(line)) setState({ status: "rendering", label: "Rendering " + line + "%" });
        }
      }
    } catch (error) {
      setState({ status: "failed", message: error instanceof Error ? error.message : "Export failed." });
    }
  }

  return (
    <div className="export" aria-live="polite">
      {state.status === "failed" && <span role="alert">{state.message}</span>}
      {state.status === "ready"
        ? <a className="action" href="/api/export" download>Download MP4 <span aria-hidden="true">↓</span></a>
        : <button className="action" onClick={startExport} disabled={state.status === "rendering"}>
            {state.status === "rendering" ? state.label : "Export MP4"} <span aria-hidden="true">↓</span>
          </button>}
    </div>
  );
}
