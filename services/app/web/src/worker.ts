// Cloudflare entry: the portal on a Worker, users and keys in D1, the model on Workers AI. Deploy: see DEPLOY.md.
import modelfile from "../../../../deploy/Modelfile";
import { type D1, d1Store } from "./d1-store";
import { createPortal } from "./portal";
import { type AiBinding, parseModelfile, workersAiUpstream } from "./workers-ai";

interface Env {
  DB: D1; AI: AiBinding; ASSETS: { fetch(req: Request): Promise<Response> };
  PUBLIC_URL: string; MODEL: string; PUBLIC_MODEL: string; CHAT_MODEL?: string; DAILY_LIMIT?: string; DAILY_NEURONS?: string; PORTAL_NAME?: string; ALLOWED_LOGINS?: string;
  GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; SESSION_SECRET: string;
}

let portal: ReturnType<typeof createPortal> | undefined;
export default {
  fetch(req: Request, env: Env): Promise<Response> {
    portal ??= createPortal({
      name: env.PORTAL_NAME ?? "Flisk Inference",
      publicUrl: env.PUBLIC_URL,
      store: d1Store(env.DB, () => env.SESSION_SECRET),
      upstream: workersAiUpstream({ ai: env.AI, model: env.MODEL, publicModel: env.PUBLIC_MODEL, prelude: parseModelfile(modelfile), others: env.CHAT_MODEL ? { [env.CHAT_MODEL]: [] } : {} }),
      allowedModels: [env.PUBLIC_MODEL, ...(env.CHAT_MODEL ? [env.CHAT_MODEL] : [])],
      github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : undefined,
      allowedLogins: (env.ALLOWED_LOGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      dailyLimit: Number(env.DAILY_LIMIT) || undefined,
      // Qwen2.5-Coder 32B on Workers AI: $0.66 per million tokens in and $1.00 out, at $0.011 per 1,000 neurons.
      dailyNeurons: Number(env.DAILY_NEURONS) ? { budget: Number(env.DAILY_NEURONS), perInputToken: 0.06, perOutputToken: 0.0909 } : undefined,
      beta: true,
      asset: (path) => env.ASSETS.fetch(new Request(new URL(path, env.PUBLIC_URL))),
      indexHtml: async () => (await env.ASSETS.fetch(new Request(new URL("/index.html", env.PUBLIC_URL)))).text(),
    });
    return portal.fetch(req);
  },
};
