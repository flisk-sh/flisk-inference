// Cloudflare entry: the portal on a Worker, users and keys in D1, the model on Workers AI. Deploy: see DEPLOY.md.
import modelfile from "../../../../deploy/Modelfile";
import { type D1, d1Store } from "./d1-store";
import { browserModelsResponse } from "./browser-models";
import { runnerResponse } from "./browser-runner";
import { catalogResponse } from "./catalog";
import { agentUpstream } from "./anthropic";
import { openaiUpstream } from "./openai";
import { createPortal } from "./portal";
import { withSecurityHeaders } from "./security-headers";
import { callEvents, sendTrace, type TraceEnv } from "./trace";
import { type AiBinding, parseModelfile, workersAiUpstream } from "./workers-ai";

interface Env {
  DB: D1; AI: AiBinding; ASSETS: { fetch(req: Request): Promise<Response> };
  PUBLIC_URL: string; MODEL: string; PUBLIC_MODEL: string; CHAT_MODEL?: string; CHAT_BASE_MODEL?: string; LARGE_MODEL?: string; LARGE_BASE_MODEL?: string; DAILY_LIMIT?: string; SPONSOR_URL?: string; DAILY_NEURONS?: string; PORTAL_NAME?: string; ALLOWED_LOGINS?: string;
  GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; SESSION_SECRET: string;
  AGENT_MODEL?: string; AGENT_BASE_MODEL?: string; AGENT_DAILY_LIMIT?: string; // POST /v1/messages (Anthropic format)
  OPENAI_API_KEY?: string; OPENAI_MODEL?: string; OPENAI_DAILY_LIMIT?: string; // overflow on OpenAI when the free allowance is used up
}
type Bindings = Env & TraceEnv;

// Workers AI neurons per token, [in, out], from Cloudflare's price list (neurons per million tokens / 1,000,000).
// A base model missing here is counted at the dearest rate, so a new model can never overspend the allowance unseen.
const RATES: Record<string, [number, number]> = {
  "@cf/qwen/qwen2.5-coder-32b-instruct": [0.06, 0.0909],
  "@cf/qwen/qwen3-30b-a3b-fp8": [0.004625, 0.030475],
  "@cf/qwen/qwen3.8-27b": [0.040909, 0.290909],
  // $0.30 and $1.00 per million tokens at $0.011 per 1,000 neurons. Paid Workers AI only: on the free plan a call fails.
  "@cf/thinkingmachines/inkling-2-small": [0.027273, 0.090909],
};
const DEAREST: [number, number] = [0.06, 0.0909];
// The chat model's answers may be longer: a whole web page does not fit in 1,024 tokens, and its output is cheap.
const CHAT_MAX_TOKENS = 2048;

let portal: ReturnType<typeof createPortal> | undefined;
export default {
  async fetch(req: Request, env: Bindings, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const started = Date.now();
    let res: Response;
    try {
      res = await handle(req, env);
    } catch (e) {
      const t = sendTrace(env, { route: new URL(req.url).pathname, kind: "error", why: `the Worker threw: ${String((e as Error)?.message ?? e).slice(0, 150)}`, ms: Date.now() - started });
      if (ctx) ctx.waitUntil(t); else await t;
      throw e;
    }
    // A normal call writes nothing; a refused, failed or slow model call is one row (status and time only, never the prompt or answer).
    for (const event of callEvents(new URL(req.url).pathname, req.method, res.status, Date.now() - started)) {
      const t = sendTrace(env, event);
      if (ctx) ctx.waitUntil(t); else await t;
    }
    return withSecurityHeaders(res);
  },
};

