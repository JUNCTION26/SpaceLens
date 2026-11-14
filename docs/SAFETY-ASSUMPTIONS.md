# Safety and accessibility assumptions

The Safety section checks escape routes, exits and accessibility for every room and door in the model. It is a planning aid built on the rule-of-thumb defaults below. It is not a code compliance check, it does not certify anything, and the app never says a building is compliant.

What it does:

- Finds the walkable floor, the exits and the width of every route, and measures the walk from each point to the nearest exit.
- Flags routes narrower than the default, dead ends, a long walk with only one way out, items crowding an exit, inward-swinging exit doors for larger groups, and a missing second exit above a stated occupancy.
- Checks wheelchair routes, door widths, turning space and space beside beds and desks.
- Suggests where an extinguisher and a smoke alarm would be reached, and proposes small moves (never larger than the "largest suggested move") that fix a finding.
- Estimates an evacuation: each person walks the shortest safe route and queues at doors that pass a limited number of people per second.
- Draws a printable A4 evacuation plan with exits, escape arrows, equipment, a legend and these assumptions.

Every value below can be changed in the Safety panel. Where the room's furniture does not say how many people use a room, occupancy comes from the floor area per person.

The tables are generated from `SAFETY_DEFAULTS` in `src/features/safety/assess.ts`:

```bash
npm run docs:safety
```

## Defaults

### Escape routes and fire planning

| Setting | Default | Why |
| --- | --- | --- |
| Escape route width (`routeWidthM`) | 0.9 m | Lets one person walk fast with a little room to spare, or two pass sideways. |
| Width at doors (`doorWidthM`) | 0.8 m | A doorway is short, so a slightly narrower gap is accepted there. |
| Tightest passable gap (`squeezeM`) | 0.5 m | Below this an adult cannot get through, even sideways. |
| Longest walk to an exit (`maxTravelM`) | 30 m | Beyond about 30 m smoke can overtake people before they reach a way out. |
| Walk with only one way out (`singleDirectionM`) | 15 m | With no alternative route, a shorter limit keeps people from being cut off. |
| Dead-end aisle length (`deadEndM`) | 6 m | In a dead end you must walk back towards the danger; keep them short. |
| Clear zone at exit doors (`exitClearM`) | 0.5 m | Things next to an exit get knocked over and pile up in a rush. |
| People needing a second exit (`twoExitsOccupancy`) | 30 people | Above about 30 people one blocked door traps everyone; codes set this between 30 and 60. |
| Max people for inward exit door (`inwardSwingMaxOccupants`) | 50 people | A crowd pushing on a door that opens towards them can hold it shut. |
| Floor area per person (`areaPerPersonM2`) | 10 m² | Used when furniture does not show how many people use a room; office-like density. |
| Comfortable width for a crowd (`pinchWidthM`) | 1.2 m | Two streams of people can move side by side at about 1.2 m. |
| People before pinch points matter (`pinchOccupancy`) | 10 people | Small groups get through narrow spots; larger groups queue. |
| Walk to an extinguisher (`extinguisherTravelM`) | 20 m | Guidance usually keeps one within 15 to 25 m of anywhere. |
| Smoke alarm reach (`alarmRadiusM`) | 7.5 m | A ceiling smoke alarm covers roughly this radius in an open room. |
| Largest suggested move (`maxMoveM`) | 1 m | Fixes stay small so the room still works the way it is laid out. |

### Accessibility

| Setting | Default | Why |
| --- | --- | --- |
| Wheelchair route width (`wheelchairRouteM`) | 0.9 m | A manual wheelchair is about 0.7 m wide plus room for hands on the wheels. |
| Wheelchair door clear width (`wheelchairDoorM`) | 0.8 m | Clear opening a wheelchair can pass without scraping knuckles. |
| Turning circle (`turningM`) | 1.5 m | Space to turn a wheelchair fully around without reversing. |
| Space beside beds and desks (`besideM`) | 0.8 m | Room to pull up alongside and transfer or work. |
| Door leaf allowance (`doorLeafM`) | 0.04 m | An open hinged door eats roughly 4 cm of the frame width. |
| Reversing distance (`wheelchairDeadEndM`) | 3 m | Reversing a wheelchair further than this without a turning spot is hard. |

### Evacuation simulation

| Setting | Default | Why |
| --- | --- | --- |
| Walking speed (`walkSpeedMS`) | 1 m/s | A brisk but cautious pace indoors, slower than a free walk because of crowding. |
| Slower walking speed (`slowSpeedMS`) | 0.5 m/s | Someone with a walking aid, a small child or a heavy bag. |
| Door flow per metre (`doorFlowPerMS`) | 1.3 people/s | A widely used figure for how many people pass a metre of door each second. |

### Not assessed

- Fire resistance of walls, doors and ceilings
- How smoke and heat spread
- Sprinklers, emergency lighting and alarm wiring
- Thresholds, steps, ramps and floor surfaces
- Door opening force, locks and panic hardware
- Stairs, lifts and floors above or below
- Your local building and fire code
