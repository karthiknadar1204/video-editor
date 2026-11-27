"use client";

import { Film } from "@editor/composition";
import { roughCutReceiptSchema, timelineSchema, type Clip, type ProjectSnapshot } from "@editor/timeline";
import { Player } from "@remotion/player";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import "./rough-cut-review.css";

const summarySchema = z.object({
  id: z.uuid(),
  baseRevision: z.int(),
  committedRevision: z.int().nullable(),
  status: z.enum(["draft", "applied", "undone"]),
  receipt: roughCutReceiptSchema,
  restoredIds: z.array(z.string()),
  canUndoReview: z.boolean(),
});
const detailSchema = summarySchema.extend({ before: timelineSchema, after: timelineSchema });
type Summary = z.infer<typeof summarySchema>;
type Detail = z.infer<typeof detailSchema>;
const listSchema = z.object({ reviews: z.array(summarySchema) });
const seconds = (frames: number, fps: number) => Number((frames / fps).toFixed(2)) + " s";

function label(review: Summary, fps: number) {
  const { pauseCount, repeatCount, removedFrames, captionCount } = review.receipt;
  return (
    [
      pauseCount > 0 && pauseCount + " " + (pauseCount === 1 ? "pause" : "pauses"),
      repeatCount > 0 && repeatCount + " repeated " + (repeatCount === 1 ? "take" : "takes"),
      removedFrames > 0 && seconds(removedFrames, fps) + " saved",
      captionCount > 0 && captionCount + " " + (captionCount === 1 ? "caption" : "captions"),
    ]
      .filter(Boolean)
      .join(" · ") || "No changes"
  );
}

async function api(path: string, body?: object) {
  const response = await fetch(
    path,
    body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { cache: "no-store" },
  );
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "Could not load the rough cut.");
  return result;
}

