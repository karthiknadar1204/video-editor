import { editTimeline, textClip, type Change, type Clip, type ProjectSnapshot } from "@editor/timeline";
import { useState, type FormEvent } from "react";
import { CodexChat } from "./codex-chat";

type Proposal = { ops: Change[]; label: string; revision: number; select?: string };
export function AssistantPanel({ project, selected, frame, editable, onApply }: {
  project: ProjectSnapshot; selected?: Clip; frame: number; editable: boolean;
  onApply: (ops: Change[], select?: string) => Promise<boolean>;
}) {
  const [prompt, setPrompt] = useState("");
  const [proposal, propose] = useState<Proposal | null>(null);
  const [note, setNote] = useState("");
  const [completed, setCompleted] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const t = project.timeline;
  const target = selected?.kind === "text" ? selected.text : t.assets.find(a => selected?.kind === "media" && selected.assetId === a.id)?.name;
  const split = selected && frame > selected.start && frame < selected.start + selected.duration;
  const suggestions = ["Add title", ...(selected?.kind === "media" && selected.volume > 0 ? ["Mute clip"] : []), ...(split ? ["Split here"] : [])];
  function prepare(request: string) {
    const value = request.trim();
    setPrompt(value); setNote(""); propose(null);
    if (!value) return;
    const words = value.toLowerCase();
    const title = /^add title(?:\s+(.+))?$/i.exec(value);
    let ops: Change[], label: string, select: string | undefined;
    if (title) {
      const start = Math.max(frame, ...t.clips.filter(c => c.track === "title").map(c => c.start + c.duration));
      const content = (title[1] ?? project.title).replace(/^["“]|["”]$/g, "");
      select = crypto.randomUUID();
      ops = [{ type: "add", clip: textClip(select, content, start, t.fps * 3, t.height) }];
      label = "Add “" + content + "” for 3 seconds at frame " + start;
    } else if (words === "mute clip" && selected?.kind === "media") {
      ops = [{ type: "volume", id: selected.id, volume: 0 }]; label = "Mute " + target;
    } else if ((words === "split here" || words === "split at playhead") && selected) {
      select = crypto.randomUUID(); ops = [{ type: "split", id: selected.id, frame, rightId: select }]; label = "Split " + target + " at frame " + frame;
    } else {
      setNote("Choose a quick edit below, or type Add title followed by your title text."); return;
    }
    try { editTimeline(t, ops); propose({ ops, label, select, revision: project.revision }); }
    catch (error) { setNote(error instanceof Error ? error.message : "This edit is unavailable."); }
  }
  async function apply() {
    if (!proposal || applying || !editable || project.revision !== proposal.revision) return;
    setApplying(true);
    try {
      if (await onApply(proposal.ops, proposal.select)) {
        setCompleted(items => [...items.slice(-3), proposal.label]); setNote(""); setPrompt(""); propose(null);
      }
    } finally { setApplying(false); }
  }
  function send(e: FormEvent) { e.preventDefault(); prepare(prompt); }
  return <section className="studio-assistant studio-card" aria-label="Edit assistant">
    <div className="studio-panel-title"><span className="assistant-mark" aria-hidden="true">✦</span><h2>Codex assistant</h2></div>
    <CodexChat project={project} selected={selected} frame={frame} editable={editable} />
    <div className="assistant-body"><div className="assistant-intro"><h3>Quick edits</h3></div>
      {completed.length > 0 && <ol className="assistant-log" aria-label="Completed quick edits" aria-live="polite">{completed.map((item, i) =>
        <li key={i}><small>Applied</small>{item}</li>)}</ol>}
      {proposal && <div className="assistant-proposal"><small>{applying ? "Saving edit…" : "Proposed edit"}</small><strong>{proposal.label}</strong>
        {proposal.revision !== project.revision && <p>The sequence changed. Review the request again.</p>}
        <div><button className="studio-primary" disabled={!editable || proposal.revision !== project.revision} onClick={() => void apply()}>Apply edit</button>
        <button disabled={applying} onClick={() => { propose(null); setNote("Request stopped."); }}>Stop</button></div></div>}
      {note && <p className="assistant-note" aria-live="polite">{note}</p>}
    </div>
    <div className="assistant-compose"><div className="quick-edits">{suggestions.map(s => <button key={s} disabled={!editable} onClick={() => prepare(s)}>{s} <span>↗</span></button>)}</div>
      <details><summary>Custom quick edit</summary><form onSubmit={send}><label><span>{target ?? project.title}</span>
        <input aria-label="Quick edit request" value={prompt} maxLength={280} onChange={e => { setPrompt(e.target.value); propose(null); }} placeholder="Describe a quick edit…" /></label>
        <button type="submit" disabled={!editable || !prompt.trim()} aria-label="Preview request">↑</button></form></details>
    </div>
  </section>;
}
