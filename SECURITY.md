# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

- Use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability**.
- If that is not available to you, open an issue that says only that you have a security report and how to reach you, with no details, and a maintainer will contact you.

Include what you found, the steps to reproduce it, the affected file or page, and the impact you expect. You should get an acknowledgement within a few days. Fixes are made on `main` and described in [CHANGELOG.md](CHANGELOG.md) once users can update. Good-faith research that avoids other people's data and service disruption is welcome.

## Supported versions

Only the latest `main` and the deployed site are supported. The project is at version 0.1.0.

## What is covered

The web app in `src/`, its production build, and the API server in `server/`. The threat model, with the mitigation that exists in code for each threat and a plain list of what is not protected yet, is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). Data handling is in [docs/PRIVACY.md](docs/PRIVACY.md).

## Summary of the design

- The production page ships a Content-Security-Policy (`index.html`, policy in `.env.production`).
- The deployed bundle contains no API key. A visitor may add their own, which is kept in that browser and sent only to Gemini.
- The optional API server holds a key in its environment, validates every request against a strict schema, checks origin, rate limits per client and per day, and never logs request bodies or keys.
- Shared models are validated before use, and model output never decides geometry.

## Known gaps

No accounts, share links that carry the whole model, a key pasted into the page being readable by that user, a public third-party page reader for store links, and plans that stay unencrypted in browser storage. See the threat model for details and the reasoning.
