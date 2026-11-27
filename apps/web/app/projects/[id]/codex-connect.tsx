import { useEffect, useRef, useState } from "react";
import { z } from "zod";

const connection = z.object({
  connected: z.boolean(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  key: z.string().optional(),
});
export function CodexConnect({ id, close }: { id: string; close: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<z.infer<typeof connection>>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const path = "/api/projects/" + id + "/connection";
  useEffect(() => {
    box.current?.showModal();
    const cancel = new AbortController();
    void fetch(path, { cache: "no-store", signal: cancel.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        setState(connection.parse(await r.json()));
      })
      .catch(() => {
        if (!cancel.signal.aborted) setNote("Could not load the connection.");
      });
    return () => cancel.abort();
  }, [path]);
  async function change(method: "POST" | "DELETE") {
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      if (!response.ok) throw new Error();
      setState(connection.parse(await response.json()));
      if (method === "DELETE") setNote("Project key revoked.");
    } catch {
      setNote("Could not update the connection. Reopen to check its status.");
    } finally {
      setBusy(false);
    }
  }
  async function copy(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setNote("Key copied.");
    } catch {
      setNote("Select the project key and copy it.");
    }
  }
  return (
    <dialog ref={box} className="media-dialog codex-connect" aria-label="Connect Codex" onCancel={close}>
      <header className="studio-panel-title">
        <h2>Connect Codex</h2>
        <button onClick={close} aria-label="Close connection">
          ×
        </button>
      </header>
      <div className="connect-body">
        <p>Give an external Codex client access to this project.</p>
        {state && (
          <>
            <p>
              {state.connected ? "Project key active" : "No active project key"}
              {state.lastUsedAt && " · Last connected " + new Date(state.lastUsedAt).toLocaleString()}
            </p>
            {state.key && (
              <label>
                Project key
                <input readOnly value={state.key} onFocus={(e) => e.target.select()} />
                <small>Copy this key now. It is shown once.</small>
              </label>
            )}
            {state.connected && (
              <>
                <p>
                  Set <code>CUTROOM_MCP_KEY</code> in the environment where you run Codex, then add the server.
                </p>
                <pre>
                  codex mcp add cutroom --url {window.location.origin}/api/mcp --bearer-token-env-var
                  CUTROOM_MCP_KEY
                </pre>
                <small>Expires {state.expiresAt && new Date(state.expiresAt).toLocaleDateString()}.</small>
              </>
            )}
            <div>
              {state.key && <button onClick={() => void copy(state.key!)}>Copy key</button>}
              <button disabled={busy} onClick={() => void change(state.connected ? "DELETE" : "POST")}>
                {state.connected ? "Revoke project key" : "Create project key"}
              </button>
            </div>
          </>
        )}
        {note && <p aria-live="polite">{note}</p>}
      </div>
    </dialog>
  );
}
