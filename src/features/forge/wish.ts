// A description read into a typed wish list: what the object is, how big, how many of each
// part, which part is made of what, its style, its extras and any words printed on it.
// English, Swedish and Finnish. Pure: no model involved.

import type { MaterialId } from '../../core/types';
import { findColors } from './palette';
import { parseRequest } from './parseRequest';

export type Archetype = 'carcass' | 'slab' | 'seat' | 'bed' | 'bunk' | 'frame' | 'column' | 'disc' | 'panel' | 'lamp' | 'drumkit';
export type Support = 'legs' | 'trestle' | 'pedestal' | 'hairpin' | 'sled' | 'plinth' | 'wheels';
/** Part roles a material or colour can be pinned to. */
export type Role = 'main' | 'top' | 'legs' | 'frame' | 'doors' | 'drawers' | 'shelves' | 'seat' | 'back' | 'cushions' | 'handles' | 'wheels' | 'post' | 'platforms';
export type Feature = 'wheels' | 'handles' | 'backrest' | 'armrests' | 'slatted' | 'tufted' | 'lamp' | 'plant' | 'slide' | 'rope' | 'ladder' | 'cushions' | 'mirror' | 'headboard' | 'round-corners';
export type CountKey = 'drawers' | 'doors' | 'shelves' | 'legs' | 'platforms' | 'seats' | 'wheels' | 'drums' | 'cymbals' | 'compartments';

export interface Look { material?: MaterialId; color?: string }
export interface Wish {
  text: string;
  /** The noun the object was named by (English form), or '' when none was recognised. */
  noun: string;
  archetype: Archetype;
  category: string;
  size: { w: number; d: number; h: number };
  /** Which dimensions the words fixed (a number or a size word like "knee height"). */
  stated: { w: boolean; d: boolean; h: boolean };
  counts: Partial<Record<CountKey, number>>;
  support?: Support;
  round: boolean;
  looks: Partial<Record<Role, Look>>;
  style: string[];
  features: Feature[];
  /** Words to print ("with GERARD written on it"). */
  text_?: string;
  wallMounted: boolean;
  /** Mount height of the underside for wall-mounted things, metres. */
  elevation?: number;
}

interface Noun { en: string[]; sv?: string[]; fi?: string[]; arch: Archetype; size: [number, number, number]; cat: string; counts?: Partial<Record<CountKey, number>>; features?: Feature[]; support?: Support; round?: boolean; wall?: number }

