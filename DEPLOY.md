# Deploying without a laptop

The service is two processes: the **portal** (this repo: sign-in, API keys, usage, the `/v1` endpoint) and a **model server** (Ollama) that the portal forwards to. Both run in containers.

## What you need

| Need | Why |
|---|---|
| A Linux server with Docker | runs both containers |
| A domain pointing at it (`inference.flisk.si`) with HTTPS | cookies and GitHub sign-in need it |
| A GitHub OAuth app | sign-in (callback `https://<your domain>/auth/callback`) |

## Steps

```bash
git clone https://github.com/flisk-sh/flisk-inference && cd flisk-inference
cp deploy/.env.example deploy/.env      # fill in the GitHub client id and secret
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml exec ollama sh -c "ollama pull qwen2.5-coder:7b && ollama create flisk-wolf -f /deploy/Modelfile"
curl -s localhost:4000/api/status       # {"ok":true,...}
```

Then put HTTPS in front of port 4000 (Caddy, or a Cloudflare tunnel) and point the domain at it. State (users, hashed keys, usage) lives in the `portal-data` volume: back it up.

## Do not use a CI runner for the real address

A GitHub Actions runner can serve a temporary demo (the [live-preview](https://github.com/flisk-sh/live-preview) repo has a workflow for it; this repo has none), but it is the wrong place for a fixed address: the link or tunnel dies with the job, and the runner has no persistent disk, so every user and API key is lost on each run. Two overlapping runs are not a clean handover either. Use a small Linux server with a persistent volume, as below.

## Which server

- **CPU only (cheapest, a small VPS):** fine for the **1.5B trained model** (short prompt, short answers, a few seconds per reply). The 7B model with the long prompt takes tens of seconds per reply on CPU and is not pleasant.
- **A GPU server:** needed for the 7B model to feel fast. Rented GPU boxes are billed by the hour, so a service that is mostly idle costs more than a small CPU box.
- **Not suitable:** free tiers without persistent disk (users and keys reset on every deploy).

Prices change, so check current rates before choosing. The trained 1.5B model is what makes a cheap CPU server realistic: it needs no 1,100-token prompt on every call.

## Moving the model

Today the model runs as `flisk-wolf`, built from `qwen2.5-coder:7b` with the rules in `deploy/Modelfile`. When the trained 1.5B weights are exported (GGUF), replace the `ollama create` line with `FROM ./wolf-1.5b.gguf` and update `ALLOWED_MODELS` if you rename it.