function handle(req: Request, env: Env): Promise<Response> {
  {
    // The public model list for Flisk apps: no key needed, nothing secret in it.
    if (req.method === "GET" && new URL(req.url).pathname === "/v1/catalog") return Promise.resolve(catalogResponse());
    // Models that run in the visitor's tab (see browser-models.ts): public, and not in the catalog every picker draws from.
    if (req.method === "GET" && new URL(req.url).pathname === "/v1/browser-models") return Promise.resolve(browserModelsResponse());
    // The page those models run in, for another *.flisk.si site to put in an iframe (see browser-runner.ts).
    if (req.method === "GET" && new URL(req.url).pathname === "/browser-model") return Promise.resolve(runnerResponse());
    const [perInputToken, perOutputToken] = RATES[env.MODEL] ?? DEAREST;
    // The chat model on its own base model: Qwen3 answers at once with "/no_think" (its thinking would use up the answer).
    const chatBase = env.CHAT_MODEL && env.CHAT_BASE_MODEL ? env.CHAT_BASE_MODEL : undefined;
    const [chatIn, chatOut] = chatBase ? (RATES[chatBase] ?? DEAREST) : DEAREST;
    // Flisk Wolf Large: Inkling 2 Small (594B mixture of experts) behind the same API, no Flisk config rules, reasoning at low effort.
    const largeBase = env.LARGE_MODEL && env.LARGE_BASE_MODEL ? env.LARGE_BASE_MODEL : undefined;
    const [largeIn, largeOut] = largeBase ? (RATES[largeBase] ?? DEAREST) : DEAREST;
    portal ??= createPortal({
      name: env.PORTAL_NAME ?? "Flisk Inference",
      publicUrl: env.PUBLIC_URL,
      store: d1Store(env.DB, () => env.SESSION_SECRET),
      upstream: workersAiUpstream({ ai: env.AI, model: env.MODEL, publicModel: env.PUBLIC_MODEL, prelude: parseModelfile(modelfile), others: { ...(env.CHAT_MODEL ? { [env.CHAT_MODEL]: [] } : {}), ...(largeBase ? { [env.LARGE_MODEL as string]: [] } : {}) },
        overrides: { ...(env.CHAT_MODEL && chatBase ? { [env.CHAT_MODEL]: { model: chatBase, systemSuffix: chatBase.includes("qwen3-30b") ? "\n/no_think" : undefined, reasoningEffort: chatBase.includes("qwen3.8") ? "low" : undefined, maxTokens: CHAT_MAX_TOKENS } } : {}),
          ...(largeBase ? { [env.LARGE_MODEL as string]: { model: largeBase, reasoningEffort: "low", maxTokens: CHAT_MAX_TOKENS } } : {}) } }),
      allowedModels: [env.PUBLIC_MODEL, ...(env.CHAT_MODEL ? [env.CHAT_MODEL] : []), ...(largeBase ? [env.LARGE_MODEL as string] : [])],
      github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : undefined,
      allowedLogins: (env.ALLOWED_LOGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      dailyLimit: Number(env.DAILY_LIMIT) || undefined,
      sponsorUrl: env.SPONSOR_URL || undefined,
      dailyNeurons: Number(env.DAILY_NEURONS) ? { budget: Number(env.DAILY_NEURONS), perInputToken, perOutputToken,
        models: { ...(env.CHAT_MODEL && chatBase ? { [env.CHAT_MODEL]: { perInputToken: chatIn, perOutputToken: chatOut, maxOutputTokens: CHAT_MAX_TOKENS } } : {}),
          ...(largeBase ? { [env.LARGE_MODEL as string]: { perInputToken: largeIn, perOutputToken: largeOut, maxOutputTokens: CHAT_MAX_TOKENS } } : {}) } } : undefined,
      overflow: env.OPENAI_API_KEY ? { dailyLimit: Number(env.OPENAI_DAILY_LIMIT) || 100,
        upstream: openaiUpstream({ key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || "gpt-4o-mini", publicModel: env.PUBLIC_MODEL,
          preludes: { [env.PUBLIC_MODEL]: parseModelfile(modelfile), ...(env.CHAT_MODEL ? { [env.CHAT_MODEL]: [] } : {}), ...(largeBase ? { [env.LARGE_MODEL as string]: [] } : {}) } }) } : undefined,
      ownProviders: { publicModel: env.PUBLIC_MODEL, preludes: { [env.PUBLIC_MODEL]: parseModelfile(modelfile), ...(env.CHAT_MODEL ? { [env.CHAT_MODEL]: [] } : {}), ...(largeBase ? { [env.LARGE_MODEL as string]: [] } : {}) } },
      agent: env.AGENT_MODEL && env.AGENT_BASE_MODEL ? { run: agentUpstream({ ai: env.AI, model: env.AGENT_BASE_MODEL, publicModel: env.AGENT_MODEL }), dailyLimit: Number(env.AGENT_DAILY_LIMIT) || 500, maxBody: 8 * 1024 * 1024 } : undefined,
      beta: true,
      asset: (path) => env.ASSETS.fetch(new Request(new URL(path, env.PUBLIC_URL))),
      indexHtml: async () => (await env.ASSETS.fetch(new Request(new URL("/index.html", env.PUBLIC_URL)))).text(),
    });
    return portal.fetch(req);
  }
}