// Most specific first. Sizes are w (x), d (z), h (y) in metres.
export const NOUNS: Noun[] = [
  { en: ['drum kit', 'drum set', 'drums'], sv: ['trumset'], fi: ['rumpusetti'], arch: 'drumkit', size: [1.6, 1.3, 1.2], cat: 'drum-kit', counts: { drums: 4, cymbals: 2 } },
  { en: ['bunk bed', 'loft bed', 'double decker bed'], sv: ['våningssäng', 'loftsäng'], fi: ['kerrossänky', 'parvisänky'], arch: 'bunk', size: [1.0, 2.0, 1.65], cat: 'bunk-bed', features: ['ladder'] },
  { en: ['cat tree', 'cat tower', 'scratching post', 'cat condo'], sv: ['klösträd'], fi: ['kiipeilypuu', 'raapimispuu'], arch: 'column', size: [0.6, 0.6, 1.5], cat: 'pet', counts: { platforms: 3 } },
  { en: ['plant stand', 'plant pedestal'], sv: ['blompall'], fi: ['kukkapöytä'], arch: 'column', size: [0.35, 0.35, 0.8], cat: 'decor', counts: { platforms: 1 }, features: ['plant'] },
  { en: ['coat stand', 'hat stand', 'coat tree'], sv: ['klädhängare'], fi: ['naulakko'], arch: 'column', size: [0.5, 0.5, 1.8], cat: 'decor', counts: { platforms: 0 } },
  { en: ['lectern', 'podium'], sv: ['talarstol'], fi: ['puhujanpönttö'], arch: 'column', size: [0.6, 0.5, 1.15], cat: 'decor', counts: { platforms: 1 } },
  { en: ['floor lamp', 'standing lamp', 'reading lamp'], sv: ['golvlampa'], fi: ['lattiavalaisin', 'jalkalamppu'], arch: 'lamp', size: [0.4, 0.4, 1.6], cat: 'lamp' },
  { en: ['table lamp', 'desk lamp', 'bedside lamp'], sv: ['bordslampa'], fi: ['pöytävalaisin'], arch: 'lamp', size: [0.3, 0.3, 0.5], cat: 'lamp' },
  { en: ['lamp', 'light'], sv: ['lampa'], fi: ['lamppu', 'valaisin'], arch: 'lamp', size: [0.4, 0.4, 1.6], cat: 'lamp' },
  { en: ['bar cart', 'drinks trolley', 'trolley', 'serving cart', 'tea cart', 'kitchen cart', 'cart'], sv: ['rullvagn', 'barvagn'], fi: ['tarjoiluvaunu', 'vaunu'], arch: 'frame', size: [0.8, 0.45, 0.85], cat: 'cart', counts: { shelves: 2 }, features: ['wheels', 'handles'], support: 'wheels' },
  { en: ['standing desk', 'sit-stand desk', 'sit stand desk', 'height adjustable desk'], sv: ['ståbord', 'höj- och sänkbart skrivbord'], fi: ['seisomapöytä', 'sähköpöytä'], arch: 'slab', size: [1.6, 0.8, 1.05], cat: 'desk', support: 'trestle' },
  { en: ['coffee table', 'sofa table', 'lounge table'], sv: ['soffbord'], fi: ['sohvapöytä'], arch: 'slab', size: [1.1, 0.6, 0.42], cat: 'coffee-table' },
  { en: ['side table', 'end table'], sv: ['sidobord', 'avlastningsbord'], fi: ['sivupöytä'], arch: 'slab', size: [0.5, 0.5, 0.55], cat: 'side-table' },
  { en: ['console table', 'hall table'], sv: ['avlastningsbord', 'hallbord'], fi: ['konsolipöytä'], arch: 'slab', size: [1.2, 0.35, 0.8], cat: 'table' },
  { en: ['dining table', 'kitchen table'], sv: ['matbord', 'köksbord'], fi: ['ruokapöytä', 'keittiönpöytä'], arch: 'slab', size: [1.6, 0.9, 0.75], cat: 'table' },
  { en: ['workbench', 'work bench', 'workshop table'], sv: ['arbetsbänk'], fi: ['työpenkki'], arch: 'slab', size: [1.8, 0.7, 0.9], cat: 'table', counts: { shelves: 1 } },
  { en: ['desk', 'writing table', 'workstation'], sv: ['skrivbord'], fi: ['työpöytä', 'kirjoituspöytä'], arch: 'slab', size: [1.4, 0.7, 0.74], cat: 'desk' },
  { en: ['picnic table'], sv: ['picknickbord'], fi: ['piknikpöytä'], arch: 'slab', size: [1.8, 0.75, 0.75], cat: 'table', support: 'trestle' },
  { en: ['table'], sv: ['bord'], fi: ['pöytä'], arch: 'slab', size: [1.4, 0.8, 0.75], cat: 'table' },
  { en: ['kitchen island', 'breakfast bar', 'island'], sv: ['köksö'], fi: ['keittiösaareke', 'saareke'], arch: 'carcass', size: [2.0, 0.9, 0.92], cat: 'counter', counts: { doors: 4 } },
  { en: ['bar counter', 'home bar', 'counter'], sv: ['bardisk', 'disk'], fi: ['baaritiski', 'tiski'], arch: 'carcass', size: [2.0, 0.6, 1.1], cat: 'counter', counts: { doors: 3 } },
  { en: ['reception desk', 'front desk'], sv: ['receptionsdisk'], fi: ['vastaanottotiski'], arch: 'carcass', size: [2.4, 0.8, 1.1], cat: 'desk', counts: { compartments: 3 } },
  { en: ['bookshelf', 'bookcase', 'shelving unit', 'shelving', 'shelves', 'etagere', 'shelf'], sv: ['bokhylla', 'hylla'], fi: ['kirjahylly', 'hylly'], arch: 'carcass', size: [0.8, 0.3, 1.8], cat: 'bookshelf', counts: { shelves: 4 } },
  { en: ['wall shelf', 'floating shelf'], sv: ['vägghylla'], fi: ['seinähylly'], arch: 'carcass', size: [0.8, 0.22, 0.25], cat: 'shelf', counts: { shelves: 0 }, wall: 1.4 },
  { en: ['wall cabinet', 'medicine cabinet', 'bathroom cabinet'], sv: ['väggskåp', 'badrumsskåp'], fi: ['seinäkaappi', 'peilikaappi'], arch: 'carcass', size: [0.6, 0.2, 0.7], cat: 'storage-cabinet', counts: { doors: 1, shelves: 2 }, wall: 1.2 },
  { en: ['wine rack'], sv: ['vinställ'], fi: ['viiniteline'], arch: 'carcass', size: [0.6, 0.3, 0.9], cat: 'storage-cabinet', counts: { shelves: 4, compartments: 3 } },
  { en: ['shoe rack', 'shoe cabinet'], sv: ['skoställ', 'skohylla'], fi: ['kenkäteline', 'kenkähylly'], arch: 'carcass', size: [0.8, 0.3, 0.5], cat: 'storage-cabinet', counts: { shelves: 1 } },
  { en: ['filing cabinet', 'file cabinet'], sv: ['arkivskåp'], fi: ['arkistokaappi'], arch: 'carcass', size: [0.45, 0.6, 1.0], cat: 'storage-cabinet', counts: { drawers: 3 } },
  { en: ['wardrobe', 'closet', 'armoire'], sv: ['garderob', 'klädskåp'], fi: ['vaatekaappi'], arch: 'carcass', size: [1.0, 0.6, 2.0], cat: 'wardrobe', counts: { doors: 2 } },
  { en: ['chest of drawers', 'dresser', 'commode', 'drawer unit'], sv: ['byrå'], fi: ['lipasto'], arch: 'carcass', size: [0.8, 0.48, 0.8], cat: 'dresser', counts: { drawers: 4 } },
  { en: ['sideboard', 'credenza', 'buffet'], sv: ['skänk', 'sideboard'], fi: ['senkki', 'lipasto'], arch: 'carcass', size: [1.6, 0.45, 0.8], cat: 'dresser', counts: { doors: 3 } },
  { en: ['tv bench', 'tv unit', 'tv stand', 'media console'], sv: ['tv-bänk', 'tvbänk'], fi: ['tv-taso', 'tv-kaappi'], arch: 'carcass', size: [1.6, 0.4, 0.45], cat: 'tv-unit', counts: { doors: 2 } },
  { en: ['nightstand', 'bedside table', 'night table'], sv: ['sängbord', 'nattduksbord'], fi: ['yöpöytä'], arch: 'carcass', size: [0.45, 0.4, 0.55], cat: 'nightstand', counts: { drawers: 1 } },
  { en: ['display cabinet', 'vitrine', 'china cabinet'], sv: ['vitrinskåp'], fi: ['vitriini'], arch: 'carcass', size: [0.9, 0.4, 1.8], cat: 'storage-cabinet', counts: { doors: 2, shelves: 3 } },
  { en: ['toy box', 'chest', 'trunk', 'storage box', 'blanket box'], sv: ['leksakslåda', 'kista'], fi: ['lelulaatikko', 'arkku'], arch: 'carcass', size: [0.9, 0.5, 0.5], cat: 'storage-cabinet' },
  { en: ['locker'], sv: ['klädskåp'], fi: ['pukukaappi'], arch: 'carcass', size: [0.4, 0.5, 1.8], cat: 'storage-cabinet', counts: { doors: 1 } },
  { en: ['cabinet', 'cupboard', 'storage unit'], sv: ['skåp'], fi: ['kaappi'], arch: 'carcass', size: [0.8, 0.45, 1.2], cat: 'storage-cabinet', counts: { doors: 2 } },
  { en: ['sofa', 'couch', 'settee', 'loveseat'], sv: ['soffa'], fi: ['sohva'], arch: 'seat', size: [2.1, 0.92, 0.82], cat: 'sofa', features: ['backrest', 'armrests', 'cushions'], counts: { seats: 3 } },
  { en: ['armchair', 'lounge chair', 'easy chair', 'reading chair'], sv: ['fåtölj'], fi: ['nojatuoli'], arch: 'seat', size: [0.82, 0.84, 0.85], cat: 'armchair', features: ['backrest', 'armrests', 'cushions'], counts: { seats: 1 } },
  { en: ['rocking chair'], sv: ['gungstol'], fi: ['keinutuoli'], arch: 'seat', size: [0.65, 0.85, 1.0], cat: 'chair', features: ['backrest', 'armrests'], support: 'sled', counts: { seats: 1 } },
  { en: ['office chair', 'desk chair', 'gaming chair', 'swivel chair'], sv: ['kontorsstol', 'skrivbordsstol', 'gamingstol'], fi: ['toimistotuoli', 'työtuoli', 'pelituoli'], arch: 'seat', size: [0.65, 0.65, 1.1], cat: 'office-chair', features: ['backrest', 'armrests', 'wheels'], support: 'pedestal', counts: { seats: 1 } },
  { en: ['bar stool', 'counter stool'], sv: ['barstol', 'barpall'], fi: ['baarijakkara', 'baarituoli'], arch: 'disc', size: [0.4, 0.4, 0.75], cat: 'stool' },
  { en: ['stool'], sv: ['pall'], fi: ['jakkara'], arch: 'disc', size: [0.38, 0.38, 0.46], cat: 'stool' },
  { en: ['pouf', 'ottoman', 'footstool', 'hassock'], sv: ['puff', 'fotpall'], fi: ['rahi', 'puffi'], arch: 'disc', size: [0.5, 0.5, 0.42], cat: 'stool', round: true },
  { en: ['bench'], sv: ['bänk'], fi: ['penkki'], arch: 'slab', size: [1.2, 0.38, 0.45], cat: 'bench' },
  { en: ['chair', 'dining chair'], sv: ['stol'], fi: ['tuoli'], arch: 'seat', size: [0.46, 0.52, 0.85], cat: 'chair', features: ['backrest'], counts: { seats: 1 } },
  { en: ['crib', 'cot', 'baby bed'], sv: ['spjälsäng'], fi: ['pinnasänky'], arch: 'bed', size: [0.66, 1.26, 0.95], cat: 'crib', features: ['slatted'] },
  { en: ['daybed', 'day bed'], sv: ['dagbädd'], fi: ['päiväsänky'], arch: 'bed', size: [0.95, 2.05, 0.75], cat: 'bed' },
  { en: ['dog bed', 'pet bed', 'cat bed'], sv: ['hundbädd'], fi: ['koiranpeti'], arch: 'disc', size: [0.7, 0.55, 0.2], cat: 'pet', round: true },
  { en: ['bed'], sv: ['säng'], fi: ['sänky'], arch: 'bed', size: [1.6, 2.1, 1.0], cat: 'bed', features: ['headboard'] },
  { en: ['clothes rack', 'garment rack', 'clothes rail', 'coat rack'], sv: ['klädställning'], fi: ['vaaterekki'], arch: 'frame', size: [1.2, 0.45, 1.6], cat: 'storage-cabinet', counts: { shelves: 1 } },
  { en: ['towel rail', 'towel rack', 'towel ladder'], sv: ['handdukstork'], fi: ['pyyheteline'], arch: 'frame', size: [0.5, 0.35, 1.5], cat: 'decor' },
  { en: ['ladder shelf', 'leaning shelf'], sv: ['stegehylla'], fi: ['tikashylly'], arch: 'frame', size: [0.6, 0.4, 1.8], cat: 'bookshelf', counts: { shelves: 4 } },
  { en: ['bike rack', 'rack'], sv: ['ställ', 'cykelställ'], fi: ['teline'], arch: 'frame', size: [1.0, 0.4, 1.0], cat: 'decor' },
  { en: ['easel'], sv: ['staffli'], fi: ['maalausteline'], arch: 'frame', size: [0.6, 0.6, 1.7], cat: 'decor' },
  { en: ['room divider', 'folding screen', 'partition'], sv: ['rumsavdelare'], fi: ['tilanjakaja', 'sermi'], arch: 'panel', size: [1.5, 0.04, 1.8], cat: 'divider' },
  { en: ['whiteboard', 'chalkboard', 'notice board', 'menu board', 'sign', 'signboard', 'nameplate', 'plaque', 'board', 'poster'], sv: ['skylt', 'tavla'], fi: ['kyltti', 'taulu'], arch: 'panel', size: [1.0, 0.04, 0.6], cat: 'decor' },
  { en: ['mirror'], sv: ['spegel'], fi: ['peili'], arch: 'panel', size: [0.6, 0.03, 1.6], cat: 'decor', features: ['mirror'] },
  { en: ['headboard'], sv: ['sänggavel'], fi: ['sängynpääty'], arch: 'panel', size: [1.6, 0.08, 1.1], cat: 'bed' },
  { en: ['pedestal', 'column', 'plinth'], sv: ['piedestal', 'pelare'], fi: ['jalusta', 'pylväs'], arch: 'column', size: [0.4, 0.4, 1.0], cat: 'decor', counts: { platforms: 1 } },
];

