# 1. Metric typed model as the single source of truth

Status: accepted

## Context

Capture, plan reading, generation, shopping and the agent all produce knowledge about a place. If each kept its own representation, views and judges would disagree and undo would be per feature.

## Decision

One typed model in metres (`src/core/types.ts`): spaces as polygons with per-wall metadata, openings, furniture footprints, measurements and evidence. Every edit is a typed `Op` applied by the pure reducer in `src/core/ops.ts` through the one store (`src/core/store.ts`). Views and judges only read the model.

## Consequences

Undo, the change log, sharing and the Inspector behave the same for manual tools and the agent. New inputs must convert into the model, which costs effort (for example `building/assemble.ts`). Walls are straight and furniture is a 2D footprint plus stated heights; curved walls need a contract change in core.
