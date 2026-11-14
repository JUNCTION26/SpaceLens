# 7. A deterministic, seeded solver

Status: accepted

## Context

Layout search is randomised. If it also stops on a wall-clock deadline, results differ between machines and tests become flaky.

## Decision

`design/solve.ts` uses a seeded xorshift generator and a fixed amount of search work. `timeBudgetMs` scales the work and is never compared to the clock. Variants use different seeds.

## Consequences

The same seed gives the same layouts, so scenario tests assert on outcomes and a bug report can be replayed. A slow machine takes longer rather than returning a worse layout.