// ---- lexicons --------------------------------------------------------------------------------

const MATERIAL_LEX: Array<[RegExp, MaterialId]> = [
  [/^(oak|oaken|ek|tammi|tamme)/, 'oak'], [/^(walnut|valnöt|pähkinä)/, 'walnut'], [/^(pine|furu|mänty|männy)/, 'pine'],
  [/^(birch|björk|koivu)/, 'birch'], [/^(wood|wooden|trä|puu|puinen)$/, 'oak'], [/^(glass|glas|lasi)/, 'glass'],
  [/^(steel|stål|teräs|terä|stainless)/, 'steel'], [/^(metal|iron|metall|järn|metalli|rauta)/, 'black-metal'],
  [/^(brass|mässing|messinki)/, 'brass'], [/^(chrome|krom|kromi)/, 'chrome'], [/^(leather|läder|skinn|nahka|nahkainen)/, 'leather'],
  [/^(velvet|sammet|sametti)/, 'velvet'], [/^(linen|linne|pellava)/, 'linen'], [/^(wool|ull|villa)$/, 'wool'],
  [/^(fabric|textile|tyg|kangas|boucle|bouclé)/, 'fabric'], [/^(marble|marmor|marmori)/, 'marble'], [/^(concrete|betong|betoni)/, 'concrete'],
  [/^(rattan|wicker|korg|rottinki)/, 'rattan'], [/^(ceramic|keramik|keraami)/, 'ceramic'], [/^(plastic|plast|muovi)/, 'plastic'],
  [/^(laminate|laminat|laminaatti)/, 'white-laminate'],
];
const FI_COLORS: Record<string, string> = { musta: 'black', mustat: 'black', mustilla: 'black', valkoinen: 'white', valkoiset: 'white', punainen: 'red', sininen: 'blue', vihreä: 'green', harmaa: 'grey', keltainen: 'yellow', ruskea: 'brown', vaaleanpunainen: 'pink' };

