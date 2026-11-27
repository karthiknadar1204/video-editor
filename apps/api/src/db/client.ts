import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL for the API.");
export const db = drizzle(postgres(process.env.DATABASE_URL, { max: 5, idle_timeout: 20, prepare: false }), { schema });
