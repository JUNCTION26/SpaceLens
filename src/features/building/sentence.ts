// One sentence to a room programme: "a 120 m² villa with 3 bedrooms and an open kitchen".
// Pure and instant; the programme feeds the planner, and the floor area gives the shell its size.
import { apartmentProgramme, cafeProgramme, clinicProgramme, officeProgramme, programmeArea, villaProgramme, type ProgrammeRoom, type RoomProgramme } from './programme';

export interface SentenceResult {
  programme: RoomProgramme;
  /** Floor area stated in the sentence, or the programme total grossed up for halls and walls. */
  areaM2: number;
  /** True when the sentence named something we know (a building type, a count or an area). */
  recognised: boolean;
}

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const NUMBER = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|fifty)';
const toN = (s: string | undefined) => (s == null ? NaN : /^\d+$/.test(s) ? Number(s) : WORDS[s] ?? NaN);
const first = (t: string, re: RegExp) => toN(t.match(re)?.[1]);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function scaleTo(p: RoomProgramme, areaM2: number): RoomProgramme {
  const total = programmeArea(p);
  const f = Math.min(2.5, Math.max(0.5, (areaM2 * 0.86) / total));
  const rooms = p.rooms.map((r) => {
    const pref = Math.round(r.preferredAreaM2 * f * 2) / 2;
    return { ...r, preferredAreaM2: pref, minAreaM2: Math.min(pref, Math.round(r.minAreaM2 * f * 2) / 2) };
  });
  return { ...p, rooms };
}

/** Make the programme hold exactly `n` rooms of a kind (by id prefix), cloning the first one. */
function withCount(p: RoomProgramme, prefix: string, n: number, name: (i: number) => string): RoomProgramme {
  const isKind = (id: string) => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length));
  const same = p.rooms.filter((r) => isKind(r.id));
  if (!same.length || n < 1) return p;
  const proto = same[0];
  const idx = p.rooms.indexOf(proto);
  const made: ProgrammeRoom[] = Array.from({ length: n }, (_, i) => ({ ...proto, id: `${prefix}${i + 1}`, name: name(i + 1), adjacentTo: i ? [`${prefix}${i}`] : proto.adjacentTo.filter((a) => !isKind(a)) }));
  const rest = p.rooms.filter((r) => !isKind(r.id));
  rest.splice(Math.min(idx, rest.length), 0, ...made);
  const ids = new Set(rest.map((r) => r.id));
  return { ...p, rooms: rest.map((r) => ({ ...r, adjacentTo: [...new Set(r.adjacentTo.map((a) => (isKind(a) && !ids.has(a) ? `${prefix}1` : a)))].filter((a) => ids.has(a) && a !== r.id) })) };
}

