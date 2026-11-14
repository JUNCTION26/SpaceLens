// A room programme: the list of rooms a building should contain, with the sizes and needs an
// architect would ask for before drawing a single wall. Templates cover common briefs; a sentence
// can be turned into a programme by the model, with a rule-based reader as the fallback.
import { ai, aiReady } from '../../core/ai';

export type Privacy = 'public' | 'private' | 'service';

export interface ProgrammeRoom {
  /** Stable key within the programme, used for adjacency. */
  id: string;
  name: string;
  /** Short purpose tag: living, kitchen, bedroom, bathroom, wc, workspace, meeting... */
  purpose: string;
  minAreaM2: number;
  preferredAreaM2: number;
  /** Narrowest acceptable clear width, metres. */
  minWidthM: number;
  needsWindow: boolean;
  needsExteriorDoor?: boolean;
  /** Ids of rooms this one should share a wall (or a door) with. */
  adjacentTo: string[];
  privacy: Privacy;
  /** People using the room (desks, seats, beds); used when furnishing. */
  people?: number;
  /** Furnishing brief for the room designer. */
  brief?: string;
}

export interface RoomProgramme {
  name: string;
  kind: 'home' | 'office' | 'cafe' | 'clinic' | 'custom';
  rooms: ProgrammeRoom[];
  /** Clear corridor width, metres. */
  corridorWidthM: number;
  notes: string[];
  by: 'template' | 'gemini' | 'rules';
}

export const WET_PURPOSES = new Set(['bathroom', 'wc', 'utility', 'kitchen', 'shower', 'laundry']);
export const isWet = (r: Pick<ProgrammeRoom, 'purpose'>) => WET_PURPOSES.has(r.purpose);

type RoomSpec = Omit<ProgrammeRoom, 'id' | 'adjacentTo'> & { id?: string; adjacentTo?: string[] };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room';

function finish(name: string, kind: RoomProgramme['kind'], specs: RoomSpec[], corridorWidthM: number, notes: string[] = []): RoomProgramme {
  const used = new Set<string>();
  const rooms = specs.map((s) => {
    let id = s.id ?? slug(s.name);
    for (let k = 2; used.has(id); k++) id = `${s.id ?? slug(s.name)}-${k}`;
    used.add(id);
    return { ...s, id, adjacentTo: s.adjacentTo ?? [] };
  });
  const ids = new Set(rooms.map((r) => r.id));
  for (const r of rooms) r.adjacentTo = r.adjacentTo.filter((a) => ids.has(a) && a !== r.id);
  return { name, kind, rooms, corridorWidthM, notes, by: 'template' };
}

// ---------- room kinds ----------

const R = {
  living: (area = 26): RoomSpec => ({ id: 'living', name: 'Living room', purpose: 'living', minAreaM2: Math.round(area * 0.75), preferredAreaM2: area, minWidthM: 3.6, needsWindow: true, privacy: 'public', adjacentTo: ['kitchen'], people: 4, brief: 'living room with a sofa, armchair, coffee table and rug' }),
  kitchen: (area = 16): RoomSpec => ({ id: 'kitchen', name: 'Kitchen & dining', purpose: 'kitchen', minAreaM2: Math.round(area * 0.75), preferredAreaM2: area, minWidthM: 2.8, needsWindow: true, privacy: 'public', adjacentTo: ['living', 'utility'], people: 4, brief: 'dining table for 4 people' }),
  bedroom: (n: number, area: number, master = false): RoomSpec => ({ id: master ? 'bed-master' : `bed-${n}`, name: master ? 'Main bedroom' : `Bedroom ${n}`, purpose: 'bedroom', minAreaM2: master ? 12 : 9, preferredAreaM2: area, minWidthM: master ? 3.0 : 2.7, needsWindow: true, privacy: 'private', adjacentTo: master ? ['bath'] : [], people: master ? 2 : 1, brief: master ? 'bedroom with a double bed, wardrobe and two nightstands' : 'bedroom with a bed, wardrobe and a desk' }),
  bath: (area = 6): RoomSpec => ({ id: 'bath', name: 'Bathroom', purpose: 'bathroom', minAreaM2: 4.5, preferredAreaM2: area, minWidthM: 1.8, needsWindow: false, privacy: 'service', adjacentTo: ['bed-master', 'wc'] }),
  wc: (n = 0): RoomSpec => ({ id: n ? `wc-${n}` : 'wc', name: n ? `WC ${n}` : 'WC', purpose: 'wc', minAreaM2: 1.8, preferredAreaM2: 2.6, minWidthM: 1.0, needsWindow: false, privacy: 'service', adjacentTo: ['bath'] }),
  utility: (area = 4.5): RoomSpec => ({ id: 'utility', name: 'Utility', purpose: 'utility', minAreaM2: 3, preferredAreaM2: area, minWidthM: 1.5, needsWindow: false, privacy: 'service', adjacentTo: ['kitchen', 'bath'], needsExteriorDoor: false }),
  storage: (area = 3, n = 0): RoomSpec => ({ id: n ? `storage-${n}` : 'storage', name: n ? `Storage ${n}` : 'Storage', purpose: 'storage', minAreaM2: Math.max(1.5, area * 0.6), preferredAreaM2: area, minWidthM: 1.2, needsWindow: false, privacy: 'service' }),
  study: (): RoomSpec => ({ id: 'study', name: 'Study', purpose: 'office', minAreaM2: 7, preferredAreaM2: 9, minWidthM: 2.4, needsWindow: true, privacy: 'private', people: 1, brief: 'home office with a desk, chair and bookshelf' }),
};

