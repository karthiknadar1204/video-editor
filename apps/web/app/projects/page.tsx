import { readProjects, summary } from "./data";
import { NewProject } from "./new-project";

export default async function Dashboard() {
  const projects = await readProjects("", summary.array());
  return <main className="library">
    <div className="heading"><h1>My projects</h1><NewProject /></div>
    {projects.length === 0
      ? <section className="empty-library"><h2>No projects yet</h2><p>Create your first project to open a blank timeline.</p><a href="/">Explore the sample film ↗</a></section>
      : <ul className="project-list">{projects.map((p) => <li key={p.id}>
          <a href={"/projects/" + p.id}><strong>{p.title}</strong>
            <span>Edited <time dateTime={p.updatedAt}>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(p.updatedAt))}</time></span>
          </a>
        </li>)}</ul>}
  </main>;
}
