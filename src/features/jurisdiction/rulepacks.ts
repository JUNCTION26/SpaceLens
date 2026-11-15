// Country rule packs: values read from official texts, each with its source.
// Planning guidance only. Requirements depend on building type, size and date; this is not a compliance check.
import { SAFETY_DEFAULTS, SAFETY_DEFAULT_INFO, type SafetyConfig, type SafetyKey } from '../safety/assess';

export type PackId = 'FI' | 'SE' | 'generic';
export type Confidence = 'requirement' | 'guidance' | 'rule-of-thumb';

export interface RuleSource { doc: string; section: string; url: string; readOn: string; quote?: string }
export interface Rule {
  id: string;
  title: string;
  value: number;
  unit: string;
  scope: string;
  source: RuleSource;
  confidence: Confidence;
  /** The SAFETY_DEFAULTS key this value sets, when it maps one to one. */
  key?: SafetyKey;
}
export interface RulePack { id: PackId; name: string; rules: Rule[] }

const READ = '2026-11-15';

const FI241 = 'Ympäristöministeriön asetus esteettömästä rakennuksesta 241/2017';
const FI241_URL = 'https://www.finlex.fi/fi/lainsaadanto/saadoskokoelma/2017/241';
const FI848 = 'Ympäristöministeriön asetus rakennusten paloturvallisuudesta 848/2017';
const FI848_URL = 'https://www.finlex.fi/fi/lainsaadanto/saadoskokoelma/2017/848';
const FI1008 = 'Ympäristöministeriön asetus asuin-, majoitus- ja työtiloista 1008/2017';
const FI1008_URL = 'https://www.finlex.fi/fi/lainsaadanto/saadoskokoelma/2017/1008';
const BFS7 = 'Boverkets föreskrifter och allmänna råd (BFS 2024:7) om säkerhet i händelse av brand i byggnader';
const BFS7_URL = 'https://rinfo.boverket.se/BFS2024-7/pdf/BFS2024-7.pdf';
const BFS12 = 'Boverkets föreskrifter och allmänna råd (BFS 2024:12) om byggnaders tillgänglighet och användbarhet för personer med nedsatt rörelse- eller orienteringsförmåga';
const BFS12_URL = 'https://rinfo.boverket.se/BFS2024-12/pdf/BFS2024-12.pdf';

const fi241 = (section: string, quote: string): RuleSource => ({ doc: FI241, section, url: FI241_URL, readOn: READ, quote });
const fi848 = (section: string, quote: string): RuleSource => ({ doc: FI848, section, url: FI848_URL, readOn: READ, quote });
const fi1008 = (section: string, quote: string): RuleSource => ({ doc: FI1008, section, url: FI1008_URL, readOn: READ, quote });
const bfs7 = (section: string, quote: string): RuleSource => ({ doc: BFS7, section, url: BFS7_URL, readOn: READ, quote });
const bfs12 = (section: string, quote: string): RuleSource => ({ doc: BFS12, section, url: BFS12_URL, readOn: READ, quote });