// ---------- templates ----------

export function villaProgramme(bedrooms = 3): RoomProgramme {
  const b = Math.max(1, Math.min(6, Math.round(bedrooms)));
  const specs: RoomSpec[] = [R.living(22 + b * 2), R.kitchen(14 + b), R.bedroom(1, 14, true)];
  for (let i = 2; i <= b; i++) specs.push(R.bedroom(i, 11));
  specs.push(R.bath(b >= 4 ? 7 : 6), R.wc(), R.utility());
  if (b >= 4) specs.push(R.storage(3));
  return finish(`Villa, ${b} bedroom${b > 1 ? 's' : ''}`, 'home', specs, 1.2);
}

export function apartmentProgramme(rooms = 2): RoomProgramme {
  const n = Math.max(1, Math.min(5, Math.round(rooms)));
  const specs: RoomSpec[] = [];
  if (n === 1) {
    specs.push({ ...R.living(22), name: 'Living & sleeping', brief: 'studio with a bed, sofa, small dining table' }, { ...R.kitchen(8), name: 'Kitchen', minWidthM: 2.2, minAreaM2: 6 });
  } else {
    specs.push({ ...R.living(18 + n * 2), name: 'Living & kitchen', adjacentTo: [], brief: 'living room with a sofa, coffee table and a dining table for 4' });
    specs.push(R.bedroom(1, 12, true));
    for (let i = 2; i < n; i++) specs.push(R.bedroom(i, 10));
  }
  specs.push({ ...R.bath(5), adjacentTo: ['bed-master'] }, R.storage(2.5));
  return finish(`Apartment, ${n} room${n > 1 ? 's' : ''}`, 'home', specs, 1.1);
}

