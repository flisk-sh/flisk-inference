# Flisk Inference

The API, console and landing page behind **[inference.flisk.si](https://inference.flisk.si)**: sign in with GitHub, create API keys, see usage, and call a small model that writes and repairs Flisk `service.json` files through an OpenAI-compatible `/v1` endpoint.

Built on [flisk-template-portal](https://github.com/flisk-sh/flisk-template-portal). The model and how good it is: [flisk-model](https://github.com/flisk-sh/flisk-model).

## What is here

- **Landing page** with live model status, code samples (curl, Python, Node) and an honest results table.
- **Console:** overview with a 30-day chart, API keys (shown once, stored as hashes), per-key usage, docs.
- **API:** `POST /v1/chat/completions` and `GET /v1/models`, one model, 30 requests a minute per key, 1,024 output tokens, no streaming.
- **Safe by default:** GitHub sign-in limited to an allowlist, signed cookies, cross-origin writes refused, rate limits, a body size cap. 25 tests.

## Run it

```bash
cd services/app/web && bun install
FLISK_DEV_LOGIN=1 UPSTREAM_URL=http://127.0.0.1:11434 ALLOWED_MODELS=flisk-wolf bun run dev
```

Open <http://localhost:4000>. To host it on a server, see **[DEPLOY.md](DEPLOY.md)**. Settings are in the table in [flisk-template-portal](https://github.com/flisk-sh/flisk-template-portal#settings).

## Status

Early and honest. Read this before trusting the address:

- **`inference.flisk.si` is this portal on Cloudflare, in open beta.** It runs as a Worker (`services/app/web/src/worker.ts`): anyone can sign in with GitHub and create keys, users and hashed keys live in D1, and `flisk-wolf` is served by Workers AI (`@cf/qwen/qwen2.5-coder-32b-instruct` with the rules and examples from `deploy/Modelfile`). Everyone shares a limit of 100 model requests a day, set in `wrangler.toml`, to stay inside the Workers AI free allowance. Nothing runs on a laptop. Deploy by hand: `cd services/app/web && bunx wrangler@4 deploy` ([DEPLOY.md](DEPLOY.md#cloudflare-free)). The code passes its tests in CI.
- **The hosted model is Qwen2.5-Coder 32B with Flisk's rules, not yet scored.** The scored ones: the prompted 7B, and a trained 1.5B that has finished two rounds of training but whose weights are not exported, so it is not served anywhere. Its latest scores: 60 of 62 on the machine-written test, and **17 of 29 on the clean natural-wording test, against 18 for Claude Haiku and Sonnet and 17 for the prompted 7B**. That is level with Claude, not better, and it missed its own target of 22 of 26. The numbers, the misses and the plan: [flisk-model](https://github.com/flisk-sh/flisk-model).
- **Beta:** free, open sign-in, and keys and usage may be reset before launch.

Results and the plan: [flisk-model](https://github.com/flisk-sh/flisk-model) and its [roadmap](https://github.com/flisk-sh/flisk-model/blob/main/ROADMAP.md). Next steps, in order and not tonight: fix the data gaps the misses show, one size check (8-bit 1.5B or the 7B), measure Claude *with* the Flisk schema in its prompt (the number that decides whether a small model has a point), then export the weights and move the real address to a small Linux server (see [DEPLOY.md](DEPLOY.md)).

[MIT](LICENSE)