export function RoughCutReview({
  project,
  selected,
  editable,
  onChange,
}: {
  project: ProjectSnapshot;
  selected?: Clip;
  editable: boolean;
  onChange: () => Promise<void>;
}) {
  const base = "/api/projects/" + project.id + "/rough-cuts";
  const [recent, setRecent] = useState<Summary>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    void api(base)
      .then((value) => {
        const applied = listSchema.parse(value).reviews.find((r) => r.status === "applied");
        if (current) setRecent(applied);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [base, project.revision, open]);
  return (
    <>
      <button
        className="rough-cut-open"
        aria-label={"Open rough-cut review" + (recent ? " · " + label(recent, project.timeline.fps) : "")}
        onClick={() => setOpen(true)}
        disabled={!editable}
      >
        {recent ? label(recent, project.timeline.fps) : "Rough cuts"}
      </button>
      {open && (
        <ReviewDialog
          base={base}
          initialId={recent?.id}
          project={project}
          selected={selected}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ReviewDialog({
  base,
  initialId,
  project,
  selected,
  onChange,
  onClose,
}: {
  base: string;
  initialId?: string;
  project: ProjectSnapshot;
  selected?: Clip;
  onChange: () => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reviews, setReviews] = useState<Summary[]>([]);
  const [review, show] = useState<Detail>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [cutId, choose] = useState("");
  const [comparison, play] = useState<{ side: "before" | "after"; attempt: number; at?: number } | null>(null);
  const [composing, compose] = useState(false);
  const [captionStyle, setCaptionStyle] = useState("readable");
  const optionsTarget =
    selected?.kind === "media" ? { clipId: selected.id } : { from: 0, to: project.timeline.durationInFrames };
  const retryIds = useRef(new Map<string, string>());
  const getId = (key: string) => {
    let id = retryIds.current.get(key);
    if (!id) {
      id = crypto.randomUUID();
      retryIds.current.set(key, id);
    }
    return id;
  };
  async function load(id?: string) {
    const { reviews } = listSchema.parse(await api(base));
    const target = id ?? reviews[0]?.id;
    if (target) {
      const detail = detailSchema.parse(await api(base + "/" + target));
      show(detail);
      choose((previous) =>
        detail.receipt.cuts.some((c) => c.id === previous) ? previous : (detail.receipt.cuts[0]?.id ?? ""),
      );
    } else show(undefined);
    setReviews(reviews);
    play(null);
    compose(!target);
  }
  useEffect(() => {
    dialog.current?.showModal();
    setBusy(true);
    void load(initialId)
      .catch((e) => setNote(e.message))
      .finally(() => setBusy(false));
  }, [base]);
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      await work();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not complete this action.");
    } finally {
      setBusy(false);
    }
  }
  async function prepare(form: FormData) {
    const options = {
      target: optionsTarget,
      pauseThresholdMs: Number(form.get("pause")),
      breathingRoomMs: Number(form.get("room")),
      repetitions: form.get("repetitions"),
      keepPhrases: String(form.get("phrases") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      captions:
        captionStyle === "off"
          ? false
          : { style: captionStyle, font: form.get("font"), color: form.get("color"), placement: form.get("placement") },
    };
    const body = await api(base, { options, requestId: getId(JSON.stringify([project.revision, options])) });
    await load((body.review ?? body).id);
  }
  async function change(action: "commit" | "restore" | "undo") {
    if (!review) return;
    const revision = action === "commit" ? review.baseRevision : project.revision;
    const result = await api(base + "/" + review.id + "/" + action, {
      expectedRevision: revision,
      ...(action === "restore" ? { cutId } : {}),
      ...(action !== "commit" ? { requestId: getId([review.id, action, cutId, revision].join("/")) } : {}),
    });
    await onChange();
    await load(result?.review?.id ?? review.id);
    if (result?.rebased) setNote("The sequence changed. Review the recalculated candidate before applying it.");
  }
  const cut = review?.receipt.cuts.find((c) => c.id === cutId);
  const fps = project.timeline.fps;
  const timeline = comparison?.side === "before" ? review?.before : review?.after;
  const seam =
    comparison?.at ??
    (comparison?.side === "before"
      ? (cut?.from ?? review?.receipt.previewFrames[0] ?? 0)
      : (cut?.at ?? review?.receipt.previewFrames[0] ?? 0));
  const captions = review?.after.clips.filter((c) => c.kind === "text" && c.caption?.reviewId === review.id) ?? [];
  const nextCaption = captions.find((c) => c.start > seam) ?? captions[0];
  const start = timeline ? Math.min(timeline.durationInFrames - 1, Math.max(0, seam - fps)) : 0;
  const end = timeline
    ? Math.min(timeline.durationInFrames - 1, (comparison?.side === "before" ? (cut?.to ?? seam) : seam) + fps)
    : 0;
  const audition = (side: "before" | "after", at?: number) =>
    play((prev) => ({ side, at, attempt: (prev?.attempt ?? 0) + 1 }));
  return (
    <dialog ref={dialog} className="rough-cut-dialog" aria-labelledby="rough-cut-heading" onCancel={onClose}>
      <header className="studio-panel-title">
        <h2 id="rough-cut-heading">Rough-cut review</h2>
        <button aria-label="Close rough-cut review" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="rough-cut-body">
        <div className="rough-cut-controls">
          {reviews.length > 0 && (
            <label>
              Review
              <select
                aria-label="Choose rough cut"
                value={composing ? "" : (review?.id ?? "")}
                disabled={busy}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  if (id) void run(() => load(id));
                  else compose(true);
                }}
              >
                <option value="">New rough cut</option>
                {reviews.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.status === "draft" ? "Candidate" : r.status === "undone" ? "Undone" : "Applied"} · r
                    {r.committedRevision ?? r.baseRevision} · {label(r, fps)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!composing && review && (
            <button
              disabled={busy}
              onClick={() => {
                compose(true);
                play(null);
              }}
            >
              New rough cut
            </button>
          )}
        </div>
        {composing && (
          <form
            className="rough-cut-options"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void run(() => prepare(form));
            }}
          >
            <p>
              {selected?.kind === "media" ? "Selected clip" : "Entire sequence"} ·{" "}
              {seconds(selected?.kind === "media" ? selected.duration : project.timeline.durationInFrames, fps)}
            </p>
            <label>
              Minimum pause (ms)
              <input type="number" name="pause" min={100} max={60000} required defaultValue={1000} />
            </label>
            <label>
              Breathing room (ms)
              <input type="number" name="room" min={0} max={5000} required defaultValue={120} />
            </label>
            <label>
              Repeated takes
              <select name="repetitions" defaultValue="flag">
                <option value="flag">Flag for review</option>
                <option value="keep">Keep all</option>
                <option value="remove">Remove clear duplicates</option>
              </select>
            </label>
            <label>
              Captions
              <select value={captionStyle} onChange={(e) => setCaptionStyle(e.target.value)}>
                <option value="readable">Readable</option>
                <option value="highlight">Word highlight</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label>
              Keep these phrases
              <input name="phrases" placeholder="Separate phrases with commas" />
            </label>
            {captionStyle !== "off" && (
              <details className="caption-appearance">
                <summary>Caption appearance</summary>
                <div>
                  <label>
                    Font
                    <select name="font" defaultValue="sans">
                      <option value="sans">Sans serif</option>
                      <option value="serif">Serif</option>
                      <option value="mono">Monospace</option>
                    </select>
                  </label>
                  <label>
                    Placement
                    <select name="placement" defaultValue="bottom">
                      <option value="top">Top</option>
                      <option value="center">Center</option>
                      <option value="bottom">Bottom</option>
                    </select>
                  </label>
                  <label>
                    Caption colour
                    <input type="color" name="color" defaultValue="#ffffff" />
                  </label>
                </div>
              </details>
            )}
            <button className="studio-primary" disabled={busy || !project.timeline.durationInFrames}>
              Preview rough cut
            </button>
          </form>
        )}
        {!composing && review && (
          <>
            <div className="rough-cut-heading">
              <small>
                {review.status === "draft" ? "Candidate" : review.status === "undone" ? "Undone" : "Applied"} · revision{" "}
                {review.committedRevision ?? review.baseRevision}
              </small>
              <h3>{label(review, fps)}</h3>
            </div>
            {review.receipt.flags.length > 0 && (
              <details>
                <summary>{review.receipt.flags.length} flagged for review</summary>
                <ul>
                  {review.receipt.flags.map((f, i) => (
                    <li key={i}>
                      {f.text} · {f.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {review.receipt.cuts.length > 0 && (
              <label>
                Passage
                <select
                  aria-label="Choose passage"
                  value={cutId}
                  onChange={(e) => {
                    choose(e.target.value);
                    play(null);
                  }}
                >
                  {review.receipt.cuts.map((c, i) => (
                    <option key={c.id} value={c.id}>
                      {i + 1}. {c.kind === "pause" ? "Pause" : "Repeated take"} · {seconds(c.from, fps)}–
                      {seconds(c.to, fps)}
                      {review.restoredIds.includes(c.id) ? " · Restored" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {cut?.text && <p className="rough-cut-passage">“{cut.text}”</p>}
            <div className="rough-cut-actions">
              <button onClick={() => audition("before")}>Play before</button>
              <button onClick={() => audition("after")}>Play after</button>
              {nextCaption && <button onClick={() => audition("after", nextCaption.start)}>Play next caption</button>}
            </div>
            {comparison && timeline && timeline.durationInFrames > 0 && (
              <section
                className="rough-cut-player"
                aria-label={comparison.side === "before" ? "Before excerpt" : "After excerpt"}
              >
                <span>
                  {comparison.side === "before" ? "Before" : "After"} · {seconds(start, fps)}–{seconds(end + 1, fps)}
                </span>
                <Player
                  key={comparison.attempt}
                  component={Film}
                  inputProps={{ timeline }}
                  fps={timeline.fps}
                  compositionWidth={timeline.width}
                  compositionHeight={timeline.height}
                  durationInFrames={timeline.durationInFrames}
                  inFrame={start}
                  outFrame={end}
                  initialFrame={start}
                  controls
                  autoPlay
                  style={{ width: "100%", aspectRatio: timeline.width / timeline.height }}
                />
              </section>
            )}
            <div className="rough-cut-actions">
              {review.status === "draft" && (
                <button className="studio-primary" disabled={busy} onClick={() => void run(() => change("commit"))}>
                  Apply rough cut
                </button>
              )}
              {review.status === "applied" && cut && (
                <button
                  disabled={busy || review.restoredIds.includes(cut.id)}
                  onClick={() => void run(() => change("restore"))}
                >
                  {review.restoredIds.includes(cut.id) ? "Passage restored" : "Restore this passage"}
                </button>
              )}
              {review.canUndoReview && (
                <button disabled={busy} onClick={() => void run(() => change("undo"))}>
                  Undo this edit
                </button>
              )}
            </div>
          </>
        )}
        {busy && <p role="status">Loading review…</p>}
        {note && <p role="alert">{note}</p>}
      </div>
    </dialog>
  );
}
