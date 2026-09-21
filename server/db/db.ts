/**
 * JafariPay — Thin wrappers around Bun SQLite for ergonomic DB access
 */

import { getDb } from './schema.js';

export interface Row {
  [key: string]: unknown;
}

export function dbQuery<T = Row>(sql: string, params: (string | number | null | undefined)[] = []): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.all(...params) as T[];
}

export function dbGet<T = Row>(sql: string, params: (string | number | null | undefined)[] = []): T | undefined {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.get(...params) as T | undefined;
}

export function dbRun(sql: string, params: (string | number | null | undefined)[] = []): void {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.run(...params);
}

export function dbTransaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}
