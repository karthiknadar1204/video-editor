import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

export const summary = z.object({ id: z.uuid(), title: z.string(), updatedAt: z.string() });

export async function readProjects<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const cookie = (await cookies()).toString();
  if (!cookie) redirect("/account");
  const api = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";
  const response = await fetch(api + "/api/projects" + path, { headers: { cookie }, cache: "no-store" });
  if (response.status === 401) redirect("/account");
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error("Could not load projects.");
  return schema.parse(await response.json());
}