export const FI_PACK: RulePack = {
  id: 'FI',
  name: 'Finland',
  rules: [
    { id: 'fi-door-passage', title: 'Door clear width, internal route', value: 0.85, unit: 'm', scope: 'Offices, public buildings, shared areas of apartment blocks; door from stairwell to dwelling',
      source: fi241('4 §, 1 mom.', 'vapaan leveyden on oltava vähintään 850 millimetriä'), confidence: 'requirement', key: 'wheelchairDoorM' },
    { id: 'fi-door-room', title: 'Door clear width, into a room', value: 0.8, unit: 'm', scope: 'Rooms of non-residential buildings; habitable rooms of dwellings',
      source: fi241('4 §, 2 mom.', 'vapaan leveyden on oltava vähintään 800 millimetriä'), confidence: 'requirement' },
    { id: 'fi-threshold', title: 'Highest threshold, when unavoidable', value: 0.02, unit: 'm', scope: 'Doors on accessible routes',
      source: fi241('4 §, 3 mom.', 'kynnys tai tasoero saa olla enintään 20 millimetriä korkea'), confidence: 'requirement' },
    { id: 'fi-turn-corridor', title: 'Turning circle in a narrow corridor', value: 1.5, unit: 'm', scope: 'Corridors under 1.5 m wide, one circle at least every 15 m (non-residential and shared areas)',
      source: fi241('5 §, 2 mom.', 'käytävällä on oltava vähintään 15 metrin välein kääntymistila, jonka halkaisija on vähintään 1 500 millimetriä'), confidence: 'requirement', key: 'turningM' },
    { id: 'fi-turn-corridor-spacing', title: 'Turning circle spacing', value: 15, unit: 'm', scope: 'Corridors under 1.5 m wide',
      source: fi241('5 §, 2 mom.', 'vähintään 15 metrin välein kääntymistila'), confidence: 'requirement' },
    { id: 'fi-turn-dwelling', title: 'Turning circle in hall and kitchen', value: 1.3, unit: 'm', scope: 'Dwellings in buildings that must have a lift',
      source: fi241('6 §, 2 mom.', 'eteisessä ja keittiössä oltava kääntymistila, jonka halkaisija on vähintään 1 300 millimetriä'), confidence: 'requirement' },
    { id: 'fi-wc-turn', title: 'Free circle in accessible WC', value: 1.5, unit: 'm', scope: 'Non-residential buildings',
      source: fi241('10 §, 3 mom.', 'halkaisijaltaan vähintään 1 500 millimetriä vapaa tila'), confidence: 'requirement' },
    { id: 'fi-travel-single', title: 'Longest walk to an exit, area with one exit', value: 30, unit: 'm', scope: 'Fire compartment or evacuation area with only one exit',
      source: fi848('32 §, taulukko 10', 'Poistumisalue, josta on vain yksi uloskäytävä 30 m'), confidence: 'requirement', key: 'maxTravelM' },
    { id: 'fi-travel-other', title: 'Longest walk to an exit, general spaces', value: 45, unit: 'm', scope: 'Other spaces (not lodging, care, shops) without smoke detection or sprinklers, two or more exits',
      source: fi848('32 §, taulukko 10', 'Muut tilat 45 m'), confidence: 'requirement' },
    { id: 'fi-exit-width', title: 'Exit route clear width', value: 1.2, unit: 'm', scope: 'Exit routes in general; 0.9 m allowed for the second exit of areas up to 60 people and for one exit in dwellings of up to two storeys',
      source: fi848('34 §', 'uloskäytävän leveyden on oltava vähintään 1 200 millimetriä'), confidence: 'requirement' },
    { id: 'fi-exit-width-small', title: 'Exit route clear width, small exceptions', value: 0.9, unit: 'm', scope: 'Second exit of an area with up to 60 people; one exit of a dwelling building up to two storeys',
      source: fi848('34 §, 1) ja 2) kohta', 'vähintään 900 millimetrin levyinen'), confidence: 'requirement' },
    { id: 'fi-exit-height', title: 'Exit route clear height', value: 2.1, unit: 'm', scope: 'Exit routes',
      source: fi848('34 §', 'uloskäytävän korkeuden on oltava vähintään 2 100 millimetriä'), confidence: 'requirement' },
    { id: 'fi-door-outward', title: 'Exit doors open outwards above this many people', value: 60, unit: 'people', scope: 'Doors people leave through (and any apartment door onto a stair landing)',
      source: fi848('35 §', 'oven kautta poistuvien henkilöiden määrä on yli 60'), confidence: 'requirement', key: 'inwardSwingMaxOccupants' },
    { id: 'fi-room-height', title: 'Room height, habitable and work rooms', value: 2.5, unit: 'm', scope: 'Dwelling, lodging and work rooms (2.4 m in houses; a small part of the room may be lower, not under 2.2 m)',
      source: fi1008('4 §', 'huonekorkeuden on oltava vähintään 2,5 metriä'), confidence: 'requirement' },
    { id: 'fi-room-height-house', title: 'Room height, detached and attached houses', value: 2.4, unit: 'm', scope: 'Houses (pientalo)',
      source: fi1008('4 §', 'Pientalossa mainittu vähimmäiskorkeus on 2,4 metriä'), confidence: 'requirement' },
    { id: 'fi-room-area', title: 'Smallest room area', value: 7, unit: 'm²', scope: 'Dwelling, lodging and work rooms',
      source: fi1008('4 §', 'huonealan on kuitenkin aina oltava vähintään 7 neliömetriä'), confidence: 'requirement' },
    { id: 'fi-approach-width', title: 'Clear width of approach route to the building', value: 1.2, unit: 'm', scope: 'Route from the plot boundary and from parking to the entrance (outdoors, not an indoor corridor)',
      source: fi241('2 §', 'vähintään 1 200 millimetriä leveä'), confidence: 'requirement' },
  ],
};

