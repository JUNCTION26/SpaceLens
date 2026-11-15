# SpaceLens API server

A small HTTP server that holds the Gemini key, so the app works on any device without anyone pasting a key. It runs on Node 22+ built-ins only (`node:http`, `fetch`, `crypto`, `node:test`): nothing to install.

```mermaid
flowchart LR
  A[Browser app<br/>GitHub Pages] -- "POST /v1/generate/stream<br/>(no key)" --> S[API server<br/>Render]
  S -- "x-goog-api-key (server only)" --> G[Gemini API]
  A -. "personal key set in Settings" .-> G
```

The browser picks the route by itself: a personal key set in Settings (or `VITE_GEMINI_KEY` in development) calls Google directly; otherwise calls go to the server at `VITE_API_BASE`; with neither, the app runs on offline rules.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/healthz` | `{"status":"ok"}` for the platform health check |
| GET | `/v1/models` | Allowed models the key can call, in order of preference (cached) |
| POST | `/v1/generate` | One Gemini `generateContent` call, JSON in and out |
| POST | `/v1/generate/stream` | Server-sent events, passed through from `streamGenerateContent` chunk by chunk |
| POST | `/v1/image` | One image-model call: `{ "model", "prompt", "image"?: { "mimeType", "data" } }` returns `{ "model", "mimeType", "data" }` (base64) |
| POST | `/v1/speech` | One speech-model call: `{ "model", "text", "voice"? }` returns `{ "model", "mimeType", "data" }` (base64 audio, parts joined) |
| POST | `/v1/votes` | Create a poll from 2 to 4 layouts (name, price, small SVG thumbnail or plan data); returns the poll with its id |
| GET | `/v1/votes/:id` | The poll with vote counts |
| POST | `/v1/votes/:id/vote` | `{ "choice": 0, "token": "<browser token>" }`, one vote per token |

Request body for both generate routes (anything else is refused with a 400 naming the field):

```json
{
  "model": "gemini-3.5-flash-lite",
  "contents": [{ "role": "user", "parts": [{ "text": "Say hello" }] }],
  "generationConfig": { "temperature": 0.2, "thinkingConfig": { "thinkingLevel": "low" } },
  "systemInstruction": { "parts": [{ "text": "Be brief." }] },
  "tools": [{ "google_search": {} }]
}
```

Image and speech calls are costly, so they have their own rules: a model allowlist per kind (`IMAGE_MODEL_ALLOWLIST`, `TTS_MODEL_ALLOWLIST`), prompt up to 1500 characters, speech text up to 1000, input image PNG, JPEG or WebP up to 5 MB of base64, a smaller body cap (`MEDIA_MAX_BODY_BYTES`), a tighter per-client bucket (`MEDIA_RATE_BURST`, `MEDIA_RATE_PER_MINUTE`, on top of the general one) and a separate daily allowance (`MEDIA_RATE_DAILY`). A reply with no image or audio is a 502 with code `no_media`.

Every error uses one shape, with a stable `code` and a plain message. Upstream error text is never passed on. When waiting helps, the body also carries `retryAfterS`, the same whole seconds as the `Retry-After` header:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests. Wait a moment and try again.", "retryAfterS": 2 } }
```

Two 429 codes mean different things, and the app treats them differently:

| Code | Who said no | What the app does |
|------|-------------|-------------------|
| `rate_limited` | this server's per-address bucket | waits `retryAfterS` and sends the same call again; the model stays in use |
| `upstream_quota` | Gemini, for that model | skips that model until its quota resets and tries the next one |
| `budget_exhausted` | this server's shared daily allowance | stops AI calls until 00:00 UTC and falls back to offline rules |

## Security

- **Key**: read from the environment only. It is never accepted from a client, never sent back, never logged (tests check every response and log line).
- **CORS**: only listed origins get `Access-Control-Allow-Origin`; other origins get a 403. Preflights allow `GET`, `POST` and the `Content-Type` and `X-Request-Id` headers only. Generate calls must carry an allowed `Origin`.
- **Limits**: a token bucket per client address (`RATE_LIMIT_BURST`, refilled at `RATE_LIMIT_PER_MINUTE`) and a shared daily allowance (`RATE_LIMIT_DAILY`, resets at 00:00 UTC). Both answer 429 with `Retry-After` and `retryAfterS`. Only valid requests spend the daily allowance. The defaults are sized for one person designing a themed room: a brief, about a dozen object specs and a critic pass arrive within seconds, so a burst of 90 with 240 a minute leaves room for retries while the app's own queue keeps at most 6 calls in flight.
- **Input**: body cap (`MAX_BODY_BYTES`, checked against the declared length and while reading), JSON only, model allowlist, strict field-by-field schema; search grounding is the only tool forwarded.
- **Upstream**: a total timeout (`UPSTREAM_TIMEOUT_MS`), and the Gemini call is aborted as soon as the browser disconnects.
- **Headers**: `nosniff`, `no-store`, HSTS, `default-src 'none'` CSP, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- **Client address**: the socket address unless `CLIENT_IP_HEADER` is set. With `x-forwarded-for`, the entry added by the platform proxy is used (counted from the right by `TRUSTED_PROXY_HOPS`), never the client-controlled left end.
- **Logs**: one JSON line per request with a request id, route, status, duration and model. No bodies, keys or addresses.

