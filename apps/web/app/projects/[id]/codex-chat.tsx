import { runView, turnInput, type Clip, type ProjectSnapshot, type RunView } from "@editor/timeline";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { z } from "zod";

type Command = z.infer<typeof turnInput>;
export function CodexChat({
  project,
  selected,
  frame,
  editable,
}: {
  project: ProjectSnapshot;
  selected?: Clip;
  frame: number;
  editable: boolean;
}) {
  const base = "/api/projects/" + project.id + "/runs";
  const [tab, setTab] = useState("");
  const [turns, setTurns] = useState<RunView[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Command | null>(null);
  const [watch, setWatch] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  function remember(command: Command | null) {
    if (command) sessionStorage.setItem(base + "/pending", JSON.stringify(command));
    else sessionStorage.removeItem(base + "/pending");
    setPending(command);
  }
  useEffect(() => {
    const cancel = new AbortController();
    const tabId = sessionStorage.getItem(base + "/tab") ?? crypto.randomUUID();
    sessionStorage.setItem(base + "/tab", tabId);
    let saved: Command | null = null;
    try {
      saved = turnInput.parse(JSON.parse(sessionStorage.getItem(base + "/pending") ?? "null"));
    } catch {
      sessionStorage.removeItem(base + "/pending");
    }
    setPending(saved);
    void fetch(base + "?tabId=" + tabId, { cache: "no-store", signal: cancel.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const list = runView.array().parse(await response.json());
        setTurns(list);
        if (saved && list.some((r) => r.id === saved.id)) {
          sessionStorage.removeItem(base + "/pending");
          setPending(null);
        }
        const active = [...list].reverse().find((r) => r.status === "running");
        if (active) setWatch(active.id);
        setTab(tabId);
      })
      .catch(() => {
        if (!cancel.signal.aborted) setNote("Could not load the conversation. Reload to reconnect.");
      });
    return () => cancel.abort();
  }, [base]);

  useEffect(() => {
    if (!watch) return;
    const stream = new EventSource(base + "/" + watch);
    stream.addEventListener("run", (event: MessageEvent<string>) => {
      const run = runView.parse(JSON.parse(event.data));
      setTurns((list) => [...list.filter((r) => r.id !== run.id), run].slice(-12));
      setNote("");
      if (run.status !== "running") {
        stream.close();
        setWatch("");
      }
    });
    stream.onerror = () => setNote("Reconnecting to the turn…");
    stream.addEventListener("access-ended", () => {
      stream.close();
      setWatch("");
      setNote("Sign in again to view this turn.");
    });
    return () => stream.close();
  }, [base, watch]);
  useEffect(() => {
    const pane = bottom.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [turns]);

  async function send(command: Command) {
    setSending(true);
    setNote("");
    remember(command);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        if (response.status < 500) remember(null);
        const body = await response.json().catch(() => null);
        setNote(body?.error ?? "Could not start this turn.");
        return;
      }
      setWatch(command.id);
      setText("");
      remember(null);
    } catch {
      setNote("The connection was interrupted. Retry to reconnect to this request.");
    } finally {
      setSending(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!editable || !tab || watch || sending || !text.trim()) return;
    void send(
      pending ?? {
        id: crypto.randomUUID(),
        prompt: text.trim(),
        context: {
          tabId: tab,
          clipId: selected?.id ?? null,
          frame,
          range: selected ? { from: selected.start, to: selected.start + selected.duration } : null,
          revision: project.revision,
        },
      },
    );
  }
  async function stop() {
    try {
      if (!(await fetch(base + "/" + watch, { method: "DELETE" })).ok) throw new Error();
    } catch {
      setNote("Could not stop the turn. Try again.");
    }
  }
  const target =
    selected?.kind === "text"
      ? selected.text
      : project.timeline.assets.find((a) => selected?.kind === "media" && a.id === selected.assetId)?.name;
  return (
    <div className="codex-chat">
      <div className="codex-messages" ref={bottom} aria-label="Conversation">
        {turns.map((r) => (
          <article key={r.id}>
            <p className="codex-prompt">{r.prompt}</p>
            <ul aria-label="Activity">
              {r.events.map((entry, i) => (
                <li key={i}>{entry.text}</li>
              ))}
            </ul>
            {r.result && <p>{r.result}</p>}
            {r.receipt && <small>Saved revision {r.receipt.revision}</small>}
          </article>
        ))}
      </div>
      <form onSubmit={submit}>
        <label>
          Target · {target ?? project.title}
          <textarea
            aria-label="Ask Codex"
            value={text}
            maxLength={4000}
            placeholder={selected?.kind === "text" ? "Change this title to…" : "Ask about this sequence…"}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {watch ? (
          <button type="button" onClick={() => void stop()}>
            Stop Codex
          </button>
        ) : pending ? (
          <button type="button" disabled={sending || !tab} onClick={() => void send(pending)}>
            Retry request
          </button>
        ) : (
          <button type="submit" disabled={!editable || !tab || sending || !text.trim()}>
            Send to Codex
          </button>
        )}
      </form>
      {note && <p aria-live="polite">{note}</p>}
    </div>
  );
}
