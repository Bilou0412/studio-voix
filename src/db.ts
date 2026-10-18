import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Une seule interface pour Postgres (production) et PGlite (tests, développement local).
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function schemaSql(): string {
  // En build, schema.sql est copié à côté de dist/src/db.js ; en dev, il est à côté de db.ts.
  for (const p of [path.join(here, "schema.sql"), path.join(here, "../../src/schema.sql")]) {
    try {
      return readFileSync(p, "utf8");
    } catch {}
  }
  throw new Error("schema.sql introuvable");
}

export async function openDb(databaseUrl?: string): Promise<Db> {
  let db: Db;
  if (databaseUrl && !databaseUrl.startsWith("pglite:")) {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: databaseUrl, max: 10 });
    db = {
      query: (sql, params) => pool.query(sql, params as any[]) as any,
      close: () => pool.end(),
    };
    await pool.query(schemaSql());
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = databaseUrl?.slice("pglite:".length) || undefined;
    const lite = new PGlite(dir);
    db = {
      query: (sql, params) => lite.query(sql, params as any[]) as any,
      close: () => lite.close(),
    };
    await lite.exec(schemaSql());
  }
  return db;
}
