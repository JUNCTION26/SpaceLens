# Features

The full list, by area. The short version is in the [README](../README.md); how to drive each part is in [USAGE.md](USAGE.md).

## Interface

- One left panel holds everything: the five destinations on the rail (Space, Design, Furnish, Review, Share), the sections of the chosen destination as tabs, then the section itself. Nothing opens over the plan or the 3D view.
- Messages show as one quiet line at the bottom of the panel.
- The Inspector for a selected item, wall, opening or room sits at the top of the panel. Esc closes it.
- Settings and search are panel content too. Search is the field in the top bar (Ctrl K); its results replace the panel until you pick one.
- The assistant is pinned at the bottom of the panel: type, talk, or turn on hands-free.
- The top bar carries the project name, undo, redo, search, full screen and share.
- Installable web app: a manifest with an icon and standalone display lets a phone add it to the home screen.

## Space

**Measure**
- W, D and H of the room are typed at the top of Space > Measure. Click a size on the plan and type to change a wall. Or say it: "make the room 5 by 6". See [USAGE.md](USAGE.md#resize-a-room).
- Phone camera capture with floor-plane calibration from an A4 sheet, and a manual measured drawing for when a photo is not practical.
- Every measurement keeps its source (measured, read from a drawing, typed, or estimated) and an uncertainty.

**Photo to room**
- Up to six photos of one room, or a short video (five evenly spaced frames are taken in the browser, long side at most 1 024 px), are read together by a Gemini vision model into a rectangular room (width, depth, ceiling height), its doors and windows, and each piece of furniture with its size and position. Each piece starts from the closest catalogue item; anything else becomes a generated custom object at its estimated size.
- Everything from the photos is marked photo-inferred and estimated, with the model's confidence. Typing the real length of one wall afterwards marks that wall user-measured and rescales the room.
- Needs a Gemini key (your own or the optional server). Stronger vision models are tried first.

**Drawings**
- Open PDF or image blueprints and index their text, dimensions, scale and room labels in the browser.
- Ask about counts, areas, lengths and labels, in several languages. Answers come from the local index first and name their kind: printed on the page, calculated, or inferred. Gemini is a fallback, never the first choice.
- Highlighted evidence regions on the page for every answer.
- Vector PDF plans become a multi-room model with evidence on every wall; see the benchmark below.
- ASCII DXF files open too: lines, polylines, arcs, circles, block inserts and text are read, units come from the file header (when the file does not say, they are guessed from the drawing's extent and the result is flagged), and rooms are built from the outlines. DXF files are treated as untrusted input and capped at 400 000 entities.
- IFC files open too: each IfcSpace becomes a room from its footprint, name and height, marked estimated. Only extruded footprints are read, and the file is treated as untrusted input.

**Floor**
- Pick an outer shell (rectangle, L-shape or the current room), an entrance and windows, then a room programme (for example a villa with three bedrooms) or describe one in words.
- A partition step divides the floor into rooms with minimum widths and zones, checks connectivity, and assembles one space per room with shared walls, doors on both sides and windows on facades. All of it is labelled as a generated estimate.
- Whole buildings can be furnished room by room, walked through doors and toured automatically. The three demo buildings (villa, office, L-shape) furnish every room in one step.

## Design

**Describe**
- Say who uses a space and how; the request becomes typed requirements (people, items, budget, lock what must stay).
- Follow-up sentences edit the room that is already there: "move the sofa to the window", "add two plants", "make the room 5 by 6". An offline rule layer answers the common phrases at once in English, Swedish and Finnish; everything else goes to the model. Both end in the same validator, so no change leaves furniture outside the room, overlapping, or blocking a door.
- When a request cannot be satisfied, it says why and suggests the smallest relaxation.

**Layouts**
- A layout solver places pieces from relations (against a wall, faces, flanks, beside, in front of, on a rug and more), returns several different candidates, and ranks them by 42 design rules ([list](DESIGN-RULES.md)).
- Candidates are cards with a plan thumbnail, a check ring and chips. Click a card to preview it on the plan, open Why for the decisions behind it, then Apply.
- A second-opinion critic judges the major decisions and may propose at most three fixes; fixes go back through the solver and the rules like any other change.
- Layout search has a hard wall-clock ceiling (20 s by default). Past it the search stops expanding and returns the best layout found so far.
- When a room cannot hold every piece, the layout still comes back with the left-out pieces and any reduced clear space recorded on it.

**Checks** lists the independent checker's verdicts for the current layout. **Style** takes a palette and style from a photo.

**Taste**
- The app learns from what you do: which layouts you apply or skip, what you move, add or remove, colours and materials you pick, and budgets you set. Signals fade with a 21-day half-life.
- From them it builds a small profile (open floor or full, against the wall or floating, symmetric or relaxed, how much you spend, where desk, bed and sofa sit relative to the window, favourite colours and materials, categories you keep removing). A trait with too little evidence is ignored.
- The profile nudges the solver weights and some design rules and adds short hints to the planner prompt. It is shown in the Layouts and Style panels, can be switched off and cleared, and lives only in your browser storage.

## Furnish

**Library** is the furniture catalogue with Poly Haven models.

**Create**
- Describe any piece in words, or from a photo. The model streams its parts, the object assembles on screen while it is written, and the result is fitted to your exact dimensions.
- Each object has semantics (role, use zones, how it opens or unfolds) so the design rules treat it like a catalogue piece.
- Geometry is validated and repaired automatically; without a key a parametric template library takes over.
- Measured on 18 varied prompts with the lite Gemini models: 14 recognisable at a glance and 4 partly so, first parts on screen after about 1.15 s and the complete object after about 2.2 s (median).

**Shop**
- Search real listings for a request such as "grey 3-seat sofa under 6 000 kr, max 220 cm wide". Prices and sizes are read from the product page itself.
- The product finder asks a search-grounded model for up to three IKEA Sweden or Finland products that fit the spot an item stands in, then reads every candidate's page again. A candidate is dropped if the page does not load, redirects to a general page, shows no price, shows no full size or does not fit the free window. A URL or price the page does not show is never kept.
- Each listing is checked against the budget, a free spot in the room and the door, and can be placed into the plan as a stand-in.
- The choice is decided by measured facts; a model only words the reasons.

**Budget**
- Keep the shopping list inside a budget with a move for each piece: swap to a cheaper catalogue twin, drop a decor piece, or keep it. Essential pieces (bed, desk, sofa, table and similar), locked pieces and pieces you already own are never dropped. The plan shows the saving per move and the total after the suggested ones.

## Review

**Walk**
- Orbit view and an eye view. In the eye view W A S D move, the arrow keys look, dragging the mouse looks, Shift walks faster and Esc leaves. It starts in the corner farthest from the windows, looking at the middle of the room, and glides back to the orbit view on exit.
- Routes checked against body profiles, a will-it-fit-through-the-door search over position and rotation, sightlines, and a crowd heatmap.
- Optional WebXR. The immersive buttons appear only for modes the browser reports as supported. In AR, tap two points on the real floor to measure a distance; the length can feed the wall-length field.

**Safety**
- One **Drill** control: set a people count, press Drill, and everyone walks out on the plan with a clock. Block an exit to see what changes; the result names the bottleneck and the smallest suggested fix.
- A **Fire** tab and an **Access** tab list findings room by room, each with Show and, where one exists, Fix. Fire covers travel distance to an exit, dead ends, a second exit above a set occupancy, door swing and clear zones at exits. Access covers wheelchair route widths, turning space and reach.
- Equipment suggestions place smoke alarms, extinguishers, exit signs and fire blankets on the plan.
- Country rule packs for Finland and Sweden replace the generic defaults with values read from the current texts on 2026-11-15: the Finnish decrees 241/2017, 848/2017 and 1008/2017, and Boverket's BFS 2024:7 (fire) and BFS 2024:12 (accessibility), in force since 2025-07-01. Each value shows its section, link and type. [RULE-SOURCES.md](RULE-SOURCES.md) lists every value, the amendments checked and what could not be confirmed. The packs are planning guidance: requirements depend on building type, size and permit date, and the app does not check compliance.
- A printable report (Report): every check with the measured value, the required value, the rule source and its confidence, numbered findings with a suggested fix, routes and exits on the plan, and a disclaimer.
- Every threshold is a visible, editable default with its reason ([SAFETY-ASSUMPTIONS.md](SAFETY-ASSUMPTIONS.md)).

## Share

**Export**
- Three groups: Share, Files, List.
- Share: copy a link, show a QR code inline in the panel for the same link, or send two to four layouts as a poll (`?poll=<id>`, one vote per browser; needs the optional API server).
- Files: SVG and PDF plan, CSV schedule and quantities, GLB model, JSON, DXF, IFC4 and USDZ.
- DXF: ASCII DXF in metres with layers WALLS, DOORS, WINDOWS, FURNITURE, DIMENSIONS, TEXT and ROOMS, written y-up so the plan looks the same in CAD.
- IFC4: spaces, walls, doors, windows and furniture for BIM tools, written with y and z up, an opening void cut in each wall for its door or window, and stable ids so a re-export keeps them.
- USDZ: "View in AR" writes the design (or one piece) at true scale. On an iPhone it opens in AR Quick Look; other devices download the file.
- List: a shopping list built from the furniture in the model (name, size in cm, quantity, unit price, link or IKEA search), totals per currency, CSV download. Find on a line runs the product finder for that piece; Find all runs it for the unlisted ones, three at a time.

**Move in**
- For each piece the route from the entrance to its room is tested through every door on the way. Each piece gets a verdict: fits, tilt it on edge, assemble inside (flat-pack halves each side) or won't fit, with the door that decides it.
- Pieces are ordered for arrival: deepest into the building first, larger before smaller. Play runs the carry-in on the plan with a timeline and speeds.

**Render** asks an image model for a picture of the finished room.

## The assistant

- Type, hold or tap the mic (or press V), or turn on hands-free for a spoken conversation. Replies can be spoken or muted.
- It sees a compact picture of the room, so "the wall by the window" and "that one" resolve to real things.
- Before it changes anything it sketches the change on the plan, then acts through the same store and checker as the manual tools. Everything is undoable.
- Instant answers need no model and no key. About a room: size, area, perimeter, ceiling height, door and window counts, item counts, prices, distances and where a piece is. About a whole plan: room counts, the largest or smallest room, which rooms have no window, how rooms connect, the longest walk to an exit, narrow doors, wheelchair access, daylight, and the walk between two named rooms. English, Swedish and Finnish wording is understood.

## Blueprint to building: benchmark

Room outlines become spaces, wall thickness comes from the drawing, door symbols and window openings are placed on the walls they sit in, and printed room areas are checked against the computed ones. It runs in the browser in about 0.2 s per plan with zero model calls.

Results on the 65 Swiss Dwellings plans of the Stoa dataset (`node scripts/stoa-build.mjs`, [`public/samples/stoa/build-results.json`](../public/samples/stoa/build-results.json)):

| Measure | Result |
| --- | --- |
| Plans built | 63 of 65 (96.9%) |
| Rooms closed into an outline | 1 602 of 1 618 numbered rooms (99%) |
| Printed room areas matched within 2% | 98.7% of 550, median error 0% |
| Same check on rooms built from walls alone | 84.4% of 390 within 2%, median error 0.32% |
| Room-area questions answered from the built model | 130 of 130 |
| Room-count questions (by label) | 388 of 405 (95.8%) |
| Door counts exactly right | 49.2% (32 of 65), weak |
| Window counts exactly right | 12.3% (8 of 65), weak |
| Median time per plan, model calls | 201 ms, 0 |

The 98.7% figure relies on room outlines drawn in the PDFs; when a room is built from its walls alone the share within 2% is 84.4%. Door and window detection is the weak part and its counts should be checked by eye on the highlighted page. Scanned plans are not handled.

## Blueprint questions: benchmark

The drawings answerer was run against the Swiss Dwellings questions of the Stoa dataset (65 floor-plan PDFs, 2 358 questions, counts scored exactly and areas, lengths and volumes within 2%). The run uses the app's own answering code, makes no model calls and takes about 0.4 ms per question.

| | Questions | Answered | Correct | Accuracy when answered |
| --- | ---: | ---: | ---: | ---: |
| All | 2 358 | 1 124 | 1 118 | **99.5%** |
| Counts | 1 614 | 940 | 940 | 100% |
| Areas | 744 | 184 | 178 | 96.7% |

It abstained on 1 234 questions (coverage 47.7%), so the share of all questions answered correctly is 47.4%. The reasoning is deliberate: a wrong confident answer on a blueprint is worse than saying "I cannot tell from this page". Full results are in [`public/samples/stoa/eval-results.json`](../public/samples/stoa/eval-results.json); three example plans ship with the app.

```bash
node scripts/stoa-eval.mjs <path-to>/junction-dataset-preview --source swiss_dwellings --limit 2358
```

The run rewrites `public/samples/stoa/eval-results.json`.
