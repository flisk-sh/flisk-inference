import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore } from "../src/file-store";
import { createPortal, type GithubUser } from "../src/portal";

const BASE = "http://portal.test";
const ME: GithubUser = { id: 4242, login: "octocat", name: "Octo Cat", avatar_url: "https://example.com/a.png" };
let dir: string;
let upstreamCalls: Array<{ url: string; body: string | undefined }>;

function make(extra: Partial<Parameters<typeof createPortal>[0]> = {}) {
  upstreamCalls = [];
  return createPortal({
    publicUrl: BASE,
    upstreamUrl: "http://upstream.test",
    store: fileStore(dir),
    indexHtml: () => readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf-8"),
    devLogin: async () => ME,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls.push({ url: String(input), body: init?.body as string | undefined });
      return new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    ...extra,
  });
}
const req = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  new Request(BASE + path, { ...init, headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
async function login(portal: ReturnType<typeof make>) {
  const res = await portal.fetch(req("/auth/dev"));
  expect(res.status).toBe(302);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}
async function newKey(portal: ReturnType<typeof make>, cookie: string, name = "test") {
  const res = await portal.fetch(req("/api/keys", { method: "POST", cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string };
}
const chat = (key: string, body: unknown = { model: "m", messages: [] }) =>
  req("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "portal-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sign-in", () => {
  it("refuses the console API without a session", async () => {
    expect((await make().fetch(req("/api/me"))).status).toBe(401);
  });
  it("signs in through the local gh login and returns the GitHub profile", async () => {
    const p = make();
    const me = (await (await p.fetch(req("/api/me", { cookie: await login(p) }))).json()) as { login: string };
    expect(me.login).toBe("octocat");
  });
  it("has no dev login unless one is passed", async () => {
    expect((await make({ devLogin: undefined }).fetch(req("/auth/dev"))).status).toBe(403);
  });
  it("rejects a forged or tampered session cookie", async () => {
    const p = make();
    const cookie = await login(p);
    expect((await p.fetch(req("/api/me", { cookie: `${cookie}x` }))).status).toBe(401);
    expect((await p.fetch(req("/api/me", { cookie: "fi_session=e30.abc" }))).status).toBe(401);
  });
  it("starts the GitHub flow only when OAuth is configured, and rejects an unknown state", async () => {
    expect((await make().fetch(req("/auth/github"))).status).toBe(501);
    const p = make({ github: { clientId: "id", clientSecret: "secret" } });
    const start = await p.fetch(req("/auth/github"));
    expect(start.headers.get("location")).toContain("https://github.com/login/oauth/authorize?client_id=id");
    expect((await p.fetch(req("/auth/callback?state=nope&code=x"))).status).toBe(400);
  });
  it("refuses a GitHub login that is not on the allowlist", async () => {
    const p = make({
      github: { clientId: "id", clientSecret: "secret" },
      allowedLogins: ["someone-else"],
      fetchImpl: (async (input: RequestInfo | URL) =>
        new Response(JSON.stringify(String(input).includes("access_token") ? { access_token: "tok" } : ME))) as typeof fetch,
    });
    const state = new URL((await p.fetch(req("/auth/github"))).headers.get("location") ?? "").searchParams.get("state");
    const res = await p.fetch(req(`/auth/callback?state=${state}&code=abc`));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("completes the OAuth callback with a valid state", async () => {
    const calls: string[] = [];
    const p = make({
      github: { clientId: "id", clientSecret: "secret" },
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify(String(input).includes("access_token") ? { access_token: "tok" } : ME));
      }) as typeof fetch,
    });
    const state = new URL((await p.fetch(req("/auth/github"))).headers.get("location") ?? "").searchParams.get("state");
    const done = await p.fetch(req(`/auth/callback?state=${state}&code=abc`));
    expect(done.status).toBe(302);
    expect(done.headers.get("set-cookie")).toContain("fi_session=");
    expect(calls).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user"]);
    expect((await p.fetch(req(`/auth/callback?state=${state}&code=abc`))).status).toBe(400); // state is single use
  });
});

describe("API keys", () => {
  it("shows the key once and stores only its hash", async () => {
    const p = make();
    const cookie = await login(p);
    const { key } = await newKey(p, cookie);
    expect(key.startsWith("fi-")).toBe(true);
    const list = (await (await p.fetch(req("/api/keys", { cookie }))).json()) as Array<Record<string, string>>;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(key);
    expect(readFileSync(join(dir, "db.json"), "utf-8")).not.toContain(key);
  });
  it("revokes a key and then refuses it", async () => {
    const p = make();
    const cookie = await login(p);
    const { id, key } = await newKey(p, cookie);
    expect((await p.fetch(chat(key))).status).toBe(200);
    expect((await p.fetch(req(`/api/keys/${id}`, { method: "DELETE", cookie }))).status).toBe(200);
    expect((await p.fetch(chat(key))).status).toBe(401);
  });
  it("limits active keys per user", async () => {
    const p = make({ maxActiveKeys: 2 });
    const cookie = await login(p);
    await newKey(p, cookie, "a");
    await newKey(p, cookie, "b");
    const res = await p.fetch(req("/api/keys", { method: "POST", cookie, body: "{}" }));
    expect(res.status).toBe(400);
  });
  it("refuses a cross-origin state change", async () => {
    const p = make();
    const cookie = await login(p);
    const { id } = await newKey(p, cookie);
    const res = await p.fetch(req(`/api/keys/${id}`, { method: "DELETE", cookie, headers: { origin: "http://evil.example" } }));
    expect(res.status).toBe(403);
  });
  it("does not let one user revoke another user's key", async () => {
    const a = make();
    const cookieA = await login(a);
    const { id } = await newKey(a, cookieA);
    const b = make({ devLogin: async () => ({ id: 1, login: "mallory" }) });
    const cookieB = await login(b);
    expect((await b.fetch(req(`/api/keys/${id}`, { method: "DELETE", cookie: cookieB }))).status).toBe(404);
  });
});

describe("/v1 proxy", () => {
  it("needs a valid key", async () => {
    const p = make();
    expect((await p.fetch(req("/v1/models"))).status).toBe(401);
    expect((await p.fetch(chat("fi-nope"))).status).toBe(401);
  });
  it("forwards to the upstream and meters tokens per key", async () => {
    const p = make();
    const cookie = await login(p);
    const { key } = await newKey(p, cookie);
    await p.fetch(chat(key));
    await p.fetch(chat(key));
    expect(upstreamCalls[0].url).toBe("http://upstream.test/v1/chat/completions");
    const usage = (await (await p.fetch(req("/api/usage", { cookie }))).json()) as { totals: { requests: number; input: number; output: number } };
    expect(usage.totals).toEqual({ requests: 2, input: 20, output: 10 });
  });
  it("applies the model allowlist and rejects streaming", async () => {
    const p = make({ allowedModels: ["flisk-wolf"] });
    const { key } = await newKey(p, await login(p));
    expect((await p.fetch(chat(key, { model: "other" }))).status).toBe(400);
    expect((await p.fetch(chat(key, { model: "flisk-wolf", stream: true }))).status).toBe(400);
    expect((await p.fetch(chat(key, { model: "flisk-wolf" }))).status).toBe(200);
  });
  it("rate limits per key", async () => {
    const p = make({ ratePerMinute: 2 });
    const { key } = await newKey(p, await login(p));
    expect((await p.fetch(chat(key))).status).toBe(200);
    expect((await p.fetch(chat(key))).status).toBe(200);
    expect((await p.fetch(chat(key))).status).toBe(429);
  });
  it("refuses an oversized body", async () => {
    const p = make({ maxBody: 100 });
    const { key } = await newKey(p, await login(p));
    expect((await p.fetch(chat(key, { model: "m", pad: "x".repeat(500) }))).status).toBe(413);
  });
  it("does not meter a failed upstream call", async () => {
    const p = make({ fetchImpl: (async () => new Response('{"error":"down"}', { status: 502 })) as unknown as typeof fetch });
    const cookie = await login(p);
    const { key } = await newKey(p, cookie);
    expect((await p.fetch(chat(key))).status).toBe(502);
    const usage = (await (await p.fetch(req("/api/usage", { cookie }))).json()) as { totals: { requests: number } };
    expect(usage.totals.requests).toBe(0);
  });
});

describe("bootstrap key", () => {
  it("accepts a fixed key with no sign-in and stores only its hash", async () => {
    const p = make({ devLogin: undefined, bootstrapKey: "fi-preview-secret-1234" });
    expect((await p.fetch(chat("fi-preview-secret-1234"))).status).toBe(200);
    expect((await p.fetch(chat("fi-other"))).status).toBe(401);
    expect(readFileSync(join(dir, "db.json"), "utf-8")).not.toContain("fi-preview-secret-1234");
  });
  it("does not add the key twice across restarts", async () => {
    await make({ bootstrapKey: "fi-once" }).fetch(req("/health"));
    await make({ bootstrapKey: "fi-once" }).fetch(req("/health"));
    const db = JSON.parse(readFileSync(join(dir, "db.json"), "utf-8")) as { keys: unknown[] };
    expect(db.keys).toHaveLength(1);
  });
});

describe("beta limits", () => {
  it("stops model calls at the shared daily limit across all keys", async () => {
    const p = make({ dailyLimit: 2 });
    const cookie = await login(p);
    const a = await newKey(p, cookie, "a"), b = await newKey(p, cookie, "b");
    expect((await p.fetch(chat(a.key))).status).toBe(200);
    expect((await p.fetch(chat(b.key))).status).toBe(200);
    const over = await p.fetch(chat(a.key));
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { message: string } }).error.message).toContain("daily limit");
    expect(upstreamCalls).toHaveLength(2);
  });
  it("reports today's shared use against the daily limit in /api/usage", async () => {
    const p = make({ dailyLimit: 5 });
    const cookie = await login(p);
    const { key } = await newKey(p, cookie);
    await p.fetch(chat(key));
    await p.fetch(chat(key));
    const u = (await (await p.fetch(req("/api/usage", { cookie }))).json()) as { today: { used: number; limit: number } };
    expect(u.today).toMatchObject({ used: 2, limit: 5 });
  });
  it("lists every free limit in /api/config so the console can show them", async () => {
    const cfg = (await (await make({ dailyLimit: 100 }).fetch(req("/api/config"))).json()) as { limits: Record<string, number> };
    expect(cfg.limits).toEqual({ perMinute: 30, perDay: 100, maxKeys: 10, maxOutputTokens: 1024, maxBodyKb: 64 });
  });
  it("says beta and the daily limit in /api/config", async () => {
    const cfg = (await (await make({ beta: true, dailyLimit: 300 }).fetch(req("/api/config"))).json()) as { beta: boolean; dailyLimit: number };
    expect(cfg).toMatchObject({ beta: true, dailyLimit: 300 });
  });
  it("calls a custom upstream function instead of HTTP when one is given", async () => {
    const seen: string[] = [];
    const p = make({ upstream: async (path) => { seen.push(path); return Response.json({ ok: true }); } });
    const { key } = await newKey(p, await login(p));
    expect((await p.fetch(chat(key))).status).toBe(200);
    expect(seen).toEqual(["/v1/chat/completions"]);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("status, models and daily usage", () => {
  it("answers /api/status without a key, from the upstream's own health", async () => {
    const up = make({ allowedModels: ["flisk-wolf"] });
    const ok = (await (await up.fetch(req("/api/status"))).json()) as { ok: boolean; models: string[] };
    expect(ok).toMatchObject({ ok: true, models: ["flisk-wolf"] });
    const down = make({ fetchImpl: (async () => { throw new Error("refused"); }) as unknown as typeof fetch });
    expect(((await (await down.fetch(req("/api/status"))).json()) as { ok: boolean }).ok).toBe(false);
  });
  it("lists only the models it serves, not everything the upstream has", async () => {
    const p = make({ allowedModels: ["flisk-wolf"] });
    const { key } = await newKey(p, await login(p));
    const res = (await (await p.fetch(req("/v1/models", { headers: { authorization: `Bearer ${key}` } }))).json()) as { data: Array<{ id: string }> };
    expect(res.data.map((m) => m.id)).toEqual(["flisk-wolf"]);
    expect(upstreamCalls).toHaveLength(0);
  });
  it("returns 30 zero-filled days of usage and counts today", async () => {
    const p = make();
    const cookie = await login(p);
    const { key } = await newKey(p, cookie);
    await p.fetch(chat(key));
    const u = (await (await p.fetch(req("/api/usage", { cookie }))).json()) as { daily: Array<{ date: string; requests: number; input: number }> };
    expect(u.daily).toHaveLength(30);
    expect(u.daily[29]).toMatchObject({ requests: 1, input: 10 });
    expect(u.daily.slice(0, 29).every((d) => d.requests === 0)).toBe(true);
  });
  it("shows a readable page, not JSON, to a login that is not allowed", async () => {
    const p = make({
      github: { clientId: "id", clientSecret: "secret" },
      allowedLogins: ["someone-else"],
      fetchImpl: (async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("access_token") ? { access_token: "t" } : ME))) as typeof fetch,
    });
    const state = new URL((await p.fetch(req("/auth/github"))).headers.get("location") ?? "").searchParams.get("state");
    const res = await p.fetch(req(`/auth/callback?state=${state}&code=x`));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    const page = await res.text();
    expect(page).toContain("Private preview");
    expect(page).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
  });
});

describe("pages", () => {
  it("serves the console and /health", async () => {
    const p = make();
    expect((await p.fetch(req("/health"))).status).toBe(200);
    const home = await p.fetch(req("/"));
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).toContain("Sign in with GitHub");
  });
});

describe("site icons", () => {
  it("serves the icons from public/ and links them in <head>", async () => {
    const pub = join(import.meta.dir, "..", "public");
    const portal = make({ asset: (path) => new Response(Bun.file(join(pub, path))) });
    for (const path of ["/icon.svg", "/favicon.ico", "/apple-touch-icon.png"]) {
      const res = await portal.fetch(req(path));
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(readFileSync(join(pub, path))));
    }
    expect(readFileSync(join(pub, "icon.svg"), "utf-8")).toContain('aria-label="Flisk Inference"');
    const html = await (await portal.fetch(req("/"))).text();
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(html).toContain('<img src=\\"/icon.svg\\" alt=\\"\\" width=\\"26\\" height=\\"26\\">');
    expect(html).not.toContain("SVG.logo");
  });
  it("answers 404 for the icons when no asset handler is given", async () => {
    expect((await make().fetch(req("/icon.svg"))).status).toBe(404);
  });
});
