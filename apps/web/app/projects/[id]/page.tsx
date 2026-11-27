import { projectSnapshot } from "@editor/timeline";
import { readProjects } from "../data";
import { Editor } from "./editor";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await readProjects("/" + encodeURIComponent(id), projectSnapshot);
  return <Editor key={id} initial={project} />;
}