/** Office floor for `people` staff: desk neighbourhoods of up to eight, meeting rooms, phone booths, kitchen, reception. */
export function officeProgramme(people = 24): RoomProgramme {
  const p = Math.max(2, Math.min(200, Math.round(people)));
  const specs: RoomSpec[] = [
    { id: 'reception', name: 'Reception', purpose: 'reception', minAreaM2: 8, preferredAreaM2: Math.min(24, 8 + p * 0.25), minWidthM: 2.8, needsWindow: true, privacy: 'public', adjacentTo: ['meeting-large', 'meeting-1'], people: 2, brief: 'reception with a desk and a sofa for waiting' },
  ];
  const zones = Math.ceil(p / 8);
  for (let z = 0; z < zones; z++) {
    const desks = z === zones - 1 ? p - Math.round(p / zones) * (zones - 1) : Math.round(p / zones);
    specs.push({ id: `work-${z + 1}`, name: `Workspace ${String.fromCharCode(65 + z)}`, purpose: 'workspace', minAreaM2: Math.round(desks * 4.5), preferredAreaM2: Math.round(desks * 6), minWidthM: 3.6, needsWindow: true, privacy: 'private', adjacentTo: z ? [`work-${z}`] : [], people: desks, brief: `office with ${desks} desks and chairs` });
  }
  const small = Math.max(1, Math.ceil(p / 12));
  for (let i = 1; i <= small; i++) specs.push({ id: `meeting-${i}`, name: `Meeting room ${i}`, purpose: 'meeting', minAreaM2: 9, preferredAreaM2: 12, minWidthM: 2.7, needsWindow: true, privacy: 'public', adjacentTo: [], people: 5, brief: 'meeting room with a table for 5 people' });
  if (p >= 15) specs.push({ id: 'meeting-large', name: 'Conference room', purpose: 'meeting', minAreaM2: 16, preferredAreaM2: Math.min(36, 14 + p * 0.3), minWidthM: 3.4, needsWindow: true, privacy: 'public', adjacentTo: ['reception'], people: 10, brief: 'conference room with a table for 10 people' });
  const booths = Math.max(1, Math.ceil(p / 8));
  for (let i = 1; i <= booths; i++) specs.push({ id: `phone-${i}`, name: `Phone booth ${i}`, purpose: 'phone', minAreaM2: 1.6, preferredAreaM2: 2.2, minWidthM: 1.2, needsWindow: false, privacy: 'service', adjacentTo: ['work-1'], people: 1 });
  specs.push({ id: 'kitchen', name: 'Kitchen & lounge', purpose: 'kitchen', minAreaM2: Math.max(8, Math.round(p * 0.4)), preferredAreaM2: Math.max(10, Math.round(p * 0.6)), minWidthM: 2.8, needsWindow: true, privacy: 'public', adjacentTo: ['wc-1'], people: Math.min(10, Math.ceil(p / 3)), brief: `cafe with tables for ${Math.min(10, Math.ceil(p / 3))} people` });
  const wcs = Math.max(1, Math.ceil(p / 12));
  for (let i = 1; i <= wcs; i++) specs.push({ ...R.wc(i), preferredAreaM2: 3, minAreaM2: 2.2, adjacentTo: i > 1 ? [`wc-${i - 1}`] : ['kitchen'] });
  specs.push({ ...R.storage(Math.max(4, Math.round(p * 0.2))), name: 'Storage & print', adjacentTo: [] });
  return finish(`Office for ${p} people`, 'office', specs, p > 40 ? 1.8 : 1.6);
}

export function cafeProgramme(seats = 30): RoomProgramme {
  const s = Math.max(8, Math.round(seats));
  return finish(`Cafe, ${s} seats`, 'cafe', [
    { id: 'seating', name: 'Seating', purpose: 'cafe', minAreaM2: Math.round(s * 1.2), preferredAreaM2: Math.round(s * 1.5), minWidthM: 4, needsWindow: true, privacy: 'public', adjacentTo: ['counter'], people: s, brief: `cafe with tables for ${s} people` },
    { id: 'counter', name: 'Counter', purpose: 'counter', minAreaM2: 8, preferredAreaM2: 12, minWidthM: 2.4, needsWindow: false, privacy: 'public', adjacentTo: ['seating', 'kitchen'] },
    { id: 'kitchen', name: 'Kitchen', purpose: 'kitchen', minAreaM2: 12, preferredAreaM2: Math.max(14, Math.round(s * 0.5)), minWidthM: 2.6, needsWindow: false, privacy: 'service', adjacentTo: ['counter', 'storage'] },
    { ...R.storage(6), adjacentTo: ['kitchen'] },
    { ...R.wc(1), adjacentTo: ['wc-2'] },
    { ...R.wc(2), adjacentTo: ['wc-1'] },
    { id: 'staff', name: 'Staff room', purpose: 'staff', minAreaM2: 5, preferredAreaM2: 7, minWidthM: 2.2, needsWindow: false, privacy: 'private', adjacentTo: ['kitchen'], people: 3 },
  ], 1.4);
}

