import { details, readProjects } from "../data";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await readProjects("/" + encodeURIComponent(id), details);
  const { width, height, fps } = project.timeline;
  return <main className="library">
    <div className="heading"><h1>{project.title}</h1><span className="format">{width} × {height} · {fps} fps</span></div>
    <section className="empty-editor" aria-label="Project preview">
      <div className="blank-canvas" style={{ aspectRatio: width / height, width: `min(100%, ${width / height * 48}vh)` }} />
    </section>
    <section className="track-summary"><h2>Timeline</h2><span>No clips yet</span></section>
  </main>;
}
