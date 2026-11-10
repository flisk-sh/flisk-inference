// Storage in a folder: db.json (users, hashed keys, usage) and secret (the cookie signing key). Used by the Bun server.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db, Store } from "./portal";

export function fileStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  const dbFile = join(dataDir, "db.json");
  const secretFile = join(dataDir, "secret");
  return {
    async load(): Promise<Db> { return existsSync(dbFile) ? JSON.parse(readFileSync(dbFile, "utf-8")) : { users: {}, keys: [] }; },
    async save(db: Db) { writeFileSync(`${dbFile}.tmp`, JSON.stringify(db, null, 2)); renameSync(`${dbFile}.tmp`, dbFile); },
    async secret() {
      if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
      return readFileSync(secretFile, "utf-8").trim();
    },
  };
}
