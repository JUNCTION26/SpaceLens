# 3. Relations then solve, not model-written coordinates

Status: accepted

## Context

Language models are good at intent ("the desk faces the window, the sofa flanks the rug") and unreliable at exact coordinates, clearances and door swings.

## Decision

The planner (`design/planner.ts`) emits zones and relations with reasons (against-wall, faces, flanks, beside, in-front-of, on-rug, apart-from, aligned-with). The solver (`design/solve.ts`) turns relations into positions by a constructive search. The critic (`design/critic.ts`) may change at most three relations and never moves geometry.

## Consequences

Model output cannot place furniture inside a wall or across a door. Quality is bounded by the relation vocabulary and the solver. Without a key a rule-based program feeds the same solver, so offline behaviour uses the same code path.
