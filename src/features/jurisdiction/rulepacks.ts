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
const BBR = 'Boverkets byggregler (BFS 2011:6, konsoliderad t.o.m. BFS 2024:5)';
const BBR_URL = 'https://rinfo.boverket.se/BFS2011-6/dok/BFS2024-5_konsolidering.pdf';

const fi241 = (section: string, quote: string): RuleSource => ({ doc: FI241, section, url: FI241_URL, readOn: READ, quote });
const fi848 = (section: string, quote: string): RuleSource => ({ doc: FI848, section, url: FI848_URL, readOn: READ, quote });
const bbr = (section: string, quote: string): RuleSource => ({ doc: BBR, section, url: BBR_URL, readOn: READ, quote });

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
  ],
};

export const SE_PACK: RulePack = {
  id: 'SE',
  name: 'Sweden',
  rules: [
    { id: 'se-door-passage', title: 'Door clear width, accessible doors', value: 0.8, unit: 'm', scope: 'Entrances, lift doors, corridor doors, openings on routes, doors to assembly rooms (door open to 90 degrees)',
      source: bbr('3:143, allmänt råd', 'Det fria passagemåttet bör vara minst 0,80 meter, när dörren är uppställd i 90°'), confidence: 'guidance', key: 'wheelchairDoorM' },
    { id: 'se-turn-outdoor-chair', title: 'Turning circle for a wheelchair', value: 1.5, unit: 'm', scope: 'Publicly accessible and shared spaces (smaller outdoor wheelchair)',
      source: bbr('3:113, allmänt råd', 'en cirkel med diametern 1,50 meter'), confidence: 'guidance', key: 'turningM' },
    { id: 'se-turn-indoor-chair', title: 'Turning circle, indoor wheelchair', value: 1.3, unit: 'm', scope: 'Inside individual dwellings',
      source: bbr('3:113, allmänt råd', 'för en inomhusrullstol en cirkel med diametern 1,30 meter'), confidence: 'guidance' },
    { id: 'se-circulation-width', title: 'Clear width of circulation space', value: 1.3, unit: 'm', scope: 'Entrance and circulation spaces (0.8 m where obstacles are limited, such as a pillar)',
      source: bbr('3:142, allmänt råd', 'ha en fri bredd på minst 1,30 meter, gäller dock inte trappor'), confidence: 'guidance' },
    { id: 'se-travel', title: 'Longest walk in an escape route', value: 30, unit: 'm', scope: 'Walk to the nearest stair to another floor or to an exit to a safe place',
      source: bbr('5:332, allmänt råd', 'bör inte överstiga 30 meter'), confidence: 'guidance', key: 'maxTravelM' },
    { id: 'se-travel-one-way-corridor', title: 'Longest walk with escape in one direction only', value: 10, unit: 'm', scope: 'Stair hall or corridor in activity classes 1, 2, 3 or 5B (7 m for classes 4, 5A, 5C)',
      source: bbr('5:332, tabell 5:332', 'Maximalt gångavstånd när utrymningsmöjlighet endast finns i en riktning 10 m'), confidence: 'guidance' },
    { id: 'se-route-width', title: 'Escape route clear width', value: 0.9, unit: 'm', scope: 'Escape routes (handrails may take up to 0.10 m per side)',
      source: bbr('5:334, allmänt råd', 'Utrymningsvägar bör ha en fri bredd på minst 0,90 meter'), confidence: 'guidance', key: 'routeWidthM' },
    { id: 'se-escape-door', title: 'Escape door opening clear width', value: 0.8, unit: 'm', scope: 'Door openings in escape routes',
      source: bbr('5:334, allmänt råd', 'Dörröppningar bör ha en fri bredd på minst 0,80 meter'), confidence: 'guidance', key: 'doorWidthM' },
    { id: 'se-route-width-large', title: 'Escape route clear width, many people', value: 1.2, unit: 'm', scope: 'Escape routes serving more than 150 people',
      source: bbr('5:334, allmänt råd', 'som betjänar fler än 150 personer bör ha en fri bredd på minst 1,20 meter'), confidence: 'guidance' },
    { id: 'se-door-inward-people', title: 'Inward-opening exit door, premises up to this many people', value: 30, unit: 'people', scope: 'Premises where people know the building (classrooms, small offices); queuing not expected',
      source: bbr('5:335, allmänt råd', 'en lokal för maximalt 30 personer och där personerna har kännedom om miljön'), confidence: 'guidance', key: 'inwardSwingMaxOccupants' },
    { id: 'se-height-dwelling', title: 'Room height, dwellings', value: 2.4, unit: 'm', scope: 'Dwellings (2.30 m in attic, basement and split-level floors of small houses)',
      source: bbr('3:3111', 'Rumshöjden i bostäder ska vara minst 2,40 meter'), confidence: 'requirement' },
    { id: 'se-height-public', title: 'Room height, public premises', value: 2.7, unit: 'm', scope: 'Public premises (not below 2.40 m in rooms for few people)',
      source: bbr('3:3112', 'Rumshöjden i publika lokaler ska vara minst 2,70 meter'), confidence: 'requirement' },
    { id: 'se-height-work', title: 'Room height, workrooms', value: 2.4, unit: 'm', scope: 'Workrooms',
      source: bbr('3:3113', 'Rumshöjden i arbetsrum ska vara minst 2,40 meter'), confidence: 'requirement' },
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