/** Part nouns (any language) to roles. */
const ROLE_LEX: Array<[RegExp, Role]> = [
  [/^(tops?|tabletops?|worktops?|surface|skiva|bordsskiva|kansi|kannet|levy|pöytälevy)$/, 'top'],
  [/^(legs?|ben|benen|jalat|jalka|jaloilla|base|bases|pedestal|stand|underframe|stativ|fot|jalusta|jalustalla|trestles?|hairpins?)$/, 'legs'],
  [/^(frame|frames|ram|ramen|stomme|runko|rungolla|carcass|body|case)$/, 'frame'],
  [/^(doors?|dörrar|dörr|luckor|lucka|ovet|ovi|ovea|ovilla)$/, 'doors'],
  [/^(drawers?|lådor|låda|laatikot|laatikko|laatikkoa)$/, 'drawers'],
  [/^(shelves|shelf|hyllor|hyllplan|hyllyt|hyllyä|hyllyllä)$/, 'shelves'],
  [/^(seat|seats|sits|sitsen|istuin|istuimet)$/, 'seat'], [/^(back|backrest|rygg|ryggen|selkänoja|selkä)$/, 'back'],
  [/^(cushions?|pillows?|dynor|kuddar|tyynyt)$/, 'cushions'], [/^(handles?|pulls?|knobs?|handtag|kahvat|vetimet)$/, 'handles'],
  [/^(wheels?|casters?|castors?|hjul|pyörät|pyörillä)$/, 'wheels'], [/^(post|posts|pole|column|stolpe|pylväs|tolppa)$/, 'post'],
  [/^(platforms?|levels?|tiers?|plattformar|tasot|tasoa)$/, 'platforms'],
];

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, pair: 2, couple: 2,
  en: 1, ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10,
  yksi: 1, kaksi: 2, kahdella: 2, kolme: 3, kolmella: 3, neljä: 4, neljällä: 4, viisi: 5, kuusi: 6, seitsemän: 7, kahdeksan: 8, yhdeksän: 9, kymmenen: 10,
};
const COUNT_NOUNS: Array<[RegExp, CountKey]> = [
  [/^(drawers?|lådor|låda|laatikko|laatikkoa|laatikot)$/, 'drawers'], [/^(doors?|dörrar|luckor|ovi|ovea|ovet)$/, 'doors'],
  [/^(shel(f|ves)|hyllor|hyllplan|hylly|hyllyä|hyllyt)$/, 'shelves'], [/^(legs?|ben|jalka|jalkaa|jalat)$/, 'legs'],
  [/^(platforms?|levels?|tiers?|plattformar|nivåer|taso|tasoa|tasot)$/, 'platforms'], [/^(wheels?|casters?|hjul|pyörää|pyörät)$/, 'wheels'],
  [/^(drums?|trummor|rumpua|rummut)$/, 'drums'], [/^(cymbals?|cymbaler|symbaalia)$/, 'cymbals'],
  [/^(compartments?|cubbies|cubes?|sections?|bays?|fack|lokeroa|lokerot)$/, 'compartments'],
  [/^(seats?|seater|people|persons?|guests?|platser|personer|hengelle|henkeä|istuinta)$/, 'seats'],
];

