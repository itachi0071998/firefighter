import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

let db: DatabaseSync | null = null;
let openPath = '';

const SCHEMA_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'schema.sql');

export function getDb(): DatabaseSync {
  if (db) return db;
  return openDb(config.dbPath);
}

export function openDb(dbPath: string): DatabaseSync {
  if (db && openPath === dbPath) return db;
  if (db) db.close();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const next = new DatabaseSync(dbPath);
  migrate(next);
  next.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  db = next;
  openPath = dbPath;
  return next;
}

/**
 * Bring an existing database up to the current schema before the (idempotent)
 * schema file is applied. `CREATE TABLE IF NOT EXISTS` will not add a column to
 * a table that already exists, so new columns are added here.
 */
function migrate(db: DatabaseSync): void {
  const tableExists = (name: string): boolean =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name) as
      | { name: string }
      | undefined) !== undefined;

  const columns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  if (tableExists('mutations') && !columns('mutations').includes('subject')) {
    db.exec(`ALTER TABLE mutations ADD COLUMN subject TEXT NOT NULL DEFAULT ''`);
    // Older rows predate logical-entity tracking; kind is the best available
    // approximation and keeps duplicate detection conservative.
    db.exec(`UPDATE mutations SET subject = kind WHERE subject = ''`);
  }
}

export function closeDb(): void {
  if (db) db.close();
  db = null;
  openPath = '';
}

export function currentDbPath(): string {
  return openPath || config.dbPath;
}

/** Destroys all state. Used by `npm run reset` and by the eval harness. */
export function resetDb(dbPath = config.dbPath): void {
  closeDb();
  if (dbPath !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }
  openDb(dbPath);
}

export function json<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
