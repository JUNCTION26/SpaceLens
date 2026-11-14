# 4. A kit vocabulary for generated objects

Status: accepted

## Context

Asking a fast model for every part of a drawer unit gives broken joinery, floating parts and inconsistent sizes.

## Decision

The model writes a few items from a fixed vocabulary of parts and 30 kits (`forge/kits.ts`: drawers, doors, shelves, bedding, legs, and so on). Code expands each kit into real parts inside the bounding box the model gave. `forge/fit.ts` scales to the requested size and `forge/validate.ts` checks and repairs geometry. Without a key, templates in `forge/library.ts` and `forge/rulesFallback.ts` apply.

## Consequences

Objects look more consistent and the model needs fewer tokens. Anything outside the vocabulary has to be built from basic parts. The result is a normal `FurnitureItem`, so the design rules apply to generated objects.
