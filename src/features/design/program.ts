import type { DesignProgram, DesignZone, FurnitureItem, Relation, Requirements, SpaceModel } from '../../core/types';
import { assignZones } from './rules';
import { isHostCategory, isSeatCategory, semanticsOf, type ZoneKind } from './semantics';

const ZONE_NAMES: Record<ZoneKind, [string, string]> = {
  sleep: ['Sleeping', 'Rest, away from the door and the desk'],
  work: ['Work', 'Focused work with daylight from the side'],
  lounge: ['Lounge', 'Sitting together around a focal point'],
  dining: ['Dining', 'Eating and talking around tables'],
  service: ['Counter', 'Serving and preparing'],
  storage: ['Storage', 'Keeping things within reach'],
  decor: ['Accents', 'Softening corners and lighting'],
};

/** Which desk, table or counter each seat belongs to. Desks get one chair each first. */
export function assignSeatHosts(items: FurnitureItem[]): Map<string, string> {
  const out = new Map<string, string>();
  const desks = items.filter((f) => /desk/.test(f.category));
  const tables = items.filter((f) => isHostCategory(f.category) && !/desk|counter/.test(f.category));
  const counters = items.filter((f) => /counter/.test(f.category));
  const load = new Map<string, number>();
  const take = (seat: FurnitureItem, pool: FurnitureItem[], cap: (h: FurnitureItem) => number) => {
    const free = pool.filter((h) => (load.get(h.id) ?? 0) < cap(h));
    if (!free.length) return false;
    const h = free.reduce((a, b) => ((load.get(b.id) ?? 0) < (load.get(a.id) ?? 0) ? b : a));
    out.set(seat.id, h.id); load.set(h.id, (load.get(h.id) ?? 0) + 1);
    return true;
  };
  const seatCap = (h: FurnitureItem) => {
    const sides = [h.clearance.front, h.clearance.back, h.clearance.left, h.clearance.right];
    const spans = [h.w, h.w, h.d, h.d];
    return Math.max(1, sides.reduce((t, c, i) => t + (c >= 0.3 ? Math.max(1, Math.floor((spans[i] + 0.1) / 0.55)) : 0), 0));
  };
  const seats = items.filter((f) => isSeatCategory(f.category));
  for (const s of seats) {
    const stool = s.category === 'stool';
    const ok = stool
      ? take(s, counters, () => Math.max(1, Math.floor(2))) || take(s, tables, seatCap) || take(s, desks, () => 1)
      : take(s, desks, () => 1) || take(s, tables, seatCap) || take(s, counters, (h) => Math.max(1, Math.floor(h.w / 0.6))) || take(s, [...desks, ...tables, ...counters], () => 99);
    void ok;
  }
  return out;
}

