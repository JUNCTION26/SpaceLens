# 5. AI router with measured latency and hedging

Status: accepted

## Context

Which model is fast depends on the key, its quota and the hour. Fixed model names fail on keys without access, and interactive features cannot wait for a slow first token.

## Decision

`src/core/ai/router.ts` probes models, ranks candidates per task (fast, smart, vision) by measured latency, tracks health with different cool-down times per error, and starts the next model in parallel when no token has arrived after a task-specific delay (4 s for fast, 8 s for smart and vision). The first to stream text wins and the rest are aborted.

## Consequences

Interactive latency is bounded and one failing model does not block a feature. Hedging can send one prompt to two models, so quota use can exceed one request per call. Probe results are kept in browser storage.
