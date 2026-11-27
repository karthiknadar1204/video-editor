import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const workerDir = fileURLToPath(new URL("./", import.meta.url));
export const renderDir = process.env.CUTROOM_RENDER_DIR ?? fileURLToPath(new URL("../../.renders/", import.meta.url));
export const exportFile = join(renderDir, "earthrise.mp4");
export const projectExportDir = (id: string) => join(renderDir, "projects", id);