/** The program the solver follows when no planner is available: zones and relations from what each piece is. */
export function defaultProgram(model: SpaceModel, items: FurnitureItem[], req?: Requirements | null): DesignProgram {
  const rel: Relation[] = [];
  const add = (r: Relation) => rel.push(r);
  const by = (cat: string | RegExp) => items.filter((f) => (typeof cat === 'string' ? f.category === cat : cat.test(f.category)));
  const first = (cat: string | RegExp) => by(cat)[0];
  const bed = first(/^(bed|bunk-bed)$/), sofa = first(/^sofa/), tv = first('tv-unit'), coffee = first('coffee-table');
  const desks = by('desk'), table = first(/^(table|kitchen-island)$/), cafe = by('cafe-table');
  const hasWindow = model.openings.some((o) => o.kind === 'window');
  const hosts = assignSeatHosts(items);

  for (const f of items) {
    const c = f.category, s = semanticsOf(f);
    switch (c) {
      case 'bed': case 'bunk-bed':
        add({ kind: 'against-wall', subject: f.id, weight: 1, reason: 'A headboard against a solid wall feels secure and leaves the floor open.' });
        add({ kind: 'away-from-door', subject: f.id, target: 'door', distanceM: [1.2, 9], weight: 0.4, reason: 'Sleeping out of the doorway line is calmer and more private.' });
        if (desks[0]) add({ kind: 'apart-from', subject: f.id, target: desks[0].id, distanceM: [0.9, 9], weight: 0.3, reason: 'Keeping the desk away from the bed separates work from rest.' });
        break;
      case 'nightstand':
        if (bed) add({ kind: 'flanks', subject: f.id, target: bed.id, weight: 1, reason: 'A nightstand at the head of the bed puts a lamp and a glass of water in reach from the pillow.' });
        else add({ kind: 'against-wall', subject: f.id, weight: 0.6, reason: 'Small storage stands best against a wall.' });
        break;
      case 'wardrobe': case 'dresser':
        add({ kind: 'against-wall', subject: f.id, weight: 0.9, reason: 'Storage against a wall keeps its doors and drawers usable and the floor open.' });
        if (bed) add({ kind: 'beside', subject: f.id, target: bed.id, distanceM: [0, 2.0], weight: 0.3, reason: 'Clothes storage near the bed keeps the dressing route short.' });
        if (f.h > 1.2 && hasWindow) add({ kind: 'apart-from', subject: f.id, target: 'window', distanceM: [0.5, 9], weight: 0.4, reason: 'Tall storage on a windowless wall keeps the daylight.' });
        break;
      case 'desk':
        add({ kind: 'against-wall', subject: f.id, weight: 0.8, reason: 'A desk with its back to a wall leaves the room open and hides the cables.' });
        if (hasWindow) add({ kind: 'near-window', subject: f.id, target: 'window', distanceM: [0, 1.5], weight: 0.7, reason: 'Daylight from the side is the best light to work in, without glare on the screen.' });
        break;
      case 'sofa': case 'sofa-bed':
        if (tv) add({ kind: 'faces', subject: f.id, target: tv.id, distanceM: [2.1, 3.5], weight: 1, reason: 'The sofa faces the TV at 1.5-2.5 times the screen diagonal.' });
        else if (coffee) add({ kind: 'faces', subject: f.id, target: coffee.id, weight: 0.6, reason: 'Without a TV the sofa faces into the room and the coffee table.' });
        else if (hasWindow) add({ kind: 'faces', subject: f.id, target: 'window', weight: 0.5, reason: 'Without a TV the view becomes the focal point.' });
        add({ kind: 'against-wall', subject: f.id, weight: 0.4, reason: 'A sofa against a wall saves floor; floating it needs a walkway behind.' });
        break;
      case 'tv-unit':
        add({ kind: 'against-wall', subject: f.id, weight: 1, reason: 'The TV sits on the wall the seating faces.' });
        if (hasWindow) add({ kind: 'apart-from', subject: f.id, target: 'window', distanceM: [0.6, 9], weight: 0.3, reason: 'A screen beside a window is hard to see against the light.' });
        break;
      case 'coffee-table':
        if (sofa) add({ kind: 'in-front-of', subject: f.id, target: sofa.id, distanceM: [0.45, 0.5], weight: 1, reason: 'About 45 cm from the sofa: a cup is in reach and knees still pass.' });
        break;
      case 'armchair':
        if (coffee) add({ kind: 'beside', subject: f.id, target: coffee.id, distanceM: [0.45, 0.7], weight: 0.8, reason: 'An armchair at the end of the coffee table closes the conversation circle.' });
        else if (sofa) add({ kind: 'beside', subject: f.id, target: sofa.id, distanceM: [0.3, 0.9], weight: 0.6, reason: 'An armchair angled to the sofa makes a conversation group.' });
        break;
      case 'rug':
        if (coffee) add({ kind: 'centered-on', subject: f.id, target: coffee.id, weight: 0.7, reason: 'A rug under the coffee table and the front legs of the seats ties the group together.' });
        else if (table) add({ kind: 'centered-on', subject: f.id, target: table.id, weight: 0.7, reason: 'A dining rug wide enough that pulled-out chairs stay on it.' });
        else if (bed) add({ kind: 'centered-on', subject: f.id, target: bed.id, weight: 0.5, reason: 'A rug under the lower two thirds of the bed gives a soft first step.' });
        break;
      case 'lamp': {
        const host = sofa ?? first('armchair') ?? desks[0] ?? bed;
        if (host) add({ kind: 'beside', subject: f.id, target: host.id, distanceM: [0, 0.3], weight: 0.5, reason: 'A floor lamp beside a seat gives reading light where it is needed.' });
        break;
      }
      case 'plant':
        add({ kind: 'in-corner', subject: f.id, weight: 0.5, reason: 'A plant softens an empty corner.' });
        break;
      case 'table': case 'kitchen-island':
        add({ kind: 'centered-on', subject: f.id, target: 'room-centre', weight: 0.6, reason: 'A table centred in its zone leaves even room to walk round.' });
        break;
      case 'cafe-table':
        if (cafe[0] && cafe[0].id !== f.id) add({ kind: 'aligned-with', subject: f.id, target: cafe[0].id, weight: 0.4, reason: 'Tables in rows read as calm and leave straight aisles.' });
        break;
      case 'counter': case 'reception-desk':
        add({ kind: 'against-wall', subject: f.id, weight: c === 'counter' ? 1 : 0.4, reason: 'A counter on a wall leaves the floor to the guests.' });
        add({ kind: 'faces', subject: f.id, target: 'door', weight: 0.3, reason: 'Staff at the counter see who comes in.' });
        break;
      case 'crib':
        add({ kind: 'against-wall', subject: f.id, weight: 0.8, reason: 'A crib against a wall is safer and out of the way.' });
        if (bed) add({ kind: 'beside', subject: f.id, target: bed.id, distanceM: [0, 1.5], weight: 0.4, reason: 'The crib within reach of the parents\' bed.' });
        break;
      case 'office-pod':
        add({ kind: 'in-corner', subject: f.id, weight: 0.6, reason: 'A booth in a corner keeps the floor open.' });
        break;
      default:
        if (isSeatCategory(c) && hosts.has(f.id)) {
          const h = items.find((x) => x.id === hosts.get(f.id))!;
          add({ kind: 'paired-seat', subject: f.id, target: h.id, weight: 1, reason: `A seat drawn up to the ${h.name.toLowerCase()}, with room behind to pull it out.` });
        } else if (s.wallBacked) add({ kind: 'against-wall', subject: f.id, weight: 0.8, reason: `${f.name} stands against a wall, its front free to use.` });
    }
  }

  // Zones from what each piece is for.
  const zoneOf = assignZones(items);
  for (const [seat, host] of hosts) zoneOf.set(seat, zoneOf.get(host) ?? zoneOf.get(seat)!);
  const zones: DesignZone[] = [];
  for (const [id, kind] of zoneOf) {
    let z = zones.find((x) => x.id === `zone-${kind}`);
    if (!z) { const [name, purpose] = ZONE_NAMES[kind]; z = { id: `zone-${kind}`, name: kind === 'dining' && cafe.length ? 'Seating' : name, purpose, itemIds: [] }; zones.push(z); }
    z.itemIds.push(id);
  }
  const focal = tv ?? bed ?? first(/counter|reception/) ?? sofa ?? desks[0] ?? table ?? cafe[0];
  const notes: string[] = [];
  if (req?.people && req.people > 1 && desks.length >= 2) notes.push(`${desks.length} workstations for ${req.people} people.`);
  if (!hasWindow) notes.push('No window measured, so daylight rules were skipped.');
  return { zones, relations: rel, focalItemId: focal?.id, notes, by: 'rules' };
}
