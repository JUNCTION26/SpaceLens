# Changelog

All notable changes, grouped by area. The project is at version 0.1.0 and has no tagged releases yet, so entries are not tied to release numbers; the full history is in `git log`.

## Unreleased

### Rooms, formats and sharing
- Photo to room: one photo becomes an editable, estimated room with furniture and openings; unknown pieces are generated as custom objects; one measured wall rescales the room.
- Move-in planner: each piece is tested through every door from the entrance to its room (fits, tilt, assemble inside, won't fit), with an arrival order.
- Share and vote: a layout poll link backed by the API server (in-memory, 48 hours, one vote per browser token).
- Taste learning: a local profile from applied, skipped, moved and removed layouts and pieces that weights the solver and planner hints; viewable, switchable and clearable.
- Finland and Sweden rule packs with document, section and link for every value, listed in `docs/RULE-SOURCES.md`. Planning guidance, not a compliance check.
- DXF import in the Drawings panel; IFC4 export.
- Shopping list with CSV download; USDZ export for AR Quick Look.
- Layout search stops at a wall-clock ceiling (20 s by default) and returns the best layout found.

### Security and documentation
- Content-Security-Policy for production builds, with a threat model, security policy and privacy note.
- Import boundary check (`npm run check:boundaries`) run in CI.
- Architecture reference rewritten, with decision records under `docs/adr/`.
- A zero-dependency API server in `server/` that holds the model key, validates requests, checks origin and rate limits.
- Gemini key accepted from a private setup link (after the `#`), saved in the browser and removed from the address.

## Capture and drawings
- Capture a room from photos with calibration, or draw it by hand.
- Read text-based PDF plans in the browser: dimensions, scale, room labels and unit labels, with a drawings answerer that cites page regions and abstains when the page does not support an answer.
- Benchmark of the answerer on the Stoa questions, with German, Italian and French plans.
- Read PDF drawing operators into page paths; use drawn room outlines when a sheet has them.

## Plan to building
- Build a multi-room model from a vector plan with evidence on every wall, printed versus computed areas, and a Build 3D view.
- Door and window detection improvements; windows can end on door openings.
- Plan and furnish buildings in Web Workers; design one room of a building at a time.
- Partition a shell into rooms and corridors from a programme, with a connectivity check.

## Design and layout
- Typed relations with reasons, a constructive solver, an independent geometric referee, 40 and then 42 named design rules, and a critic that may adjust at most three relations.
- Deterministic, seeded search; the fallback annealer runs a fixed number of steps.
- Decision trail under each layout; layouts shown at the same scale with metric bars; rule-based layouts appear at once and update as model results arrive.
- Scenario tests for homes, offices, a kitchen-dining room, a home gym, a classroom and a clinic.
- Themes and briefs that steer a layout.

## Objects and furniture
- Create any object from a description: the model writes parts and kits, code expands them, fits them to the exact size and checks them. Kits for drawers, shelves, bedding, cushions and wall decor, among others.
- Catalogue of furniture with CC0 3D models scaled to true size; plan symbols for generated objects.
- Voice commands that place, resize, move and remove furniture.

## Shop and budget
- Search, paste a product link or drop a listing photo; read price and size from the page; check each listing against a free spot, the door and the budget.
- Budget optimiser with swaps checked by the rules and the referee, and a now, next, later purchase plan.

## Safety and simulation
- Routes, exits, dead ends, wheelchair access, extinguisher and alarm placement, and an evacuation simulation; printable plan. Stated defaults in `docs/SAFETY-ASSUMPTIONS.md`.
- Furniture passage and crowd simulation.

## Model access
- Streaming Gemini client, model router that ranks by measured latency, hedges slow starts and marks failing models unhealthy, and plain error categories for the interface.
- Optional streaming voice that is used only when it starts quickly.

## Agent
- A talking agent that sketches each action on the plan before running it, resolves "that" and "here", and has offline commands.

## Interface
- Design tokens, a slim rail with five destinations, command palette, onboarding coach, guided demo, light and dark themes, mobile layout, error recovery screen, and notices with one-click fixes.
- 3D view with damped orbit, pan, zoom to cursor, walk mode, WebXR and AR Quick Look.

## Export
- Dimensioned SVG and PDF plans, CSV schedule, GLB model, project file, share links.

## Tooling
- CI for type check, tests and build; GitHub Pages deployment.
- Headless browser scripts for screenshots, state checks and performance in `scripts/e2e`.
