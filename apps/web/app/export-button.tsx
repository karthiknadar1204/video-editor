"use client";

import { useState } from "react";

type ExportState =
  | { status: "idle" }
  | { status: "ready"; download: string; revision?: number }
  | { status: "rendering"; label: string }
  | { status: "failed"; message: string };

export function ExportButton({ project, disabled = false }: { project?: { id: string; revision: number }; disabled?: boolean }) {
  const [state, setState] = useState<ExportState>({ status: "idle" });

  async function startExport() {
    setState({ status: "rendering", label: "Preparing…" });
    try {
      const endpoint = project ? "/api/projects/" + project.id + "/export" : "/api/export";
      const response = await fetch(endpoint, project ? {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: project.revision }),
      } : { method: "POST" });
      if (!response.ok || !response.body) {
        const body = project && await response.json().catch(() => null);
        throw new Error(body?.error ?? (response.status === 409 ? "An export is already running." : "Couldn’t start the export."));
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
            setState({ status: "ready", download: project ? endpoint + "?revision=" + project.revision : endpoint, revision: project?.revision });
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
      {state.status === "ready" && <a className="action" href={state.download} download>
        {project && state.revision !== project.revision ? "Download revision " + state.revision : "Download MP4"} <span aria-hidden="true">↓</span>
      </a>}
      {(state.status !== "ready" || state.revision !== project?.revision) && <button className="action" onClick={startExport} disabled={disabled || state.status === "rendering"}>
            {state.status === "rendering" ? state.label : "Export MP4"} <span aria-hidden="true">↓</span>
          </button>}
    </div>
  );
}
