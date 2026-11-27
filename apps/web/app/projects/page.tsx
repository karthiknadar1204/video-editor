import { readProjects, summary } from "./data";
import { NewProject } from "./new-project";

export default async function Dashboard() {
  const projects = await readProjects("", summary.array());
  return <main className="library">
    <div className="heading"><h1>My projects</h1><NewProject /></div>
    <a className="library-feature" href="/" aria-label="Explore the Earthrise sample film">
      <img src="/media/earthrise-cover.jpg" alt="" />
      <div><p className="eyebrow">Sample film <span>/</span> Apollo 8</p><strong>Earthrise</strong><small>Explore the sequence <span aria-hidden="true">↗</span></small></div>
      <span className="feature-duration">00:10</span>
    </a>
    {projects.length === 0
      ? <section className="empty-library"><span className="sequence-mark" aria-hidden="true" /><div><h2>No projects yet</h2><p>Create a project to add footage and make your first cut.</p></div></section>
      : <section className="recent-projects"><h2>Recently edited <span>{projects.length}</span></h2><ul className="project-list">{projects.map((p) => <li key={p.id}>
          <a href={"/projects/" + p.id}><span className="sequence-mark" aria-hidden="true" /><strong>{p.title}</strong>
            <small>Edited <time dateTime={p.updatedAt}>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(p.updatedAt))}</time></small><span aria-hidden="true">↗</span>
          </a>
        </li>)}</ul></section>}
  </main>;
}
