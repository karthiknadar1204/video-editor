"use client";

import { useState } from "react";
import { ProjectExports } from "./export-history";

function DemoExport() {
  const [status, setStatus] = useState("idle"), [progress, setProgress] = useState(0);
  async function render() {
    setStatus("rendering");
    try {
      const res = await fetch("/api/export", { method: "POST" });
      if (!res.ok || !res.body) throw new Error();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error();
        const lines = (pending + value).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "Ready") { setStatus("ready"); return; }
          if (line === "Failed") throw new Error();
          if (/^\d{1,3}$/.test(line)) setProgress(Number(line));
        }
      }
    } catch { setStatus("failed"); }
  }
  return <div className="export" aria-live="polite">
    {status === "failed" && <span role="alert">Export failed. Try again.</span>}
    {status === "ready" ? <a className="action" href="/api/export" download>Download MP4 <span aria-hidden="true">↓</span></a> :
      <button className="action" disabled={status === "rendering"} onClick={() => void render()}>
        {status === "rendering" ? "Rendering " + progress + "%" : "Export MP4"} <span aria-hidden="true">↓</span></button>}
  </div>;
}
export function ExportButton({ project, disabled = false }: { project?: { id: string; revision: number }; disabled?: boolean }) {
  return project ? <ProjectExports key={project.id} project={project} disabled={disabled} /> : <DemoExport />;
}