const FEATURE_LEX: Array<[RegExp, Feature]> = [
  [/\b(wheels?|casters?|castors?|on wheels|hjul|pyörät|pyörillä|rolling)\b/, 'wheels'], [/\b(handles?|pulls?|knobs?|handtag|kahvat|vetimet)\b/, 'handles'],
  [/\b(back ?rest|backrest|ryggstöd|selkänoja)\b/, 'backrest'], [/\b(arm ?rests?|armrests|arms|armstöd|käsinojat)\b/, 'armrests'],
  [/\b(slatted|slats|spjälor|rimat|säleet)\b/, 'slatted'], [/\b(tufted|buttoned|capitonné|knappad|napitettu)\b/, 'tufted'],
  [/\b(with a (?:small )?lamp|lamp on top|reading light|med lampa|lampulla)\b/, 'lamp'], [/\b(plant|plants|växt|kasvi)\b/, 'plant'],
  [/\b(slide|rutschkana|liukumäki)\b/, 'slide'], [/\b(rope|sisal|rep|köysi)\b/, 'rope'], [/\b(ladder|stege|tikkaat)\b/, 'ladder'],
  [/\b(cushions?|pillows?|kuddar|dynor|tyynyt)\b/, 'cushions'], [/\b(mirror|spegel|peili)\b/, 'mirror'], [/\b(headboard|sänggavel)\b/, 'headboard'],
  [/\b(rounded corners|round(ed)? edges|soft corners|rundade hörn|pyöristetyt)\b/, 'round-corners'],
];
const STYLE_LEX = ['modern', 'minimal', 'minimalist', 'scandinavian', 'nordic', 'industrial', 'rustic', 'vintage', 'retro', 'mid-century', 'classic', 'japandi', 'boho', 'art deco', 'farmhouse', 'luxury', 'playful', 'kids', 'skandinavisk', 'moderni', 'industriell'];

// Finnish and Swedish words translated before the shared number parser runs.
const PRE: Array<[RegExp, string]> = [
  [/\bmetriä\b|\bmetrin\b/g, 'm'], [/\bsenttiä\b|\bsenttimetriä\b|\bcm:n\b/g, 'cm'], [/\bpitkä\b|\bpituus\b/g, 'long'], [/\bleveä\b|\bleveys\b/g, 'wide'],
  [/\bsyvä\b|\bsyvyys\b/g, 'deep'], [/\bkorkea\b|\bkorkeus\b/g, 'high'], [/\bhalkaisija\b|\bhalkaisijaltaan\b/g, 'diameter'],
];

const ENDS = '(?:s|es|en|et|ar|er|a|n|t|ä|a)?';
export function normalizeWishText(text: string): string {
  let t = ` ${text.toLowerCase().replace(/[“”"']/g, ' ').replace(/[,;:!?()]/g, ' ')} `;
  t = t.replace(/(\d)\.(?=\s)/g, '$1').replace(/\.\s/g, ' ');
  for (const [re, en] of PRE) t = t.replace(re, en);
  for (const [fi, en] of Object.entries(FI_COLORS)) t = t.replace(new RegExp(`(^|\\s)${fi}(?=\\s)`, 'g'), `$1${en}`);
  return t.replace(/\s+/g, ' ');
}

/** Split material compounds: "ekbänk" -> "ek bänk", "tammipöytä" -> "tammi pöytä". */
function splitCompounds(t: string): string {
  const stems = ['tammi', 'koivu', 'mänty', 'pähkinä', 'lasi', 'teräs', 'metalli', 'nahka', 'ek', 'björk', 'furu', 'valnöt', 'glas', 'stål', 'metall', 'läder', 'marmor', 'marmori', 'betong', 'betoni'];
  const nouns = NOUNS.flatMap((n) => [...(n.sv ?? []), ...(n.fi ?? [])]);
  return t.split(' ').map((w) => {
    for (const s of stems) if (w.startsWith(s) && w.length > s.length + 2) {
      const rest = w.slice(s.length).replace(/^s(?=[a-zåäö]{3})/, '');
      if (nouns.some((n) => rest.startsWith(n))) return `${s} ${rest}`;
    }
    return w;
  }).join(' ');
}

