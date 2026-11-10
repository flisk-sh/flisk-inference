// The portal: GitHub sign-in, API keys, and a metered proxy to an upstream HTTP API. No dependencies.
// createPortal() returns a fetch handler over standard Request/Response, so tests drive it without a socket.
// Storage, the model call and the page are passed in, so the same code runs under Bun (files + Ollama, src/index.ts)
// and on Cloudflare (D1 + Workers AI, src/worker.ts).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface GithubUser { id: number | string; login: string; name?: string | null; avatar_url?: string }
export interface PortalOptions {
  name?: string;                      // product name shown in the console
  publicUrl: string;                  // the address people use, no trailing slash
  upstreamUrl?: string;               // what /v1/* is forwarded to, unless `upstream` is set
  upstream?: (path: string, init: RequestInit) => Promise<Response>; // replaces the HTTP forward (Workers AI)
  store: Store;                       // users, hashed keys, usage, cookie secret
  dailyLimit?: number;                // model requests per UTC day across all keys; missing: no cap
  beta?: boolean;                     // the console says the service is in beta
  maxOutputTokens?: number;           // shown in the console; the upstream enforces it
  allowedModels?: string[];           // empty or missing: any model
  github?: { clientId: string; clientSecret: string };
  devLogin?: () => Promise<GithubUser>; // local sign-in as the machine's gh user; never set in production
  indexHtml: () => string | Promise<string>; // the landing page and console
  asset?: (path: string) => Response | Promise<Response>; // the icons in public/ (ICONS); missing: 404
  maxBody?: number;                   // bytes
  ratePerMinute?: number;             // per API key
  maxActiveKeys?: number;             // per user
  allowedLogins?: string[];           // only these GitHub logins may sign in (case-insensitive); empty or missing: anyone
  bootstrapKey?: string;              // a fixed API key accepted from the start, for a preview that has no sign-in
  fetchImpl?: typeof fetch;           // for tests
}
interface User { id: string; login: string; name: string; avatar: string; created: string }
interface Day { requests: number; input: number; output: number }
interface Key { daily?: Record<string, Day>; id: string; userId: string; name: string; hash: string; prefix: string; last4: string; created: string; lastUsed: string | null; requests: number; input: number; output: number; revoked: boolean }
export interface Db { users: Record<string, User>; keys: Key[]; total?: Record<string, number> }
export interface Store { load(): Promise<Db>; save(db: Db): Promise<void>; secret(): Promise<string> }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SESSION_DAYS = 7;