export const SE_PACK: RulePack = {
  id: 'SE',
  name: 'Sweden',
  rules: [
    { id: 'se-door-passage', title: 'Door clear width, accessible doors', value: 0.8, unit: 'm', scope: 'Where a building part must be accessible and usable (dwellings: 0.76 m)',
      source: bfs12('1 kap. 6 §', 'öppningsmåttet för fri passage minst 0,80 meter'), confidence: 'requirement', key: 'wheelchairDoorM' },
    { id: 'se-door-passage-dwelling', title: 'Door clear width, individual dwellings', value: 0.76, unit: 'm', scope: 'Individual dwellings',
      source: bfs12('1 kap. 6 §', 'öppningsmåttet för fri passage minst 0,76 meter'), confidence: 'requirement' },
    { id: 'se-turn-chair', title: 'Turning circle for a wheelchair', value: 1.5, unit: 'm', scope: 'Where a building part must be accessible and usable (dwellings: 1.3 m)',
      source: bfs12('1 kap. 6 §', 'vändmåttet av en cirkel med diametern 1,50 meter'), confidence: 'requirement', key: 'turningM' },
    { id: 'se-turn-chair-dwelling', title: 'Turning circle, individual dwellings', value: 1.3, unit: 'm', scope: 'Individual dwellings',
      source: bfs12('1 kap. 6 §', 'vändmåttet av en cirkel med diametern 1,30 meter'), confidence: 'requirement' },
    { id: 'se-exits-min', title: 'Independent exit doors, usual minimum', value: 2, unit: 'doors', scope: 'Dwellings (class 3A), guest rooms, premises with up to 600 people; 3 above 600, 4 above 1 000',
      source: bfs7('7 kap. 9 §', 'Två utrymningsdörrar i verksamheter med högst 600 personer'), confidence: 'requirement' },
    { id: 'se-exits-apart', title: 'Distance between independent exit doors', value: 5, unit: 'm', scope: 'Independent exit doors',
      source: bfs7('7 kap. 9 §', 'avståndet mellan oberoende utrymningsdörrar är minst 5 meter'), confidence: 'requirement' },
    { id: 'se-exit-single-small', title: 'One exit door enough up to this many people', value: 30, unit: 'people', scope: 'Activity classes 2A, 4, 5A, 5B, 5C when the door leads straight to a safe place (50 people in classes 1, 3A, 3B, 3C)',
      source: bfs7('7 kap. 11 §', 'betjänar högst 30 personer'), confidence: 'requirement' },
    { id: 'se-travel-class1', title: 'Longest walk to an exit door, offices and dwellings', value: 45, unit: 'm', scope: 'Activity classes 1, 3A, 3B, 3C, 5B (30 m in 2A, 2B, 4, 5A, 5C; 15 m in 2C); reduced for level differences, extended with sprinklers',
      source: bfs7('7 kap. 19 §', 'Verksamhetsklass 1, 3A, 3B, 3C och 5B: 45 meter'), confidence: 'requirement' },
    { id: 'se-travel-class2', title: 'Longest walk to an exit door, assembly, hotels, schools', value: 30, unit: 'm', scope: 'Activity classes 2A, 2B, 4, 5A, 5C',
      source: bfs7('7 kap. 19 §', 'Verksamhetsklass 2A, 2B, 4, 5A och 5C: 30 meter'), confidence: 'requirement' },
    { id: 'se-route-width', title: 'Escape passage clear width', value: 0.9, unit: 'm', scope: 'Escape passages serving up to 150 people (handrails may take 0.10 m per side)',
      source: bfs7('7 kap. 28 §', 'Fri bredd ska vara minst 0,90 meter om de betjänar högst 150 personer'), confidence: 'requirement', key: 'routeWidthM' },
    { id: 'se-route-width-large', title: 'Escape passage clear width, many people', value: 1.2, unit: 'm', scope: 'Escape passages serving more than 150 people',
      source: bfs7('7 kap. 28 §', 'Fri bredd ska vara minst 1,20 meter om de betjänar fler än 150 personer'), confidence: 'requirement' },
    { id: 'se-escape-door', title: 'Escape door clear width', value: 0.8, unit: 'm', scope: 'Exit doors serving up to 150 people',
      source: bfs7('7 kap. 27 §', 'Fri bredd ska vara minst 0,80 meter om de betjänar högst 150 personer'), confidence: 'requirement', key: 'doorWidthM' },
    { id: 'se-escape-door-large', title: 'Escape door clear width, many people', value: 1.15, unit: 'm', scope: 'Exit doors serving more than 150 people',
      source: bfs7('7 kap. 27 §', 'Fri bredd ska vara minst 1,15 meter om de betjänar fler än 150 personer'), confidence: 'requirement' },
    { id: 'se-door-inward-people', title: 'Door opening against the escape direction, up to this many people', value: 30, unit: 'people', scope: 'Hinged or manual sliding exit doors',
      source: bfs7('7 kap. 33 §', 'Slagdörr som öppnar mot utrymningsriktningen om högst 30 personer förväntas nyttja den samtidigt'), confidence: 'requirement', key: 'inwardSwingMaxOccupants' },
  ],
};

