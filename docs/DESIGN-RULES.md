# Design rules

Every layout the app proposes is scored by these rules (`src/features/design/rules.ts`). Each rule is a pure function of the room and the furniture that returns a score from 0 to 1 and a plain sentence with the measured numbers.

- **Hard** rules mirror the independent referee. A layout that breaks one is not valid and is never returned.
- **Strong** rules are good practice for the kind of room. A score under 0.6 counts as a failed rule and is shown with its reason.
- **Preference** rules are tie-breakers that shape taste. They rank layouts but do not invalidate them.

Some rules need the floor grid and are skipped in the solver's fast inner loop (last column); they run on the final candidates. Thresholds are the figures in the "Threshold or source" column. Where a rule gives only a reason, its numbers come from the measured geometry of the room.

These are interior planning conventions, not building regulations. The table is generated from the source so it cannot drift:

```bash
npm run docs:rules
```

## Rules

| Rule | Id | Severity | Threshold or source | Needs floor grid |
| --- | --- | --- | --- | --- |
| Inside the room | `inside-room` | hard | Measured outline | no |
| No overlaps | `no-overlap` | hard | Footprints | no |
| Use space kept free | `use-zones` | hard | Catalogue use zones | no |
| Door swing clear | `door-swing` | hard | Door leaf width | no |
| Door approach clear | `door-approach` | hard | 80 cm landing inside doors | no |
| Windows reachable | `window-access` | hard | Tall pieces kept 40 cm off windows | no |
| Unfolds freely | `unfold` | hard | Unfolded depth | no |
| Main walkway | `walkway-main` | strong | 80 cm main circulation | yes |
| Every piece reachable | `walkway-secondary` | strong | 60 cm secondary paths | yes |
| Headboard on a wall | `bed-headboard` | strong | Bedroom planning practice | no |
| Bed access | `bed-access` | strong | 60 cm beside a double, one side for a single | no |
| Nightstands flank the bed | `nightstands` | strong | Reach from the pillow | no |
| Desk chair pull-out | `desk-pullout` | strong | 75-90 cm behind the desk edge | no |
| Desk near daylight | `desk-daylight` | strong | Task light | no |
| Seats face their table | `seats-face` | strong | Chair belongs to a surface | no |
| Room to pull chairs out | `dining-pullout` | strong | 75-90 cm behind table edges | no |
| Sofa faces the focal point | `sofa-focal` | strong | Seating faces what you look at | no |
| TV viewing distance | `tv-distance` | strong | 1.5-2.5 x screen diagonal | no |
| Coffee table in reach | `coffee-reach` | strong | 35-50 cm from the sofa front | no |
| Storage opens freely | `storage-access` | strong | Door and drawer swing | no |
| Zones stay apart | `zones` | strong | Sleep, work, lounge and dining do not interleave | no |
| Square to the walls | `parallel` | strong | Furniture follows the architecture | no |
| Backs to the wall | `wall-backed` | strong | Wall-backed pieces | no |
| Open floor | `open-floor` | preference | One usable open area | yes |
| Bed sees the door | `bed-command` | preference | Command position | no |
| Headboard off the window | `bed-window` | preference | Draughts and light at the head | no |
| Daylight from the side | `desk-glare` | preference | Screen glare | no |
| Back not to the door | `desk-door` | preference | Seated with a view of the entrance | no |
| Seats evenly spaced | `seats-even` | preference | Symmetry around a table | no |
| Table centred in its zone | `table-centred` | preference | Even circulation round a table | no |
| Repeated pieces line up | `aligned` | preference | Order through alignment | no |
| Conversation distance | `conversation` | preference | 1.8-3.0 m between seats | no |
| Armchair joins the group | `armchair-group` | preference | Closed conversation circle | no |
| Rug under the front legs | `rug-anchor` | preference | Rug ties the group together | no |
| Rug clear of the door | `rug-door` | preference | Door catches on rug edges | no |
| Lamp beside a seat | `lamp-seat` | preference | Reading light | no |
| Tall pieces on solid walls | `tall-walls` | preference | Keep daylight | no |
| Wardrobe near the bed | `wardrobe-bed` | preference | Short dressing route | no |
| Visual balance | `balance` | preference | Mass spread across the room | no |
| Clear focal point | `focal-point` | preference | A room needs one thing to look at | no |
| No awkward gaps | `dead-gaps` | preference | 10-45 cm slivers are wasted floor | no |
| Radiators and sockets | `services` | preference | Not measured | no |
