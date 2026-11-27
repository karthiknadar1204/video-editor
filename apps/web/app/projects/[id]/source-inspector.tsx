import type { SourcePlacement, Timeline, TranscriptMatch, TranscriptWord } from "@editor/timeline";
import { useEffect, useRef, useState, type FormEvent } from "react";

type Details = { status: "queued" | "processing" | "ready" | "failed"; transcriptStatus: string; revision: number; version: string;
  words: TranscriptWord[]; offset: number; total: number; hasOriginal: boolean; hasImport: boolean; timestampsMs: number[] };
type Hits = { revision: number; matches: (TranscriptMatch & { placements: SourcePlacement[] })[]; nextOffset: number | null };
const states: Record<string, string> = { pending: "Transcribing…", transcribed: "Machine transcript", "no-speech": "No speech detected",
  corrected: "Reviewed transcript", imported: "Imported subtitles", unavailable: "Transcription unavailable" };
const quality: Record<TranscriptWord["timing"], string> = { estimated: "Estimated", corrected: "Reviewed", word: "Model timing" };
const seconds = (ms: number) => (ms / 1000).toFixed(2) + " s";

async function checked(response: Response) {
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Could not reach the editor.");
  return response;
}

export function SourceInspector({ projectId, asset, fps, revision, onJump, back }: {
  projectId: string; asset: Timeline["assets"][number]; fps: number; revision: number;
  onJump: (id: string, frame: number) => void; back: () => void;
}) {
  const base = "/api/projects/" + projectId;
  const path = base + "/assets/" + encodeURIComponent(asset.id) + "/analysis";
  const [data, setData] = useState<Details>();
  const [note, setNote] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(0);
  const [view, setView] = useState("active");
  const [editing, setEditing] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [searchBy, setSearchBy] = useState("phrase");
  const [bounds, setBounds] = useState({ from: "", to: "" });
  const [hits, setHits] = useState<Hits>();
  const [searching, setSearching] = useState(false);
  const player = useRef<HTMLMediaElement | null>(null);
  const playback = asset.metadata ? base + "/assets/" + asset.id + "/playback" : "/" + asset.src;
  const searchId = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await checked(await fetch(path + "?offset=" + page + "&view=" + view, { signal: controller.signal, cache: "no-store" }));
        const value: Details = await response.json();
        if (controller.signal.aborted) return;
        setData(value);
        if (value.status === "queued" || value.status === "processing") timer = setTimeout(load, 1300);
      } catch (e) { if (!controller.signal.aborted) setNote(e instanceof Error ? e.message : "Could not load the transcript."); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, refresh, page, view]);
  function resetSearch() { searchId.current++; setSearching(false); setHits(undefined); }
  function changeView(next: string) { setData(undefined); setView(next); setPage(0); setEditing(null); }

  async function mutate(body: object | null) {
    if (saving || !data) return;
    setSaving(true); setNote("");
    try {
      await checked(await fetch(path, { method: body ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ? { ...body, revision: data.revision } : {}) }));
      resetSearch(); setEditing(null);
      if (body && "subtitles" in body) { setView("active"); setPage(0); }
      setRefresh(r => r + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Save failed.");
      setRefresh(r => r + 1); setEditing(null);
    } finally { setSaving(false); }
  }
  async function importFile(file?: File) {
    if (!file) return;
    if (file.size > 1_000_000) { setNote("Choose subtitles under 1 MB."); return; }
    try { await mutate({ subtitles: await file.text() }); }
    catch { setNote("Could not read this subtitle file."); }
  }
  async function find(offset = 0) {
    const validRange = bounds.from !== "" && bounds.to !== "" && Number(bounds.from) >= 0 && Number(bounds.to) > Number(bounds.from);
    if (searchBy === "phrase" ? !phrase.trim() : !validRange) return;
    const query = searchBy === "phrase" ? { phrase: phrase.trim() } : { startMs: Math.round(Number(bounds.from) * 1000), endMs: Math.round(Number(bounds.to) * 1000) };
    const request = ++searchId.current;
    setSearching(true); setNote("");
    try {
      const response = await checked(await fetch(base + "/transcript-search", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: asset.id, ...query, offset }) }));
      const next: Hits = await response.json();
      if (request === searchId.current) setHits(prior => offset && prior ? { ...next, matches: [...prior.matches, ...next.matches] } : next);
    } catch (e) { if (request === searchId.current) setNote(e instanceof Error ? e.message : "Search failed."); }
    finally { if (request === searchId.current) setSearching(false); }
  }
  function audition(ms: number) {
    if (player.current) { player.current.currentTime = ms / 1000; player.current.scrollIntoView({ block: "nearest" }); }
  }
  function saveWord(e: FormEvent<HTMLFormElement>, index: number, word: TranscriptWord) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = String(form.get("word")).trim(), startMs = Number(form.get("start")), endMs = Number(form.get("end"));
    const reviewed = form.has("review") || startMs !== word.startMs || endMs !== word.endMs;
    if (!reviewed && text === word.text) { setEditing(null); return; }
    void mutate({ index, correction: { text, ...(reviewed ? { startMs, endMs } : {}) } });
  }

  return <section className="source-inspector" aria-label="Source inspector">
    <button onClick={back}>‹ Media library</button>
    <h3>{asset.name}</h3>
    {asset.metadata?.mediaType === "audio"
      ? <audio ref={el => { player.current = el; }} controls preload="metadata" aria-label="Original source playback" src={playback} />
      : <video ref={el => { player.current = el; }} controls playsInline preload="metadata" aria-label="Original source playback" src={playback} />}
    {data?.timestampsMs.length ? <figure><img src={path + "/sheet"} alt="Source contact sheet" />
      <figcaption>Original footage · {data.timestampsMs.length} timestamped stills</figcaption></figure> : null}
    {note && <p role="status">{note} <button onClick={() => setRefresh(r => r + 1)}>Reload</button></p>}
    {!data ? <p>Loading source…</p> : <>
      <header><h4>Transcript</h4><span>{states[data.transcriptStatus] ?? data.transcriptStatus}</span></header>
      {data.status === "failed" && <p>Part of the source analysis could not finish. <button disabled={saving} onClick={() => void mutate(null)}>Retry analysis</button></p>}
      <div className="source-actions"><label>Import subtitles<input type="file" accept=".srt,.vtt,text/vtt" disabled={saving} onChange={e => {
        const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; void importFile(file);
      }} /></label>
      <label>Transcript version<select value={view} onChange={e => changeView(e.target.value)}>
        <option value="active">Current transcript</option>{data.hasOriginal && <option value="original">Original transcription</option>}
        {data.hasImport && <option value="imported">Imported subtitles</option>}</select></label></div>
      {data.total > 0 && <><p>{data.total} words · Select a word to inspect its timing. Imported line timings are estimates.</p>
        <div className="source-words" aria-label="Transcript words">{data.words.map((word, i) =>
          <button key={i} title={seconds(word.startMs) + " · " + quality[word.timing]} aria-label={"Edit word " + (page + i + 1)}
            aria-pressed={editing === i} onClick={() => { audition(word.startMs); setEditing(i); }}>{word.text}</button>)}</div>
        {editing !== null && data.words[editing] && <form className="source-word-form" key={page + ":" + editing + ":" + data.revision}
          onSubmit={e => saveWord(e, page + editing, data.words[editing])}>
          <small>{quality[data.words[editing].timing]} · source time</small>
          <fieldset disabled={view !== "active" || saving}><label>Word<input name="word" required maxLength={500} defaultValue={data.words[editing].text} /></label>
            <label>Start (ms)<input type="number" name="start" min="0" required defaultValue={data.words[editing].startMs} /></label>
            <label>End (ms)<input type="number" name="end" min="1" required defaultValue={data.words[editing].endMs} /></label>
            <label className="source-review"><input type="checkbox" name="review" />I reviewed both boundaries</label>
            {view === "active" && <button type="submit">Save correction</button>}</fieldset>
        </form>}
        {data.total > 60 && <nav aria-label="Transcript pages"><button disabled={!page} onClick={() => { setPage(page - 60); setEditing(null); setData(undefined); }}>Previous words</button>
          <span>{page + 1}–{Math.min(page + 60, data.total)}</span><button disabled={page + 60 >= data.total} onClick={() => { setPage(page + 60); setEditing(null); setData(undefined); }}>Next words</button></nav>}</>}
      <form className="source-search" onSubmit={e => { e.preventDefault(); void find(); }}>
        <label>Search by<select value={searchBy} onChange={e => { setSearchBy(e.target.value); resetSearch(); }}>
          <option value="phrase">Phrase</option><option value="time">Source time</option></select></label>
        {searchBy === "phrase" ? <label>Find a phrase<input required value={phrase} maxLength={500} onChange={e => { setPhrase(e.target.value); resetSearch(); }} placeholder="Search the current transcript" /></label>
          : <><label>From (seconds)<input required type="number" min="0" step="0.001" value={bounds.from}
            onChange={e => { setBounds({ ...bounds, from: e.target.value }); resetSearch(); }} /></label>
          <label>To (seconds)<input required type="number" min={(Number(bounds.from) || 0) + 0.001} step="0.001" value={bounds.to}
            onChange={e => { setBounds({ ...bounds, to: e.target.value }); resetSearch(); }} /></label></>}
        <button disabled={searching || (searchBy === "phrase" && !phrase.trim())}>Search transcript</button>
      </form>
      {hits && <div className="source-hits" aria-live="polite">{hits.matches.length ? hits.matches.map(hit => <section key={hit.firstWord + "-" + hit.lastWord}>
        <strong>{hit.text}</strong><small>Source {seconds(hit.startMs)}–{seconds(hit.endMs)} · {quality[hit.timing]}</small>
        {hit.placements.length ? hit.placements.map(p => <button key={p.clipId} disabled={revision !== hits.revision}
          aria-label={"Show " + p.track + " at frame " + p.startFrame + " on timeline"} onClick={() => onJump(p.clipId, p.startFrame)}>
          {p.track} · {seconds(p.startFrame * 1000 / fps)} ↗</button>) : <small>No surviving use on this timeline.</small>}
      </section>) : <p>{data.transcriptStatus === "pending" ? "The source transcript is still processing." : "No matching passage."}</p>}
        {hits.revision !== revision && <p>The timeline changed. Search again for current positions.</p>}
        {hits.nextOffset !== null && <button disabled={searching} onClick={() => void find(hits.nextOffset!)}>More matches</button>}</div>}
      <details><summary>Analysis and privacy</summary><p>{data.version}</p><p>Codex can request transcript passages and source or timeline stills. Original audio and video stay in media storage.</p></details>
    </>}
  </section>;
}
