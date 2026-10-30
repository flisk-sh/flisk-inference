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

Early and honest: it is a free preview, sign-in is invited-only while it is tested, and the model behind it is a prompted 7B. A trained 1.5B is in progress. See the [roadmap](https://github.com/flisk-sh/flisk-model/blob/main/ROADMAP.md).

[MIT](LICENSE)