export function programmeFromSentence(text: string): SentenceResult {
  const t = text.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const area = Number(t.match(/(\d+(?:\.\d+)?)\s*(?:m²|m2|sqm|sq\.? ?m|square met(?:er|re)s?)/)?.[1]);
  const people = first(t, new RegExp(`${NUMBER}\\s*(?:people|persons|staff|employees|desks|workers|seats|guests)`));
  const beds = first(t, new RegExp(`${NUMBER}[\\s-]*(?:bed(?:room)?s?|br)\\b`));
  const roomWord = first(t, new RegExp(`${NUMBER}[\\s-]*(?:room(?:s)?\\b|rok)`));
  const meetings = first(t, new RegExp(`${NUMBER}\\s*(?:meeting|conference)`));
  const baths = first(t, new RegExp(`${NUMBER}\\s*(?:bath(?:room)?s?|wcs?|toilets?)`));
  let kind: 'home' | 'office' | 'cafe' | 'clinic' | 'flat' | 'villa' = 'villa';
  let recognised = Number.isFinite(area) || Number.isFinite(beds);
  if (/office|workplace|cowork|studio space|headquarters/.test(t)) kind = 'office';
  else if (/caf[eé]|coffee|restaurant|bistro/.test(t)) kind = 'cafe';
  else if (/clinic|dentist|doctor|physio|surgery/.test(t)) kind = 'clinic';
  else if (/flat|apartment|condo|studio|loft/.test(t)) kind = 'flat';
  else if (/villa|house|home|cottage|bungalow/.test(t)) kind = 'villa';
  if (kind !== 'villa' || /villa|house|home|cottage|bungalow/.test(t)) recognised = true;

  let p: RoomProgramme;
  switch (kind) {
    case 'office': p = officeProgramme(Number.isFinite(people) ? people : Number.isFinite(area) ? Math.round(area / 7) : 20); break;
    case 'cafe': p = cafeProgramme(Number.isFinite(people) ? people : Number.isFinite(area) ? Math.round(area / 1.9) : 30); break;
    case 'clinic': p = clinicProgramme(first(t, new RegExp(`${NUMBER}\\s*(?:exam|treatment|consult)`)) || 3); break;
    case 'flat': {
      const n = /studio/.test(t) && !Number.isFinite(roomWord) ? 1 : Number.isFinite(roomWord) ? roomWord : Number.isFinite(beds) ? beds + 1 : 2;
      p = apartmentProgramme(n); break;
    }
    default: p = villaProgramme(Number.isFinite(beds) ? beds : Number.isFinite(area) ? Math.max(1, Math.min(6, Math.round(area / 40))) : 3);
  }

  if (kind === 'office' && Number.isFinite(meetings)) {
    p = withCount(p, 'meeting-', Math.max(1, Math.min(8, meetings)), (i) => `Meeting room ${i}`);
    recognised = true;
  }
  if (Number.isFinite(baths) && baths > 1 && (kind === 'villa' || kind === 'flat')) {
    for (let i = 2; i <= Math.min(5, baths); i++) p.rooms.push({ ...p.rooms.find((r) => r.purpose === 'bathroom')!, id: `bath-${i}`, name: `Bathroom ${i}`, adjacentTo: [] });
  }
  if (/\b(?:study|home office)\b/.test(t) && (kind === 'villa' || kind === 'flat') && !p.rooms.some((r) => r.id === 'study')) {
    p.rooms.push({ id: 'study', name: 'Study', purpose: 'office', minAreaM2: 7, preferredAreaM2: 9, minWidthM: 2.4, needsWindow: true, adjacentTo: [], privacy: 'private', people: 1, brief: 'home office with a desk, chair and bookshelf' });
  }
  // an open kitchen is one room with the living room
  if (/open[\s-](?:plan\s)?(?:kitchen|living)|kitchen (?:open|and living)|open plan/.test(t) && kind === 'villa') {
    const living = p.rooms.find((r) => r.id === 'living'), kit = p.rooms.find((r) => r.id === 'kitchen');
    if (living && kit) {
      const merged: ProgrammeRoom = { ...living, name: 'Living & kitchen', preferredAreaM2: living.preferredAreaM2 + kit.preferredAreaM2 * 0.8, minAreaM2: living.minAreaM2 + kit.minAreaM2 * 0.7, adjacentTo: [], brief: 'living room with a sofa, coffee table and a dining table for 4', people: 4 };
      p.rooms = p.rooms.filter((r) => r.id !== 'kitchen').map((r) => (r.id === 'living' ? merged : { ...r, adjacentTo: r.adjacentTo.map((a) => (a === 'kitchen' ? 'living' : a)).filter((a) => a !== r.id) }));
      p.rooms = p.rooms.map((r) => ({ ...r, adjacentTo: [...new Set(r.adjacentTo)] }));
    }
  }
  if (/wheelchair|accessib/.test(t)) p.corridorWidthM = Math.max(p.corridorWidthM, 1.5);

  if (Number.isFinite(area)) { p = scaleTo(p, area); recognised = true; }
  const areaM2 = Number.isFinite(area) ? area : Math.round(programmeArea(p) / 0.86);
  // stable, unique ids after edits
  const seen = new Set<string>();
  p.rooms = p.rooms.map((r) => { let id = r.id || slug(r.name); for (let k = 2; seen.has(id); k++) id = `${r.id}-${k}`; seen.add(id); return { ...r, id }; });
  return { programme: { ...p, name: text.trim().slice(0, 60) || p.name, by: 'rules' }, areaM2, recognised };
}

/** Rectangle that holds `areaM2`, in half metres, a little longer than wide. */
export function shellForArea(areaM2: number): { w: number; d: number } {
  const a = Math.max(12, areaM2);
  const w = Math.max(4, Math.round(Math.sqrt(a * 1.25) * 2) / 2);
  const d = Math.max(4, Math.round((a / w) * 2) / 2);
  return { w, d };
}