## Run locally

```bash
GEMINI_API_KEY=your-key npm run server          # listens on http://localhost:8787
# or keep the variables in a file that is never committed:
node --env-file=server/.env server/index.mjs
```

Then point the app at it in `.env.local` (and leave `VITE_GEMINI_KEY` empty, or it calls Google directly):

```bash
VITE_API_BASE=http://localhost:8787
```

```bash
curl http://localhost:8787/healthz
curl -N http://localhost:8787/v1/generate/stream \
  -H 'Origin: http://localhost:5180' -H 'Content-Type: application/json' \
  -d '{"model":"gemini-3.5-flash-lite","contents":[{"parts":[{"text":"Count to 5"}]}]}'
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | (required) | Server-side Gemini key |
| `ALLOWED_ORIGINS` | Pages origin and local dev ports | Comma-separated origins; `http://localhost:*` allows any port |
| `MODEL_ALLOWLIST` | fast and mid-size Gemini models | Comma-separated model ids, preferred first |
| `RATE_LIMIT_BURST` | `90` | Requests a client may send at once |
| `RATE_LIMIT_PER_MINUTE` | `240` | Refill rate per client |
| `RATE_LIMIT_DAILY` | `20000` | Model calls per UTC day for everyone together |
| `IMAGE_MODEL_ALLOWLIST` | the app's image models | Comma-separated image model ids |
| `TTS_MODEL_ALLOWLIST` | the app's speech models | Comma-separated speech model ids |
| `MEDIA_RATE_BURST` | `3` | Image and speech calls a client may send at once |
| `MEDIA_RATE_PER_MINUTE` | `4` | Refill rate per client for image and speech calls |
| `MEDIA_RATE_DAILY` | `300` | Image and speech calls per UTC day for everyone together |
| `MEDIA_MAX_BODY_BYTES` | `4000000` | Largest image or speech request body |
| `MAX_BODY_BYTES` | `8000000` | Largest request body (images travel as base64) |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Total time allowed for one Gemini call |
| `MODELS_CACHE_MS` | `600000` | How long the model list is cached |
| `CLIENT_IP_HEADER` | (socket address) | `x-forwarded-for`, or a header holding one address |
| `TRUSTED_PROXY_HOPS` | `1` | Proxies in front of the server that append to X-Forwarded-For |
| `REQUIRE_ORIGIN` | `true` | Refuse generate calls without an `Origin` header |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Where to listen (Render sets `PORT`) |

Invalid settings stop the server at startup with a list of every problem.

## Deploy on Render (free tier)

1. In Render: **New > Blueprint**, pick this repository. `render.yaml` creates the `spacelens-api` web service (Node, free plan, start command `node server/index.mjs`, health check `/healthz`).
2. Enter `GEMINI_API_KEY` when asked. Adjust the optional variables under **Environment** if needed.
3. Deploy, then open `https://<service>.onrender.com/healthz`.

Manual setup works too: **New > Web Service**, runtime Node, build command `node --version`, start command `node server/index.mjs`, health check path `/healthz`, environment `NODE_VERSION=22`, `GEMINI_API_KEY`, `ALLOWED_ORIGINS=https://junction26.github.io`, `CLIENT_IP_HEADER=x-forwarded-for`.

Free instances sleep after a period without traffic; the first call after that waits while the instance starts.

## Connect the GitHub Pages build

1. Repository **Settings > Secrets and variables > Actions > Variables**: add `VITE_API_BASE` = `https://<service>.onrender.com` (no trailing slash).
2. `.github/workflows/pages.yml` passes it to the build. `.env.production` adds the same value to the page's Content-Security-Policy `connect-src`, so the browser is allowed to call it.
3. Re-run the Pages workflow. With no key set, the status chip reads "Gemini" and AI features go through the server.

## Tests

```bash
npm run test:server
```

`node:test` suites in `server/test/` run the full server on a random local port with a stubbed upstream (no network): validation, CORS and preflight, rate limit and daily allowance, body cap, model allowlist, streaming pass-through, error mapping, client disconnect, timeouts, and that no key or request content appears in any response or log line. CI runs them in the `server` job.

## Layout polls

Polls live in memory only: at most 300 at a time (the oldest leave first), each for 48 hours and up to 2000 voters. They are lost whenever the free server sleeps or restarts, so a shared link can stop working after a quiet spell. A database is the next step; the store in `votes.mjs` is the only code that would change. Thumbnails are checked on the way in (plain SVG only, no scripts, links or images) and requests share the same origin allowlist, rate limit and error envelope as the AI routes.
