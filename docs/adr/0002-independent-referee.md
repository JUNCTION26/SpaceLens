# 2. An independent referee decides validity

Status: accepted

## Context

A solver that also judges its own output can be wrong in a way its own check cannot see, and a hand edit needs the same verdict as a generated layout.

## Decision

`src/features/referee/validate.ts` decides inside-room, overlap, door swing, approach and window access using `referee/geom.ts`, a geometry file kept separate from `core/geometry.ts`. Every layout returned by the design solver passes `validateLayout`. `scripts/check-boundaries.mjs` enforces that the referee's decision code imports only core types and its own files.

## Consequences

The verdict does not depend on solver code or on a model. The independence is partial: `design/solve.ts` reuses the referee's geometry primitives for its fast checks, so a bug in `referee/geom.ts` would reach both. The solver also mirrors some referee checks with a safety margin inside the referee's 1 cm tolerance, so two copies of those rules must be kept in step.