function findNoun(t: string): { noun: Noun; at: number; word: string } | null {
  const head = t.split(/\s(?:with|med|jossa|plus|featuring)\s/)[0];
  for (const scope of head !== t ? [head, t] : [t]) {
    let best: { noun: Noun; at: number; word: string } | null = null;
    for (const n of NOUNS) {
      for (const w of n.en) {
        const m = new RegExp(`(^|\\s)${w.replace(/[-]/g, '[- ]?')}(s|es)?(?=\\s|$)`).exec(scope);
        if (m && (!best || w.length > best.word.length)) best = { noun: n, at: m.index, word: w };
      }
      for (const w of [...(n.sv ?? []), ...(n.fi ?? [])]) {
        const m = new RegExp(`(^|\\s)${w}${ENDS}[a-zåäö]{0,4}(?=\\s|$)`).exec(scope);
        if (m && (!best || w.length > best.word.length)) best = { noun: n, at: m.index, word: w };
      }
    }
    if (best) return best;
  }
  return null;
}

/** Nearest archetype for an unknown noun, by keywords and then by stated proportions. */
function guessNoun(t: string, dims: { w?: number; d?: number; h?: number }): Noun {
  const by = (cat: string) => NOUNS.find((n) => n.en.includes(cat))!;
  if (/\b(stand|tower|post|pole|totem|holder)\b/.test(t)) return by('pedestal');
  if (/\b(rack|rail|hanger|frame)\b/.test(t)) return by('rack');
  if (/\b(box|chest|unit|storage|organizer|organiser|bin|crate|locker)\b/.test(t)) return by('cabinet');
  if (/\b(counter|surface|tabletop|altar|bar)\b/.test(t)) return by('table');
  if (/\b(seat|throne|recliner|lounger|swing)\b/.test(t)) return by('armchair');
  if (/\b(sign|panel|board|screen|plaque|banner)\b/.test(t)) return by('sign');
  if (/\b(light|lantern|sconce|chandelier)\b/.test(t)) return by('lamp');
  if (/\b(mattress|futon|bunk|cot)\b/.test(t)) return by('bed');
  const { w, d, h } = dims;
  if (h !== undefined && h > 1.5 * Math.max(w ?? 0.4, d ?? 0.4)) return by('cabinet');
  if (h !== undefined && w !== undefined && h < 0.6 * w) return by('table');
  return by('cabinet');
}

const ROUND3 = (v: number) => Math.round(v * 1000) / 1000;