// The site icons in public/: the canonical mark from flisk-sh/flisk-emoji (apps/flisk-inference.svg) and PNGs made from it.
export const ICONS = ["/icon.svg", "/favicon.ico", "/apple-touch-icon.png", "/og.png"]; // og.png: the 1200x630 share card, rendered from og.svg with rsvg-convert
const ICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// A small page in the site's style for the few answers a person sees outside the app: not found, sign-in failed, not invited.
// `title`, `text` and the link are escaped here; callers pass plain text.
function infoPage(name: string, title: string, text: string, link: [string, string], status: number): Response {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(name)}</title>${ICON_LINKS}
<style>:root{color-scheme:light dark}body{margin:0;font:16px/1.55 system-ui,sans-serif;background:#eeece5;color:#121212}main{max-width:34rem;margin:14vh auto;padding:28px;border:1px solid rgba(18,18,18,.82);background:#f6f4ee}
small{font:600 11px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:#6a6a70}h1{font:800 34px/1.05 Georgia,serif;letter-spacing:-.02em;margin:10px 0 12px}p{color:#3d3d42;margin:0 0 22px}
a{display:inline-block;background:#22c55e;color:#04120a;font:600 12px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;padding:12px 20px;text-decoration:none}
@media(prefers-color-scheme:dark){body{background:#0b0b0d;color:#ececf1}main{background:#111114;border-color:rgba(255,255,255,.62)}p{color:rgba(236,236,241,.68)}}</style>
<main><small>${esc(name)} · ${status}</small><h1>${esc(title)}</h1><p>${esc(text)}</p><a href="${esc(link[1])}">${esc(link[0])}</a></main></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
const wantsHtml = (req: Request) => req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");

export function createPortal(opts: PortalOptions) {
  const maxBody = opts.maxBody ?? 64 * 1024;
  const ratePerMinute = opts.ratePerMinute ?? 30;
  const maxActiveKeys = opts.maxActiveKeys ?? 10;
  const doFetch = opts.fetchImpl ?? fetch;
  const secure = opts.publicUrl.startsWith("https");
  const upstream = opts.upstream ?? ((path: string, init: RequestInit) => doFetch(`${opts.upstreamUrl}${path}`, init));
  let secret = "";
  const sign = (p: string) => createHmac("sha256", secret).update(p).digest("base64url");

  // A preview run (a CI runner with a public link) has no sign-in: one key comes from a secret instead. Only its hash is stored.
  const ready = (async () => {
    secret = await opts.store.secret();
    if (!opts.bootstrapKey) return;
    const db = await opts.store.load();
    const hash = sha(opts.bootstrapKey);
    if (!db.keys.some((k) => k.hash === hash)) {
      db.users.bootstrap ??= { id: "bootstrap", login: "preview", name: "Preview key", avatar: "", created: new Date().toISOString() };
      db.keys.push({ id: randomBytes(6).toString("hex"), userId: "bootstrap", name: "preview", hash, prefix: opts.bootstrapKey.slice(0, 5), last4: opts.bootstrapKey.slice(-4), created: new Date().toISOString(), lastUsed: null, requests: 0, input: 0, output: 0, revoked: false });
      await opts.store.save(db);
    }
  })();

  const states = new Map<string, number>(); // OAuth state -> expiry
  const rate = new Map<string, number[]>();
  let statusCache: { at: number; ok: boolean } | undefined;

  const json = (code: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
  const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });
  const sessionCookie = (uid: string) => {
    const p = b64({ uid, exp: Date.now() + SESSION_DAYS * 864e5 });
    return `fi_session=${p}.${sign(p)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
  };
  function sessionUser(req: Request, db: Db): User | null {
    const m = /(?:^|;\s*)fi_session=([^;]+)/.exec(req.headers.get("cookie") ?? "");
    if (!m) return null;
    const [p, sig] = m[1].split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(sign(p)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const s = JSON.parse(Buffer.from(p, "base64url").toString()) as { uid: string; exp: number };
      return s.exp > Date.now() ? (db.users[s.uid] ?? null) : null;
    } catch { return null; }
  }
  async function upsertUser(gh: GithubUser): Promise<string> {
    const db = await opts.store.load();
    const id = String(gh.id);
    db.users[id] = { id, login: gh.login, name: gh.name ?? gh.login, avatar: gh.avatar_url ?? "", created: db.users[id]?.created ?? new Date().toISOString() };
    await opts.store.save(db);
    return id;
  }
  async function readJson(req: Request): Promise<Record<string, unknown>> {
    const text = await req.text();
    if (text.length > maxBody) throw Object.assign(new Error("body too large"), { status: 413 });
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  // A cross-site page cannot set a same-origin Origin header; SameSite=Lax cookies cover the rest.
  const sameOrigin = (req: Request) => !req.headers.get("origin") || req.headers.get("origin") === opts.publicUrl;

  async function handle(req: Request): Promise<Response> {
    await ready;
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") return json(200, { status: "ok" });
    // HEAD too: link-preview crawlers and `curl -I` check the image and page before fetching them.
    const read = req.method === "GET" || req.method === "HEAD";
    const bodyFor = (res: Response) => (req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res);
    if (read && opts.asset && ICONS.includes(path)) return bodyFor(await opts.asset(path));
    // Search engines: crawl the page, keep off the API and sign-in routes, and find the sitemap.
    if (read && path === "/robots.txt")
      return bodyFor(new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nDisallow: /v1/\n\nSitemap: ${opts.publicUrl}/sitemap.xml\n`, { headers: { "content-type": "text/plain; charset=utf-8" } }));
    if (read && path === "/sitemap.xml")
      return bodyFor(new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${opts.publicUrl}/</loc></url></urlset>\n`, { headers: { "content-type": "application/xml; charset=utf-8" } }));
    if (read && (path === "/" || path === "/index.html"))
      return bodyFor(new Response(await opts.indexHtml(), { headers: { "content-type": "text/html; charset=utf-8" } }));
    if (req.method === "GET" && path === "/api/status") {
      if (!statusCache || Date.now() - statusCache.at > 15_000) {
        let ok = false;
        try { ok = (await upstream("/v1/models", { signal: AbortSignal.timeout(2500) })).ok; } catch { /* unreachable */ }
        statusCache = { at: Date.now(), ok };
      }
      return json(200, { ok: statusCache.ok, models: opts.allowedModels ?? [], checkedAt: new Date(statusCache.at).toISOString() });
    }
    if (path === "/api/config") return json(200, { name: opts.name ?? "Portal", oauth: Boolean(opts.github), dev: Boolean(opts.devLogin), base: opts.publicUrl, models: opts.allowedModels ?? [], beta: Boolean(opts.beta), dailyLimit: opts.dailyLimit ?? null,
      limits: { perMinute: ratePerMinute, perDay: opts.dailyLimit ?? null, maxKeys: maxActiveKeys, maxOutputTokens: opts.maxOutputTokens ?? 1024, maxBodyKb: Math.round(maxBody / 1024) } });

    // ---- sign-in
    if (path === "/auth/github") {
      if (!opts.github) return json(501, { error: "GitHub OAuth is not configured (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET)" });
      const state = randomBytes(16).toString("hex");
      states.set(state, Date.now() + 600_000);
      const q = new URLSearchParams({ client_id: opts.github.clientId, redirect_uri: `${opts.publicUrl}/auth/callback`, state });
      return redirect(`https://github.com/login/oauth/authorize?${q}`);
    }
    if (path === "/auth/callback") {
      const state = url.searchParams.get("state"), code = url.searchParams.get("code");
      const expiry = state ? states.get(state) : undefined;
      const signInFailed = (why: string) => infoPage(opts.name ?? "Portal", "Sign-in did not finish", `${why} Nothing was saved; try again.`, ["Sign in with GitHub", "/auth/github"], 400);
      if (!opts.github || !state || !code || !expiry || expiry < Date.now()) return signInFailed("This sign-in link expired or was already used, for example after going back in the browser.");
      states.delete(state);
      const tok = (await (await doFetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: opts.github.clientId, client_secret: opts.github.clientSecret, code }) })).json()) as { access_token?: string };
      if (!tok.access_token) return signInFailed("GitHub did not confirm the sign-in.");
      const gh = (await (await doFetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "flisk-portal" } })).json()) as GithubUser;
      if (!gh.id || !gh.login) return signInFailed("We could not read your GitHub profile.");
      if (opts.allowedLogins?.length && !opts.allowedLogins.some((l) => l.toLowerCase() === String(gh.login).toLowerCase()))
        return infoPage(opts.name ?? "Portal", "Private preview", `@${gh.login} is not on the list yet. ${opts.name ?? "Portal"} is open to a few people while it is tested.`, ["Back to the site", "/"], 403);
      return redirect("/?section=keys", { "set-cookie": sessionCookie(await upsertUser(gh)) });
    }
    if (path === "/auth/dev") {
      if (!opts.devLogin) return json(403, { error: "dev login is off" });
      return redirect("/?section=keys", { "set-cookie": sessionCookie(await upsertUser(await opts.devLogin())) });
    }
    if (path === "/auth/logout") return redirect("/", { "set-cookie": "fi_session=; Max-Age=0; Path=/" });

    // ---- console API (session cookie)
    if (path.startsWith("/api/")) {
      const db = await opts.store.load();
      const save = () => opts.store.save(db);
      const user = sessionUser(req, db);
      if (path === "/api/me" && req.method === "GET" && !user) return json(200, null);
      if (!user) return json(401, { error: "not signed in" });
      if (req.method !== "GET" && !sameOrigin(req)) return json(403, { error: "cross-origin request refused" });
      const mine = db.keys.filter((k) => k.userId === user.id);
      if (path === "/api/me") return json(200, user);
      if (path === "/api/keys" && req.method === "GET")
        return json(200, mine.filter((k) => !k.revoked).map(({ id, name, prefix, last4, created, lastUsed }) => ({ id, name, prefix, last4, created, lastUsed })));
      if (path === "/api/keys" && req.method === "POST") {
        const body = await readJson(req);
        if (mine.filter((k) => !k.revoked).length >= maxActiveKeys) return json(400, { error: `limit of ${maxActiveKeys} active keys` });
        const key = `fi-${randomBytes(24).toString("base64url")}`;
        const rec: Key = { id: randomBytes(6).toString("hex"), userId: user.id, name: String(body.name || "default").slice(0, 40), hash: sha(key), prefix: key.slice(0, 5), last4: key.slice(-4), created: new Date().toISOString(), lastUsed: null, requests: 0, input: 0, output: 0, revoked: false };
        db.keys.push(rec);
        await save();
        return json(201, { id: rec.id, name: rec.name, key }); // the only time the full key is returned
      }
      const del = /^\/api\/keys\/([0-9a-f]+)$/.exec(path);
      if (del && req.method === "DELETE") {
        const k = mine.find((x) => x.id === del[1]);
        if (!k) return json(404, { error: "no such key" });
        k.revoked = true;
        await save();
        return json(200, { ok: true });
      }
      if (path === "/api/usage") {
        const keys = mine.map((k) => ({ name: k.name, revoked: k.revoked, requests: k.requests, input: k.input, output: k.output, lastUsed: k.lastUsed }));
        const sum = (f: "requests" | "input" | "output") => keys.reduce((n, k) => n + k[f], 0);
        // The last 30 days across all of this user's keys, zero-filled so a chart needs no gaps logic.
        const daily = Array.from({ length: 30 }, (_, i) => {
          const date = new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10);
          const d = mine.reduce((a, k) => ({ requests: a.requests + (k.daily?.[date]?.requests ?? 0), input: a.input + (k.daily?.[date]?.input ?? 0), output: a.output + (k.daily?.[date]?.output ?? 0) }), { requests: 0, input: 0, output: 0 });
          return { date, ...d };
        });
        const date = new Date().toISOString().slice(0, 10);
        // `today` is everyone's requests today: the daily limit is shared, so this is what is left for this user too.
        return json(200, { totals: { requests: sum("requests"), input: sum("input"), output: sum("output") }, keys, daily, today: { date, used: db.total?.[date] ?? 0, limit: opts.dailyLimit ?? null } });
      }
      return json(404, { error: "not found" });
    }

    // ---- /v1/*: API-key auth, metered, forwarded to the upstream
    if (path.startsWith("/v1/")) {
      const db = await opts.store.load();
      const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
      const key = m ? db.keys.find((k) => !k.revoked && k.hash === sha(m[1])) : undefined;
      if (!key) return json(401, { error: { message: "invalid or missing API key", type: "invalid_request_error" } });
      if (req.method !== "GET" && req.method !== "POST") return json(405, { error: { message: "method not allowed" } });
      if (req.method === "GET" && path === "/v1/models" && opts.allowedModels?.length)
        return json(200, { object: "list", data: opts.allowedModels.map((id) => ({ id, object: "model", owned_by: opts.name ?? "portal" })) });
      const now = Date.now();
      const recent = (rate.get(key.id) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= ratePerMinute) return json(429, { error: { message: `rate limit: ${ratePerMinute} requests per minute` } });
      rate.set(key.id, [...recent, now]);
      const today = new Date().toISOString().slice(0, 10);
      if (opts.dailyLimit && (db.total?.[today] ?? 0) >= opts.dailyLimit)
        return json(429, { error: { message: `the free beta's shared daily limit of ${opts.dailyLimit} requests is used up; it resets at 00:00 UTC` } });

      let body: string | undefined;
      if (req.method === "POST") {
        const parsed = await readJson(req);
        if (parsed.stream) return json(400, { error: { message: "streaming is not supported" } });
        if (opts.allowedModels?.length && !opts.allowedModels.includes(String(parsed.model))) return json(400, { error: { message: `model must be one of: ${opts.allowedModels.join(", ")}` } });
        body = JSON.stringify(parsed);
      }
      const up = await upstream(path, { method: req.method, headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(120_000) });
      const text = await up.text();
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      try { usage = (JSON.parse(text) as { usage?: typeof usage }).usage; } catch { /* not JSON: count the request only */ }
      if (up.ok) {
        // Read again before writing: the model call is slow, and another request may have saved meanwhile.
        const fresh = await opts.store.load();
        const k = fresh.keys.find((x) => x.id === key.id);
        if (k) {
          k.requests++;
          k.input += usage?.prompt_tokens ?? 0;
          k.output += usage?.completion_tokens ?? 0;
          const day = ((k.daily ??= {})[today] ??= { requests: 0, input: 0, output: 0 });
          day.requests++;
          day.input += usage?.prompt_tokens ?? 0;
          day.output += usage?.completion_tokens ?? 0;
          k.lastUsed = new Date().toISOString();
        }
        (fresh.total ??= {})[today] = (fresh.total[today] ?? 0) + 1;
        await opts.store.save(fresh);
      }
      return new Response(text, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/json" } });
    }
    if (wantsHtml(req)) return infoPage(opts.name ?? "Portal", "Page not found", `There is nothing at ${path}.`, ["Back to the site", "/"], 404);
    return json(404, { error: "not found" });
  }

  return {
    fetch: async (req: Request): Promise<Response> => {
      try { return await handle(req); }
      catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 413) return json(413, { error: "body too large" });
        if (e instanceof SyntaxError) return json(400, { error: "invalid JSON" });
        console.error(e);
        return json(500, { error: "server error" });
      }
    },
  };
}
