# Contributing

Thanks for helping. This page covers setup, the checks to run and the conventions the project follows.

## Setup

Prerequisites: Node.js 22 and npm.

```bash
git clone https://github.com/JUNCTION26/SpaceLens.git
cd SpaceLens
npm ci
npm run dev
```

No environment variables are required. For model features, copy `.env.example` to `.env.local` and set `VITE_GEMINI_KEY` (development only; the file is ignored by git). Never commit a key.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run typecheck` | Strict TypeScript check of the whole project |
| `npm run check:boundaries` | Fails if `core` imports features or the referee imports anything but core types |
| `npm test` | Unit and scenario tests (hermetic: no network, no key) |
| `npm run server`, `npm run test:server` | Run the optional API server in `server/`, and its tests (Node's built-in test runner) |
| `npm run build` | Type check and production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run docs:rules`, `npm run docs:safety` | Print the rule and safety tables used in `docs/` from the code |
| `npm run eval:stoa` | Drawings benchmark (see the README) |

CI runs type check, the boundary check, tests and build on every push and pull request. Run them locally first.

## Where things go

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. In short: shared types and edits live in `src/core`; each feature lives in `src/features/<name>`; judges (referee, rules, safety) read the model and never edit it. Changes to `src/core/types.ts` affect everything, so keep them small and explain them. A decision that changes the shape of the system gets a short record in `docs/adr/`.

## Tests

- Put tests beside the code as `*.test.ts`. Pure logic should be tested directly.
- Tests must be hermetic. Anything that needs the network or a key must be opt-in through an environment flag.
- Test files that use Node APIs load them with a dynamic import (see `src/features/design/scenarios.test.ts`), because the project's type check has no Node types.

## Style

- TypeScript strict, no `any` without a reason. Match the surrounding code; there is no formatter config to run.
- Interface text is short, plain and free of jargon. Do not claim compliance, certification or precision the code does not measure. Estimates are labelled as estimates.
- Every model-backed step needs a local fallback, so the app works without a key.
- Add dependencies only with a strong reason; versions are pinned exactly.

## Commits and pull requests

- One logical change per commit, with an imperative subject that says what changed ("Fix door swing check on rotated doors").
- Do not commit generated build output, keys or personal data.
- A pull request describes what changed and why, lists the checks you ran, and includes a screenshot for visible changes. Update the docs that your change makes untrue.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