export const GENERIC_PACK: RulePack = {
  id: 'generic',
  name: 'General',
  rules: (Object.keys(SAFETY_DEFAULTS) as SafetyKey[]).map((key) => ({
    id: `generic-${key}`,
    title: SAFETY_DEFAULT_INFO[key].label,
    value: SAFETY_DEFAULTS[key],
    unit: SAFETY_DEFAULT_INFO[key].unit,
    scope: 'Planning rule of thumb, not taken from a code',
    source: { doc: 'SpaceLens planning defaults', section: 'src/features/safety/assess.ts', url: 'https://github.com/shafir-01/SpaceLens', readOn: READ },
    confidence: 'rule-of-thumb' as const,
    key,
  })),
};

export const PACKS: Record<PackId, RulePack> = { FI: FI_PACK, SE: SE_PACK, generic: GENERIC_PACK };

/** Pack for an ISO country code (any case); the general pack for anything else. */
export function packFor(countryCode?: string | null): RulePack {
  const c = (countryCode ?? '').trim().toUpperCase();
  return c === 'FI' ? FI_PACK : c === 'SE' ? SE_PACK : GENERIC_PACK;
}

/** The safety settings this pack sets. Only keys that exist in SAFETY_DEFAULTS, only finite non-negative numbers. */
export function applyPack(pack: RulePack): Partial<SafetyConfig> {
  const out: Partial<SafetyConfig> = {};
  for (const r of pack.rules) {
    if (r.key && r.key in SAFETY_DEFAULTS && Number.isFinite(r.value) && r.value >= 0) out[r.key] = r.value;
  }
  return out;
}
