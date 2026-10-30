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

Open <http://localhost:4000>. For a real server with no laptop, see **[DEPLOY.md](DEPLOY.md)**. Settings are in the table in [flisk-template-portal](https://github.com/flisk-sh/flisk-template-portal#settings).

## Status

Early and honest. Read this before trusting the address:

- **This repo is what `inference.flisk.si` serves today, through a stop-gap.** It runs on a laptop behind a Cloudflare tunnel ([`deploy/run-local-bridge.sh`](deploy/run-local-bridge.sh)), so the address is only up while that laptop is on. The real fix is a small Linux server with a persistent volume ([DEPLOY.md](DEPLOY.md)). The code passes its 25 tests in CI.
- **The model behind it is the prompted 7B.** A trained 1.5B has finished training and scores 62/62 on the machine-written test and 16/26 on natural wording, but its weights are not exported yet, so it is not served anywhere. A second round to improve natural wording is in progress.
- **Sign-in is invited-only** while it is tested.

Results and the plan: [flisk-model](https://github.com/flisk-sh/flisk-model) and its [roadmap](https://github.com/flisk-sh/flisk-model/blob/main/ROADMAP.md). Next steps for this repo, in order: score the retrained model, turn on schema-constrained output and compare, export the weights (GGUF), then move the real address to a small Linux server (see [DEPLOY.md](DEPLOY.md)).

[MIT](LICENSE)
