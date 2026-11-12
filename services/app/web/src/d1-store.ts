// The portal's storage on Cloudflare D1 (migrations/0002_tables.sql). Every write is one statement (or one batch) that
// changes one row or adds to a counter, so overlapping requests cannot undo each other.
import type { Db, Key, Store, User } from "./portal";

export interface D1Statement { bind(...v: unknown[]): D1Statement; first<T>(): Promise<T | null>; run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> }
export interface D1 { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<unknown> }

interface KeyRow { id: string; user_id: string; name: string; hash: string; prefix: string; last4: string; created: string; last_used: string | null; requests: number; input: number; output: number; revoked: number }

export function d1Store(db: D1, secret: () => string): Store {
  const run = (sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v).run();
  return {
    async load(): Promise<Db> {
      const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
      const [users, keys, days, totals] = await Promise.all([
        db.prepare("SELECT id, login, name, avatar, created FROM users").bind().all<User>(),
        db.prepare("SELECT id, user_id, name, hash, prefix, last4, created, last_used, requests, input, output, revoked FROM keys").bind().all<KeyRow>(),
        db.prepare("SELECT key_id, day, requests, input, output FROM key_days WHERE day >= ?").bind(day(30)).all<{ key_id: string; day: string; requests: number; input: number; output: number }>(),
        db.prepare("SELECT day, requests, neurons FROM day_totals WHERE day >= ?").bind(day(7)).all<{ day: string; requests: number; neurons: number }>(),
      ]);
      const byKey = new Map<string, Key["daily"]>();
      for (const d of days.results) {
        const m = byKey.get(d.key_id) ?? {};
        m[d.day] = { requests: d.requests, input: d.input, output: d.output };
        byKey.set(d.key_id, m);
      }
      return {
        users: Object.fromEntries(users.results.map((u) => [u.id, u])),
        keys: keys.results.map((k) => ({ id: k.id, userId: k.user_id, name: k.name, hash: k.hash, prefix: k.prefix, last4: k.last4, created: k.created, lastUsed: k.last_used, requests: k.requests, input: k.input, output: k.output, revoked: k.revoked === 1, daily: byKey.get(k.id) ?? {} })),
        total: Object.fromEntries(totals.results.map((t) => [t.day, t.requests])),
        neurons: Object.fromEntries(totals.results.map((t) => [t.day, Math.round(t.neurons)])),
      };
    },
    async secret() { return secret(); },
    async putUser(u: User) {
      await run("INSERT INTO users (id, login, name, avatar, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar = excluded.avatar", u.id, u.login, u.name, u.avatar, u.created);
    },
    async addKey(k: Key) {
      await run("INSERT OR IGNORE INTO keys (id, user_id, name, hash, prefix, last4, created, last_used, requests, input, output, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0)", k.id, k.userId, k.name, k.hash, k.prefix, k.last4, k.created);
    },
    async revokeKey(id: string) {
      await run("UPDATE keys SET revoked = 1 WHERE id = ?", id);
    },
    async recordUse(keyId, day, use) {
      const prune = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
      await db.batch([
        db.prepare("UPDATE keys SET requests = requests + 1, input = input + ?, output = output + ?, last_used = ? WHERE id = ?").bind(use.input, use.output, new Date().toISOString(), keyId),
        db.prepare("INSERT INTO key_days (key_id, day, requests, input, output) VALUES (?, ?, 1, ?, ?) ON CONFLICT(key_id, day) DO UPDATE SET requests = requests + 1, input = input + excluded.input, output = output + excluded.output").bind(keyId, day, use.input, use.output),
        db.prepare("INSERT INTO day_totals (day, requests, neurons) VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET requests = requests + 1, neurons = neurons + excluded.neurons").bind(day, use.neurons),
        db.prepare("DELETE FROM day_totals WHERE day < ?").bind(prune),
      ]);
    },
  };
}
