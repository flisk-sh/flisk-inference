import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type D1, d1Store } from "../src/d1-store";
import { fileStore } from "../src/file-store";
import { createPortal, type GithubUser, type Store } from "../src/portal";

const BASE = "http://portal.test";
const ME: GithubUser = { id: 4242, login: "octocat", name: "Octo Cat" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const migration = (n: string) => readFileSync(join(import.meta.dir, "..", "migrations", n), "utf-8");

// D1's shape over bun:sqlite. A batch is one transaction, as on D1.
function sqliteD1(sql: Database): D1 {
  const stmt = (q: string, v: unknown[] = []): ReturnType<D1["prepare"]> => ({
    bind: (...args: unknown[]) => stmt(q, args),
    first: async <T>() => (sql.query(q).get(...(v as never[])) as T | null) ?? null,
    run: async () => { sql.query(q).run(...(v as never[])); return {}; },
    all: async <T>() => ({ results: sql.query(q).all(...(v as never[])) as T[] }),
  });
  return {
    prepare: (q) => stmt(q),
    batch: async (list) => { sql.transaction(() => { for (const s of list) (s as unknown as { run(): void }).run(); })(); },
  };
}

// Every store call waits first, so two requests really overlap: this is what a slow D1 round trip does.
// `onRecordUse` runs the moment a call starts saving its usage, so a request can be made to land exactly then.
function slow(store: Store, ms = 15, onRecordUse?: () => void): Store {
  return {
    load: async () => { await sleep(ms); const db = await store.load(); await sleep(ms); return db; },
    secret: () => store.secret(),
    putUser: async (u) => { await sleep(ms); return store.putUser(u); },
    addKey: async (k) => { await sleep(ms); return store.addKey(k); },
    revokeKey: async (id) => { await sleep(ms); return store.revokeKey(id); },
    recordUse: async (...a) => { onRecordUse?.(); await sleep(ms); return store.recordUse(...a); },
  };
}

function portalOn(store: Store, upstreamMs: number) {
  return createPortal({
    publicUrl: BASE,
    upstreamUrl: "http://upstream.test",
    store,
    indexHtml: () => "<html></html>",
    devLogin: async () => ME,
    dailyLimit: 1000,
    fetchImpl: (async () => {
      await sleep(upstreamMs);
      return new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
}
const req = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  new Request(BASE + path, { ...init, headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
const chat = (key: string) => req("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [] }) });

async function scenario(store: Store) {
  let during: Promise<unknown> = Promise.resolve();
  let revoke: () => Promise<Response> = async () => new Response();
  const p = portalOn(slow(store, 15, () => { during = Promise.all([revoke(), makeB()]); }), 10);
  const cookie = ((await p.fetch(req("/auth/dev"))).headers.get("set-cookie") ?? "").split(";")[0];
  const post = (name: string) => p.fetch(req("/api/keys", { method: "POST", cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).then((r) => r.json() as Promise<{ id: string; key: string }>);
  let b: { id: string; key: string } | undefined;
  const makeB = async () => { b = await post("b"); };
  const a = await post("a");
  revoke = () => p.fetch(req(`/api/keys/${a.id}`, { method: "DELETE", cookie }));

  // The call finishes its (slow) model request and starts saving its usage; at that moment the key is revoked and
  // another key is created. Neither may be undone by the call's save.
  expect((await p.fetch(chat(a.key))).status).toBe(200);
  await during;
  expect(b).toBeDefined();

  const db = await store.load();
  expect(db.keys.find((k) => k.id === a.id)?.revoked).toBe(true);
  expect(db.keys.some((k) => k.id === b?.id)).toBe(true);
  expect(db.keys.find((k) => k.id === a.id)?.requests).toBe(1); // and the call itself was counted
  expect((await p.fetch(chat(a.key))).status).toBe(401);
}

describe("a revoke or a new key survives a model call in flight", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "race-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("with the file store", async () => {
    await scenario(fileStore(dir));
  });

  it("with the D1 store", async () => {
    const sql = new Database(":memory:");
    sql.exec(migration("0001_kv.sql"));
    sql.exec(migration("0002_tables.sql"));
    await scenario(d1Store(sqliteD1(sql), () => "test-secret"));
  });
});

describe("usage is added to, never overwritten", () => {
  it("counts every one of 20 overlapping calls (D1 store)", async () => {
    const sql = new Database(":memory:");
    sql.exec(migration("0001_kv.sql"));
    sql.exec(migration("0002_tables.sql"));
    const store = d1Store(sqliteD1(sql), () => "s");
    const p = portalOn(slow(store, 5), 10);
    const cookie = ((await p.fetch(req("/auth/dev"))).headers.get("set-cookie") ?? "").split(";")[0];
    const k = (await (await p.fetch(req("/api/keys", { method: "POST", cookie, headers: { "content-type": "application/json" }, body: "{}" }))).json()) as { key: string };
    const results = await Promise.all(Array.from({ length: 20 }, () => p.fetch(chat(k.key))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const db = await store.load();
    const today = new Date().toISOString().slice(0, 10);
    expect(db.keys[0].requests).toBe(20);
    expect(db.keys[0].input).toBe(200);
    expect(db.keys[0].daily?.[today]).toEqual({ requests: 20, input: 200, output: 100 });
    expect(db.total?.[today]).toBe(20);
  });

  it("counts every one of 20 overlapping calls (file store)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "race-"));
    try {
      const store = fileStore(dir);
      const p = portalOn(slow(store, 5), 10);
      const cookie = ((await p.fetch(req("/auth/dev"))).headers.get("set-cookie") ?? "").split(";")[0];
      const k = (await (await p.fetch(req("/api/keys", { method: "POST", cookie, headers: { "content-type": "application/json" }, body: "{}" }))).json()) as { key: string };
      await Promise.all(Array.from({ length: 20 }, () => p.fetch(chat(k.key))));
      const db = await store.load();
      expect(db.keys[0].requests).toBe(20);
      expect(db.total?.[new Date().toISOString().slice(0, 10)]).toBe(20);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("migration 0002 copies the old single-row state", () => {
  it("keeps users, keys, revoked flags, daily usage and totals", async () => {
    const sql = new Database(":memory:");
    sql.exec(migration("0001_kv.sql"));
    const old = {
      users: { "1": { id: "1", login: "ada", name: "Ada", avatar: "a.png", created: "2026-11-01T00:00:00.000Z" } },
      keys: [
        { id: "aa", userId: "1", name: "one", hash: "h1", prefix: "fi-ab", last4: "wxyz", created: "2026-11-01T00:00:00.000Z", lastUsed: "2026-11-02T00:00:00.000Z", requests: 3, input: 30, output: 9, revoked: false, daily: { "2026-11-02": { requests: 3, input: 30, output: 9 } } },
        { id: "bb", userId: "1", name: "two", hash: "h2", prefix: "fi-cd", last4: "1234", created: "2026-11-01T00:00:00.000Z", lastUsed: null, requests: 0, input: 0, output: 0, revoked: true },
      ],
      total: { "2026-11-02": 3 },
      neurons: { "2026-11-02": 250, "2026-11-03": 40 },
    };
    sql.query("INSERT INTO kv (k, v) VALUES ('db', ?)").run(JSON.stringify(old));
    sql.exec(migration("0002_tables.sql"));
    const row = (q: string) => sql.query(q).all();
    expect(row("SELECT id, login, name, avatar, created FROM users")).toEqual([{ id: "1", login: "ada", name: "Ada", avatar: "a.png", created: "2026-11-01T00:00:00.000Z" }]);
    expect(row("SELECT id, user_id, hash, last_used, requests, input, output, revoked FROM keys ORDER BY id")).toEqual([
      { id: "aa", user_id: "1", hash: "h1", last_used: "2026-11-02T00:00:00.000Z", requests: 3, input: 30, output: 9, revoked: 0 },
      { id: "bb", user_id: "1", hash: "h2", last_used: null, requests: 0, input: 0, output: 0, revoked: 1 },
    ]);
    expect(row("SELECT * FROM key_days")).toEqual([{ key_id: "aa", day: "2026-11-02", requests: 3, input: 30, output: 9 }]);
    expect(row("SELECT * FROM day_totals ORDER BY day")).toEqual([{ day: "2026-11-02", requests: 3, neurons: 250 }, { day: "2026-11-03", requests: 0, neurons: 40 }]);
  });

  it("works on a fresh database with no old row", () => {
    const sql = new Database(":memory:");
    sql.exec(migration("0001_kv.sql"));
    sql.exec(migration("0002_tables.sql"));
    expect(sql.query("SELECT count(*) AS n FROM keys").get()).toEqual({ n: 0 });
  });
});
