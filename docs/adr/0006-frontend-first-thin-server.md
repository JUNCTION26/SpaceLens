# 6. Frontend first, with a thin API server for secrets

Status: accepted

## Context

The app is useful with no backend, which keeps hosting free and data on the device. A model key in a browser bundle, though, can be read by every visitor.

## Decision

All logic runs in the browser. The deployed site ships without a key. A person can paste their own key (kept in their browser), or a small zero-dependency API server in `server/` can hold the key and forward model calls. The server holds no design data.

## Consequences

Hosting stays static and cheap. Client-side key mode exposes that key to that user by design. Running the server adds secrets handling and abuse limits to look after. See [THREAT-MODEL.md](../THREAT-MODEL.md).