export function clinicProgramme(examRooms = 3): RoomProgramme {
  const n = Math.max(1, Math.min(12, Math.round(examRooms)));
  const specs: RoomSpec[] = [
    { id: 'waiting', name: 'Reception & waiting', purpose: 'reception', minAreaM2: 12, preferredAreaM2: 10 + n * 3, minWidthM: 3.2, needsWindow: true, privacy: 'public', adjacentTo: ['wc-1'], people: 2 + n * 2, brief: 'reception desk and waiting chairs' },
  ];
  for (let i = 1; i <= n; i++) specs.push({ id: `exam-${i}`, name: `Exam room ${i}`, purpose: 'clinic', minAreaM2: 10, preferredAreaM2: 12, minWidthM: 2.8, needsWindow: true, privacy: 'private', adjacentTo: i > 1 ? [`exam-${i - 1}`] : [], people: 2, brief: 'clinic treatment room with a treatment bed, desk and two chairs' });
  specs.push(
    { id: 'office', name: 'Doctor office', purpose: 'office', minAreaM2: 8, preferredAreaM2: 10, minWidthM: 2.6, needsWindow: true, privacy: 'private', people: 1, brief: 'office with a desk and a chair' },
    { id: 'utility', name: 'Sterile & utility', purpose: 'utility', minAreaM2: 4, preferredAreaM2: 6, minWidthM: 1.8, needsWindow: false, privacy: 'service', adjacentTo: ['exam-1'] },
    { id: 'staff', name: 'Staff room', purpose: 'staff', minAreaM2: 7, preferredAreaM2: 10, minWidthM: 2.6, needsWindow: true, privacy: 'private', people: 4, brief: 'dining table for 4 people' },
    { ...R.wc(1), preferredAreaM2: 4, minAreaM2: 3.5, minWidthM: 1.6, adjacentTo: ['waiting'] },
    { ...R.wc(2), adjacentTo: ['staff'] },
    R.storage(4),
  );
  return finish(`Clinic, ${n} exam room${n > 1 ? 's' : ''}`, 'clinic', specs, 1.6);
}

export const TEMPLATES = [
  { id: 'villa', label: 'Villa, 3 bedrooms', make: () => villaProgramme(3) },
  { id: 'apartment', label: 'Apartment, 2 rooms', make: () => apartmentProgramme(2) },
  { id: 'office', label: 'Office, 24 people', make: () => officeProgramme(24) },
  { id: 'cafe', label: 'Cafe, 30 seats', make: () => cafeProgramme(30) },
  { id: 'clinic', label: 'Clinic, 3 exam rooms', make: () => clinicProgramme(3) },
] as const;

export const programmeArea = (p: RoomProgramme) => p.rooms.reduce((s, r) => s + r.preferredAreaM2, 0);

// ---------- from a sentence ----------

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const num = (s: string | undefined) => (s == null ? NaN : Number(s) || NUM[s] || NaN);
const N = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|thirty|forty|fifty)';

/** Rule-based reader: picks a template and adjusts counts from the words. */
export function programmeFromRules(text: string): RoomProgramme {
  const t = text.toLowerCase();
  const people = num(t.match(new RegExp(`${N}\\s*(?:people|persons|staff|employees|desks|seats|workers)`))?.[1]);
  let p: RoomProgramme;
  if (/office|workplace|cowork|desks|employees|staff of/.test(t)) p = officeProgramme(Number.isFinite(people) ? people : 24);
  else if (/caf[eé]|coffee|restaurant|bistro/.test(t)) p = cafeProgramme(Number.isFinite(people) ? people : 30);
  else if (/clinic|practice|dentist|doctor|physio|treatment/.test(t)) p = clinicProgramme(num(t.match(new RegExp(`${N}\\s*(?:exam|treatment|consult)`))?.[1]) || 3);
  else {
    const beds = num(t.match(new RegExp(`${N}[\\s-]*(?:bed(?:room)?s?|br)\\b`))?.[1]);
    const rok = num(t.match(new RegExp(`${N}[\\s-]*(?:rooms?|rok|room apartment)`))?.[1]);
    if (/apartment|flat|condo/.test(t) && !Number.isFinite(beds)) p = apartmentProgramme(Number.isFinite(rok) ? rok : 2);
    else p = villaProgramme(Number.isFinite(beds) ? beds : 3);
    if (/study|home office|work from home/.test(t) && !p.rooms.some((r) => r.id === 'study')) p.rooms.push({ ...R.study(), adjacentTo: [] } as ProgrammeRoom);
    if (/(second|extra|two) bath/.test(t) && !p.rooms.some((r) => r.id === 'bath-2')) p.rooms.push({ ...R.bath(5), id: 'bath-2', name: 'Bathroom 2', adjacentTo: [] } as ProgrammeRoom);
  }
  if (/wheelchair|accessib/.test(t)) { p.corridorWidthM = Math.max(p.corridorWidthM, 1.5); p.notes.push('Accessible: corridors at least 1.5 m.'); }
  return { ...p, by: 'rules' };
}

