"use client";

import { projectSnapshot, type Change, type EditRequest, type ProjectSnapshot } from "@editor/timeline";
import { useCallback, useEffect, useRef, useState } from "react";

export function useTimeline(initial: ProjectSnapshot) {
  const path = "/api/projects/" + initial.id;
  const [project, setProject] = useState(initial);
  const revision = useRef(initial.revision);
  const notified = useRef(initial.revision);
  const dirty = useRef(false);
  const sending = useRef(false);
  const pending = useRef<EditRequest | null>(null);
  const [status, setStatus] = useState<"opening" | "ready" | "saving" | "retry" | "conflict">("opening");
  const [message, setMessage] = useState("");
  const [formVersion, setFormVersion] = useState(0);

  const refresh = useCallback(async (discardDraft = false) => {
    const res = await fetch(path, { cache: "no-store" });
    if (res.status === 401) { window.location.assign("/account"); return; }
    if (!res.ok) throw new Error("Could not load the timeline.");
    const next = projectSnapshot.parse(await res.json());
    if (next.revision < revision.current) return;
    if (!discardDraft && (sending.current || pending.current)) return;
    if (!discardDraft && dirty.current) {
      if (next.revision > revision.current) setStatus("conflict");
      return;
    }
    revision.current = next.revision;
    setProject(next);
    if (discardDraft) {
      dirty.current = false;
      setFormVersion(n => n + 1);
      setStatus("ready");
      setMessage("");
    }
  }, [path]);

  useEffect(() => {
    setStatus("ready");
    const events = new EventSource(path + "/events?since=" + revision.current);
    function sync() {
      void refresh().catch(() => setMessage("Could not sync the timeline. Reload to reconnect."));
    }
    events.onopen = sync;
    events.addEventListener("revision", event => {
      notified.current = Math.max(notified.current, Number(event.data));
      if (notified.current > revision.current) sync();
    });
    events.addEventListener("access-ended", () => { events.close(); window.location.assign("/account"); });
    return () => events.close();
  }, [path, refresh]);

  async function submit(command: EditRequest) {
    if (sending.current) return false;
    sending.current = true;
    pending.current = command;
    setStatus("saving");
    setMessage("");
    try {
      const response = await fetch(path + "/edits", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
      });
      if (response.status === 401) { window.location.assign("/account"); return false; }
      if (!response.ok && response.status < 500) {
        const body = await response.json();
        pending.current = null;
        setMessage(body.error);
        setStatus(response.status === 409 ? "conflict" : "ready");
        return false;
      }
      if (!response.ok) throw new Error("Save unavailable.");
      await refresh(true);
      pending.current = null;
      return true;
    } catch {
      setStatus("retry");
      setMessage("Save could not be confirmed. Retry to check this exact edit.");
      return false;
    } finally {
      sending.current = false;
      if (!pending.current && notified.current > revision.current) {
        void refresh().catch(() => setMessage("Could not sync the timeline. Reload to reconnect."));
      }
    }
  }

  function save(action: Change[] | "undo" | "redo") {
    if (status !== "ready" || pending.current) return Promise.resolve(false);
    const base = { requestId: crypto.randomUUID(), expectedRevision: revision.current };
    return submit(typeof action === "string" ? { ...base, kind: action } : { ...base, kind: "edit", operations: action });
  }

  return { project, status, message, save, formVersion, markDirty: () => { dirty.current = true; },
    retry: () => pending.current && submit(pending.current),
    reload: () => refresh(true).catch(() => setMessage("Could not reload. Try again.")),
  };
}