/** Read a description into a wish list. */
export function parseWish(text: string): Wish {
  let t = splitCompounds(normalizeWishText(text));
  // Printed words: "with GERARD written on it", "that says OPEN", "med texten HEJ", "jossa lukee MOI".
  let printed: string | undefined;
  const tm = /(?:with|and)\s+(?:the\s+(?:word|name|text)s?\s+)?["“]?([^\s"“”]+(?: [^\s"“”]+){0,2}?)["”]?\s+(?:written|printed|painted|engraved)\s+on\s+(?:it|the\s+\w+)/i.exec(text)
    ?? /(?:that\s+says|saying|reading|with\s+the\s+(?:word|name|text)|med\s+texten|jossa\s+lukee|tekstillä)\s+["“]?([^\s"“”]+(?: [^\s"“”]+){0,2}?)["”]?(?=\s*(?:$|[,.;]|\s(?:on|in|and|with|för|for)\b))/i.exec(text);
  if (tm) {
    printed = tm[1].replace(/^(with|the|a)\s+/i, '').trim();
    t = t.replace(tm[0].toLowerCase().replace(/["“”,]/g, ' ').replace(/\s+/g, ' ').trim(), ' ');
  }

  const p = parseRequest(t);
  const found = findNoun(t);
  const noun = found?.noun ?? guessNoun(t, p);
  const w: Wish = {
    text, noun: found ? noun.en[0] : '', archetype: noun.arch, category: noun.cat,
    size: { w: noun.size[0], d: noun.size[1], h: noun.size[2] }, stated: { w: false, d: false, h: false },
    counts: { ...(noun.counts ?? {}) }, support: noun.support, round: !!noun.round,
    looks: {}, style: [], features: [...(noun.features ?? [])], text_: printed,
    wallMounted: noun.wall !== undefined, elevation: noun.wall,
  };
  const toks = t.trim().split(' ');

  // Counts: "<number> <noun>", any language, digits or words.
  for (let i = 0; i < toks.length - 1; i++) {
    const n = /^\d{1,2}$/.test(toks[i]) ? parseInt(toks[i], 10) : NUMBER_WORDS[toks[i]];
    if (n === undefined) continue;
    for (let j = i + 1; j <= Math.min(i + 3, toks.length - 1); j++) {
      const key = COUNT_NOUNS.find(([re]) => re.test(toks[j]))?.[1];
      if (key) { if (!(n === 1 && (toks[i] === 'a' || toks[i] === 'an') && key in w.counts && key !== 'seats')) w.counts[key] = n; break; }
      if (!/^(small|large|big|deep|wide|open|glass|black|white|oak|soft|drum|tom|crash|ride|floor|top|bottom|pienet?|isoa?|syvää|[a-zåäö]+-?(?:colou?red))$/.test(toks[j]) && !MATERIAL_LEX.some(([re]) => re.test(toks[j]))) break;
    }
  }
  if (p.seats) w.counts.seats = p.seats;
  if (/\b(drawers?|lådor|laatikko\w*)\b/.test(t) && !w.counts.drawers) w.counts.drawers = /\bdrawers|lådor|laatikot|laatikoilla\b/.test(t) ? 3 : 1;
  if (/\b(doors|dörrar|ovet|ovilla)\b/.test(t) && !w.counts.doors) w.counts.doors = 2;
  if (/\b(a door|en dörr)\b/.test(t) && !w.counts.doors) w.counts.doors = 1;
  if (/\b(shelves|hyllor|hyllyt)\b/.test(t) && w.counts.shelves === undefined) w.counts.shelves = 3;

  // Size: numbers first, then size words.
  const kindIsLong = noun.arch === 'bed' || noun.arch === 'bunk';
  if (p.w !== undefined) { if (kindIsLong && /\blong\b|\blength\b/.test(t) && p.d === undefined) { w.size.d = p.w; w.stated.d = true; } else { w.size.w = p.w; w.stated.w = true; } }
  if (p.d !== undefined) { w.size.d = p.d; w.stated.d = true; }
  if (p.h !== undefined) { w.size.h = p.h; w.stated.h = true; }
  w.round = w.round || p.round || /\b(round|circular|rund|pyöreä)\b/.test(t);
  if (w.round && w.stated.w && !w.stated.d) { w.size.d = w.size.w; w.stated.d = true; }
  if (w.round && !w.stated.w && !w.stated.d && (noun.arch === 'slab' || noun.arch === 'disc')) { const m = Math.min(w.size.w, Math.max(w.size.d, 0.5) * 1.4); w.size.w = w.size.d = ROUND3(m); }
  const H: Array<[RegExp, number]> = [[/\b(knee|ankle)[- ]height\b|\bknähöjd\b|\bpolvenkorkuinen\b/, 0.5], [/\b(waist|counter)[- ]height\b|\bmidjehöjd\b/, 0.9], [/\bbar[- ]height\b|\bbarhöjd\b/, 1.05], [/\b(eye|head)[- ]height\b/, 1.6], [/\bceiling[- ]high\b|\btakhög\b/, 2.4]];
  for (const [re, h] of H) if (!w.stated.h && re.test(t)) { w.size.h = h; w.stated.h = true; }
  if (w.counts.seats && (noun.arch === 'slab' || noun.cat === 'sofa' || noun.cat === 'bench') && !w.stated.w) {
    const s = w.counts.seats;
    if (noun.cat === 'sofa') w.size.w = ROUND3(Math.max(1.3, s * 0.62 + 0.3));
    else if (noun.cat === 'bench') w.size.w = ROUND3(s * 0.55);
    else if (w.round) { const dia = s <= 2 ? 0.7 : s <= 4 ? 1.05 : s <= 6 ? 1.3 : 1.5; w.size.w = w.size.d = dia; }
    else if (noun.cat !== 'desk') { w.size.w = s <= 2 ? 0.75 : s <= 4 ? 1.2 : ROUND3(Math.ceil((s - 2) / 2) * 0.6 + 0.2); w.size.d = s <= 2 ? 0.75 : 0.9; }
  }
  if (!w.stated.h && /\b(tall|high|hög|korkea)\b/.test(t)) w.size.h = ROUND3(noun.arch === 'carcass' ? Math.max(2.0, w.size.h * 1.3) : w.size.h * 1.3);
  if (!w.stated.h && /\b(low|låg|matala)\b/.test(t)) w.size.h = ROUND3(w.size.h * 0.7);
  if (!w.stated.w && /\b(narrow|slim|smal|kapea)\b/.test(t)) w.size.w = ROUND3(Math.max(0.3, w.size.w * 0.6));
  if (!w.stated.w && /\b(wide|broad|bred|leveä)\b/.test(t)) w.size.w = ROUND3(w.size.w * 1.35);
  if (!w.stated.d && /\b(shallow|grund)\b/.test(t)) w.size.d = ROUND3(w.size.d * 0.65);
  if (/\b(small|little|mini|compact|liten|pieni)\b/.test(t)) for (const k of ['w', 'd', 'h'] as const) if (!w.stated[k]) w.size[k] = ROUND3(w.size[k] * 0.75);
  if (/\b(large|big|huge|stor|iso|suuri)\b/.test(t)) for (const k of ['w', 'd'] as const) if (!w.stated[k]) w.size[k] = ROUND3(w.size[k] * 1.25);
  if (/\b(double|queen|king)\b/.test(t) && noun.arch === 'bed' && !w.stated.w) w.size.w = /king/.test(t) ? 1.8 : 1.6;
  if (/\b(single|twin)\b/.test(t) && noun.arch === 'bed' && !w.stated.w) w.size.w = 0.9;

  // Support style.
  if (/\b(pedestal|central leg|pelarfot|tulip)\b/.test(t)) w.support = 'pedestal';
  else if (/\b(trestle|bock|pukki)\w*/.test(t)) w.support = 'trestle';
  else if (/\bhairpin/.test(t)) w.support = 'hairpin';
  else if (/\b(sled|skid|mede)\b/.test(t)) w.support = 'sled';
  else if (/\b(plinth|sockel)\b/.test(t)) w.support = 'plinth';
  if (w.counts.legs === undefined && /\b(3|three|tre|kolme) ?(legs?|ben|jalkaa)\b/.test(t)) w.counts.legs = 3;
  if (!w.support && /\b(legs|on legs|ben|jalat|jaloilla|jalkaa)\b/.test(t)) w.support = 'legs';

  // Features and style.
  for (const [re, f] of FEATURE_LEX) if (re.test(t) && !w.features.includes(f)) w.features.push(f);
  if (/\b(no|without|utan|ilman) (back|backrest|rygg|selkänojaa)\b|\bbackless\b/.test(t)) w.features = w.features.filter((f) => f !== 'backrest');
  if (/\b(no|without|utan|ilman) (arms|armrests|armstöd)\b|\barmless\b/.test(t)) w.features = w.features.filter((f) => f !== 'armrests');
  if (/\b(no|without|utan|ilman) (wheels|hjul)\b/.test(t)) w.features = w.features.filter((f) => f !== 'wheels');
  if (w.features.includes('lamp') && noun.arch === 'lamp') w.features = w.features.filter((f) => f !== 'lamp');
  if (w.features.includes('wheels') && w.counts.wheels === undefined) w.counts.wheels = 4;
  if (w.features.includes('wheels') && noun.arch !== 'seat') w.support = 'wheels';
  if (noun.arch === 'column' && w.features.includes('rope') === false && /\bscratch/.test(t)) w.features.push('rope');
  for (const s of STYLE_LEX) if (new RegExp(`\\b${s}\\b`).test(t)) w.style.push(s);
  if (/\b(wall[- ]mounted|wall[- ]hung|on the wall|floating|väggmonterad|seinäkiinnitteinen)\b/.test(t)) { w.wallMounted = true; w.elevation ??= noun.arch === 'carcass' ? 1.3 : 1.0; }

  // Materials and colours per part: words right before a part noun belong to that part.
  const colorOf = (word: string) => findColors(` ${word} `)[0]?.hex;
  const matOf = (word: string) => MATERIAL_LEX.find(([re]) => re.test(word))?.[1];
  const used = new Set<number>();
  const pin = (role: Role, look: Look) => { const cur = w.looks[role] ?? {}; w.looks[role] = { material: cur.material ?? look.material, color: cur.color ?? look.color }; };
  for (let i = 0; i < toks.length; i++) {
    const role = ROLE_LEX.find(([re]) => re.test(toks[i]))?.[1];
    const isNoun = found && toks[i].startsWith(found.word.split(' ').pop()!.slice(0, 4));
    if (!role && !isNoun) continue;
    let mat: MaterialId | undefined, col: string | undefined;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const m = matOf(toks[j]), c = colorOf(toks[j]);
      if (!m && !c) { if (/^(matte|matt|brushed|polished|dark|light|solid|smoked|tinted|natural|\d+|coffee|dining|side|bar|round|tall|narrow|bunk|cat|floor)$/.test(toks[j])) continue; break; }
      if (m && !mat) mat = m; if (c && !col) col = c; used.add(j);
    }
    if (mat === 'black-metal' || mat === 'steel') if (col && colorOf('black') === col) mat = 'black-metal';
    if (mat === 'white-laminate' && col && colorOf('black') === col) mat = 'black-laminate';
    if (mat || col) pin(role && !isNoun ? role : 'main', { material: mat, color: mat === 'black-metal' ? undefined : col });
  }
  // Loose material and colour words describe the whole object.
  for (let i = 0; i < toks.length; i++) {
    if (used.has(i)) continue;
    const m = matOf(toks[i]); const c = colorOf(toks[i]);
    if (m && !w.looks.main?.material) pin('main', { material: m });
    else if (c && !w.looks.main?.color && !/\b(no|without)$/.test(toks[i - 1] ?? '')) pin('main', { color: c });
  }
  if (w.looks.legs && w.support === undefined && /\bpedestal|jalusta|pelarfot\b/.test(t)) w.support = 'pedestal';
  for (const k of ['w', 'd', 'h'] as const) w.size[k] = ROUND3(w.size[k]);
  return w;
}

/** The wishes as short, checkable lines (for prompts and for reporting what was met). */
export function wishLines(w: Wish): string[] {
  const out: string[] = [];
  const cm = (m: number) => Math.round(m * 100);
  if (w.noun) out.push(`object: ${w.noun}`);
  for (const k of ['w', 'd', 'h'] as const) if (w.stated[k]) out.push(`${k}: ${cm(w.size[k])} cm`);
  for (const [k, v] of Object.entries(w.counts)) if (v !== undefined && v > 0) out.push(`${k}: ${v}`);
  for (const [r, l] of Object.entries(w.looks)) if (l && (l.material || l.color)) out.push(`${r}: ${[l.material, l.color].filter(Boolean).join(' ')}`);
  for (const f of w.features) out.push(`feature: ${f}`);
  if (w.support) out.push(`support: ${w.support}`);
  if (w.round) out.push('shape: round');
  if (w.text_) out.push(`text: ${w.text_}`);
  if (w.wallMounted) out.push(`wall-mounted at ${cm(w.elevation ?? 1)} cm`);
  return out;
}