export const PROGRAMME_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    kind: { type: 'STRING', enum: ['home', 'office', 'cafe', 'clinic', 'custom'] },
    corridorWidthM: { type: 'NUMBER' },
    notes: { type: 'ARRAY', items: { type: 'STRING' } },
    rooms: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' }, name: { type: 'STRING' }, purpose: { type: 'STRING' },
          minAreaM2: { type: 'NUMBER' }, preferredAreaM2: { type: 'NUMBER' }, minWidthM: { type: 'NUMBER' },
          needsWindow: { type: 'BOOLEAN' }, needsExteriorDoor: { type: 'BOOLEAN' },
          adjacentTo: { type: 'ARRAY', items: { type: 'STRING' } },
          privacy: { type: 'STRING', enum: ['public', 'private', 'service'] },
          people: { type: 'INTEGER' }, brief: { type: 'STRING' },
        },
        required: ['id', 'name', 'purpose', 'minAreaM2', 'preferredAreaM2', 'minWidthM', 'needsWindow', 'adjacentTo', 'privacy'],
      },
    },
  },
  required: ['name', 'kind', 'rooms', 'corridorWidthM', 'notes'],
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Clean a model's answer into a usable programme; drops rows that make no sense. */
export function validateProgramme(raw: Partial<RoomProgramme>, fallbackName = 'Custom programme'): RoomProgramme | null {
  const rows = Array.isArray(raw.rooms) ? raw.rooms : [];
  const specs: RoomSpec[] = [];
  for (const r of rows.slice(0, 40)) {
    if (!r || typeof r.name !== 'string') continue;
    const pref = clamp(Number(r.preferredAreaM2) || 0, 1, 400);
    const min = clamp(Number(r.minAreaM2) || pref * 0.75, 1, pref);
    specs.push({
      id: typeof r.id === 'string' && r.id ? slug(r.id) : undefined,
      name: r.name.slice(0, 40), purpose: String(r.purpose || 'room').toLowerCase().slice(0, 20),
      minAreaM2: min, preferredAreaM2: pref, minWidthM: clamp(Number(r.minWidthM) || 2.4, 0.9, Math.sqrt(pref)),
      needsWindow: Boolean(r.needsWindow), needsExteriorDoor: Boolean(r.needsExteriorDoor),
      adjacentTo: Array.isArray(r.adjacentTo) ? r.adjacentTo.map((a) => slug(String(a))) : [],
      privacy: (['public', 'private', 'service'] as const).includes(r.privacy as Privacy) ? r.privacy as Privacy : 'private',
      people: r.people ? clamp(Math.round(Number(r.people)), 1, 200) : undefined,
      brief: typeof r.brief === 'string' ? r.brief.slice(0, 200) : undefined,
    });
  }
  if (!specs.length) return null;
  const kind = (['home', 'office', 'cafe', 'clinic', 'custom'] as const).includes(raw.kind as RoomProgramme['kind']) ? raw.kind as RoomProgramme['kind'] : 'custom';
  const p = finish(String(raw.name || fallbackName).slice(0, 60), kind, specs, clamp(Number(raw.corridorWidthM) || 1.2, 0.9, 2.4),
    Array.isArray(raw.notes) ? raw.notes.filter((n) => typeof n === 'string').slice(0, 6) : []);
  return { ...p, by: 'gemini' };
}

/** "A villa with 4 bedrooms and a study", "office for 30 people" -> a programme. */
export async function programmeFromBrief(text: string, opts: { shellAreaM2?: number; signal?: AbortSignal } = {}): Promise<RoomProgramme> {
  if (aiReady()) {
    try {
      const prompt = `Write the room programme an architect would use for this brief.\nBrief: """${text}"""\n${opts.shellAreaM2 ? `Usable floor area: about ${Math.round(opts.shellAreaM2)} m2 (corridors take 8-15%).\n` : ''}Rules: areas in m2, widths in metres. privacy: public (living, kitchen, reception, meeting), private (bedrooms, workspaces, offices), service (bath, wc, storage, utility). needsWindow true for rooms people stay in. adjacentTo uses other rooms' ids. Do not include corridors or halls; they are generated. brief is a short furnishing request per room.`;
      const res = await ai<Partial<RoomProgramme>>({ task: 'smart', parts: [{ text: prompt }], schema: PROGRAMME_SCHEMA, system: 'You are a careful architect writing room programmes. Output only JSON matching the schema.', signal: opts.signal });
      const p = validateProgramme(res.data, text.slice(0, 40));
      if (p) return p;
    } catch { /* fall back to rules */ }
  }
  return programmeFromRules(text);
}
