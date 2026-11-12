// Storage in a folder: db.json (users, hashed keys, usage) and secret (the cookie signing key). Used by the Bun server.
// One process owns the folder, so every change runs one after another (`tx`): each reads the file, changes one thing and
// writes it, with no other change in between.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db, Store } from "./portal";

export function fileStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  const dbFile = join(dataDir, "db.json");
  const secretFile = join(dataDir, "secret");
  const read = (): Db => (existsSync(dbFile) ? JSON.parse(readFileSync(dbFile, "utf-8")) : { users: {}, keys: [] });
  const write = (db: Db) => { writeFileSync(`${dbFile}.tmp`, JSON.stringify(db, null, 2)); renameSync(`${dbFile}.tmp`, dbFile); };
  let chain: Promise<unknown> = Promise.resolve();
  const tx = <T>(f: (db: Db) => T): Promise<T> => {
    const run = chain.then(() => { const db = read(); const out = f(db); write(db); return out; });
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    async load(): Promise<Db> { await chain; return read(); },
    putUser: (u) => tx((db) => { db.users[u.id] = { ...u, created: db.users[u.id]?.created ?? u.created }; }),
    addKey: (k) => tx((db) => { db.keys.push(k); }),
    revokeKey: (id) => tx((db) => { const k = db.keys.find((x) => x.id === id); if (k) k.revoked = true; }),
    recordUse: (keyId, day, use) => tx((db) => {
      const k = db.keys.find((x) => x.id === keyId);
      if (k) {
        k.requests++; k.input += use.input; k.output += use.output; k.lastUsed = new Date().toISOString();
        const d = ((k.daily ??= {})[day] ??= { requests: 0, input: 0, output: 0 });
        d.requests++; d.input += use.input; d.output += use.output;
      }
      (db.total ??= {})[day] = (db.total[day] ?? 0) + 1;
      if (use.neurons) {
        (db.neurons ??= {})[day] = Math.round((db.neurons[day] ?? 0) + use.neurons);
        // Keep a week of neuron days.
        for (const x of Object.keys(db.neurons)) if (x < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) delete db.neurons[x];
      }
    }),
    async secret() {
      if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
      return readFileSync(secretFile, "utf-8").trim();
    },
  };
}
