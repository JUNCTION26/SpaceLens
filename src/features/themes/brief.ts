// A themed room brief: who the room is for, the names to print, a palette, a mood and the object
// list. One fast model call writes it; rules write it without a key (and when the call fails).
import { ai, aiReady, partialJson } from '../../core/ai';
import { CATALOG } from '../furniture/catalog';
import { motifOf } from '../forge/decorKits';

export const RECIPES = ['poster', 'sign', 'banner', 'wallshelf', 'clock', 'neon', 'statue', 'cat-tree', 'pet-bed', 'scratching-post', 'litter-box', 'pet-bowls', 'toy-basket', 'window-perch', 'vanity'] as const;
export type Recipe = (typeof RECIPES)[number];
/** Recipes that hang on a wall. */
export const WALL_RECIPES = new Set<Recipe>(['poster', 'sign', 'banner', 'wallshelf', 'clock', 'neon']);
/** Recipes always built in code: exact words, instant, no model call. */
export const DECOR_RECIPES = new Set<Recipe>(['poster', 'sign', 'banner', 'wallshelf', 'clock', 'neon', 'statue']);

export interface ThemeObject {
  source: 'catalogue' | 'custom' | 'store';
  name: string;
  /** Catalogue piece (source catalogue), or the closest catalogue stand-in for a custom or store piece. */
  catalogId?: string;
  /** Full forge prompt with exact size, colours, theme details and words to print. */
  prompt?: string;
  /** Store search phrase for a real product. */
  query?: string;
  recipe?: Recipe;
  /** Size in centimetres [w, d, h]. */
  sizeCm?: [number, number, number];
  mount?: 'floor' | 'wall';
  /** Words printed on it. */
  text?: string;
  /** Kit style: motif (paw, heart, star, crown, bat, flower, moon, controller, book, leaf) or statue theme. */
  style?: string;
  color?: string;
  accent?: string;
  /** Where it wants to be. */
  place?: 'corner' | 'window' | 'wall' | 'free';
  qty?: number;
}

export interface ThemeBrief {
  title: string;
  purpose: string;
  forWhom: string;
  names: string[];
  palette: string[];
  mood: string;
  objects: ThemeObject[];
  realProducts: boolean;
  notes: string[];
  by: 'gemini' | 'rules';
  model?: string;
  ms: number;
}

// ---- detection -----------------------------------------------------------------------------

/** Names of characters and brands: the room gets a generic look in that spirit, never their marks. */
const FRANCHISE: Array<[RegExp, string, string]> = [
  [/barbie/, 'pink', 'a hot-pink dream room in that spirit (no logos or trademarks)'],
  [/batman|gotham|dark knight/, 'bat', 'a generic bat theme (no characters or logos)'],
  [/spider-?man|superman|marvel|avengers|wonder woman|super ?hero/, 'hero', 'a generic caped-hero theme (no characters or logos)'],
  [/frozen|elsa|princess|disney/, 'princess', 'a generic princess theme (no characters or logos)'],
  [/minecraft|mario|pok[eé]mon|pikachu|zelda|fortnite/, 'game', 'a generic game theme (no characters or logos)'],
  [/hello kitty/, 'pink', 'a generic cute pink theme (no characters or logos)'],
];

const THEMED = /\b(for my (cat|dog|kitten|puppy|pet|son|daughter|kids?|boy|girl)|cat room|dog room|named|called|themed?|barbie|princess|unicorn|dinosaur|space room|gaming|gamer|reading nook|nook|real (ikea )?products|ikea|from (a|the) store|batman|bat room|super ?hero|spider-?man|pok[eé]mon|minecraft|mario)\b/;

/** True for briefs about a theme, a character, a pet, a named person or real products. */
export function isThemedRequest(text: string): boolean {
  return THEMED.test(text.toLowerCase());
}

/** Words a plain furnishing request is made of. Anything else names a particular kind of room. */
const PLAIN = new Set(`a an the and or of in on at to for with without by near from into my our your me us i we it its this that
need want would like make design create build plan furnish arrange set up please give some new room space area place corner
one two three four five six seven eight nine ten twelve couple people person persons guests seats users staff patients family
office workspace work study workroom bedroom guest studio flat apartment living lounge dining kitchen cafe café clinic treatment
therapy kids kid child children playroom home small big large tiny bright warm cosy cozy modern classic minimal minimalist
scandinavian nordic industrial boho japandi calm light dark desk desks bed beds sofa sofas couch chair chairs table tables
wardrobe shelf shelves bookcase storage armchair armchairs plant plants lamp lamps rug rugs carpet crib cot sofa-bed bench
route path access walk way window door balcony clear free wide cm m mm aisle passage clearance wheelchair accessible rollator
walker keep existing current old budget under below max maximum up within around about kr sek kronor k thousand also all each
per both more less enough good nice simple functional practical meeting conference`.split(/\s+/));

/** Words in the request that a plain furnishing request would not use ("ramen", "viking", "1970s"). */
export function unknownWords(text: string): string[] {
  return text.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9åäöéü]+/)
    .filter((w) => w && !PLAIN.has(w) && !PLAIN.has(w.replace(/e?s$/, '')) && !/^\d+(cm|m|mm|k|kr|sek)?$/.test(w));
}

/** Names to print: "named Gerard", "called Ada", "for Lily". */
export function findNames(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:named|called|name is|for)\s+([A-ZÅÄÖ][a-zåäöé]+(?:\s+[A-ZÅÄÖ][a-zåäöé]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (!/^(My|The|A|An|Two|Three|Four|Me|Us|Him|Her|IKEA)$/i.test(m[1])) out.push(m[1]);
  return [...new Set(out)];
}

// ---- rules brief -----------------------------------------------------------------------------

const cm = (w: number, d: number, h: number): [number, number, number] => [w, d, h];
const sz = (s: [number, number, number]) => `${s[0]} x ${s[1]} x ${s[2]} cm`;

function custom(name: string, recipe: Recipe | undefined, sizeCm: [number, number, number], extra: Partial<ThemeObject>, theme: string): ThemeObject {
  const words = extra.text ? `, with the words "${extra.text}" printed on the front` : '';
  const colours = [extra.color, extra.accent].filter(Boolean).join(' and ');
  return {
    source: 'custom', name, recipe, sizeCm, mount: recipe && WALL_RECIPES.has(recipe) ? 'wall' : 'floor', ...extra,
    prompt: extra.prompt ?? `${name}, ${sz(sizeCm)}${colours ? `, colours ${colours}` : ''}, ${theme}${words}`,
  };
}

const cat = (id: string, name: string, place?: ThemeObject['place']): ThemeObject => ({ source: 'catalogue', name, catalogId: id, place });

function petRoom(text: string, names: string[], dog: boolean): Omit<ThemeBrief, 'by' | 'ms'> {
  const pet = dog ? 'dog' : 'cat', who = names[0];
  const P = { main: '#e9d8bf', accent: '#c46b4b', soft: '#f6efe4', dark: '#5a4636' };
  const t = `${pet} room, warm natural tones`;
  const objs: ThemeObject[] = [
    ...(dog ? [] : [custom('Cat tree', 'cat-tree', cm(60, 60, 150), { color: P.main, accent: P.accent, prompt: `Cat tree with sisal-wrapped posts, three carpeted platforms and a round bed on top, ${sz(cm(60, 60, 150))}, beige carpet ${P.main} and terracotta ${P.accent} cushions` }, t)]),
    custom(dog ? 'Dog bed' : 'Cat bed', 'pet-bed', dog ? cm(90, 70, 25) : cm(55, 45, 20), { color: P.accent, accent: P.soft, place: 'wall' }, t),
    ...(dog ? [] : [custom('Scratching post', 'scratching-post', cm(40, 40, 80), { color: P.main }, t)]),
    custom('Food and water bowls on a mat', 'pet-bowls', cm(50, 30, 8), { color: P.soft, accent: P.accent, place: 'wall' }, t),
    custom('Toy basket', 'toy-basket', cm(40, 30, 28), { color: '#c8a46a' }, t),
    ...(dog ? [] : [custom('Litter box', 'litter-box', cm(55, 45, 42), { color: '#e6e1d8', place: 'corner' }, t)]),
    custom(dog ? 'Window bench' : 'Window perch', 'window-perch', cm(60, 35, 50), { color: P.accent, place: 'window' }, t),
    custom(who ? `${who} poster` : `${pet} poster`, 'poster', cm(50, 3, 70), { text: who ? who.toUpperCase() : undefined, style: 'paw', color: P.soft, accent: P.dark }, t),
    ...(who ? [custom(`${who} name sign`, 'sign', cm(70, 2.5, 22), { text: who, style: 'paw', color: '#c79a63', accent: '#3b2a1a' }, t)] : []),
    custom('Wall shelf', 'wallshelf', cm(80, 22, 30), { color: '#b08a5a' }, t),
    cat('armchair', 'Armchair for you'),
    cat('rug-160', 'Rug'),
  ];
  return { title: who ? `${who}'s room` : `${pet[0].toUpperCase()}${pet.slice(1)} room`, purpose: `${pet} room`, forWhom: who ? `a ${pet} named ${who}` : `a ${pet}`, names, palette: Object.values(P), mood: 'warm, playful, safe', objects: objs, realProducts: false, notes: [] };
}

function pinkRoom(names: string[], note?: string): Omit<ThemeBrief, 'by' | 'ms'> {
  const P = { hot: '#ff4fa3', soft: '#ffc1dc', white: '#fff7fb', gold: '#d4af37' };
  const t = 'hot-pink dream bedroom, glossy pink and white with gold accents';
  const who = names[0];
  return {
    title: who ? `${who}'s pink room` : 'Pink dream room', purpose: 'bedroom', forWhom: who ?? 'a doll fan', names, palette: Object.values(P), mood: 'bright, glamorous, playful',
    objects: [
      { ...custom('Pink canopy bed', undefined, cm(140, 200, 210), { color: P.hot, accent: P.white, prompt: `Hot-pink canopy bed with a heart headboard, white drapes, gold finials and pink bedding with heart cushions, ${sz(cm(140, 200, 210))}, colours hot pink ${P.hot}, white ${P.white}, gold` }, t), catalogId: 'bed-double', place: 'wall' },
      custom('Vanity with mirror', 'vanity', cm(100, 45, 150), { color: P.white, accent: P.gold }, t),
      { ...custom('Pink wardrobe', undefined, cm(100, 60, 200), { color: P.soft, accent: P.gold, prompt: `Pink wardrobe with two doors, gold handles and a crown top, ${sz(cm(100, 60, 200))}, pink ${P.soft} with gold ${P.gold}` }, t), catalogId: 'wardrobe-100' },
      { ...custom('Fluffy pink rug', undefined, cm(160, 230, 2), { color: P.soft, prompt: `Fluffy shaggy pink rug, ${sz(cm(160, 230, 2))}, pink ${P.soft}` }, t), catalogId: 'rug-160' },
      custom('Star poster', 'poster', cm(50, 3, 70), { style: 'star', color: P.soft, accent: P.hot }, t),
      custom('Heart neon', 'neon', cm(60, 4, 35), { style: 'heart', color: P.hot, text: who ?? 'DREAM' }, t),
      custom('Pink wall shelf', 'wallshelf', cm(80, 22, 30), { color: P.white, accent: P.hot }, t),
      cat('nightstand', 'Nightstand'),
      cat('floor-lamp', 'Floor lamp'),
    ],
    realProducts: false, notes: note ? [`Uses ${note}.`] : [],
  };
}

function gamingRoom(n: number): Omit<ThemeBrief, 'by' | 'ms'> {
  const P = { dark: '#1b1d24', blue: '#2e6bff', violet: '#8a3ffc', glow: '#26e0ff' };
  const t = 'gaming room, matte black with blue and violet lights';
  return {
    title: n > 1 ? `Gaming room for ${n}` : 'Gaming room', purpose: 'gaming', forWhom: n > 1 ? `${n} gamers` : 'a gamer', names: [], palette: Object.values(P), mood: 'dark, focused, glowing',
    objects: [
      { ...custom('Gaming desk', undefined, cm(140, 70, 75), { color: P.dark, accent: P.blue, prompt: `Black gaming desk with a monitor shelf, two monitors and a blue light strip, ${sz(cm(140, 70, 75))}, black ${P.dark} with blue ${P.blue}` }, t), catalogId: 'desk-140', qty: n, place: 'wall' },
      { ...custom('Gaming chair', undefined, cm(70, 70, 130), { color: P.dark, accent: P.violet, prompt: `Gaming chair with racing back, ${sz(cm(70, 70, 130))}, black ${P.dark} with violet ${P.violet} stripes` }, t), catalogId: 'office-chair', qty: n },
      custom('Neon sign', 'neon', cm(70, 4, 30), { text: 'GAME ON', color: P.glow }, t),
      custom('Player poster', 'poster', cm(50, 3, 70), { style: 'controller', text: 'PLAYER 1', color: '#22252e', accent: P.glow }, t),
      ...(n > 1 ? [custom('Second player poster', 'poster', cm(50, 3, 70), { style: 'controller', text: 'PLAYER 2', color: '#22252e', accent: P.violet }, t)] : []),
      custom('Game shelf', 'wallshelf', cm(80, 22, 30), { color: P.dark, accent: P.blue }, t),
      cat('sofa-2', 'Sofa for guests'),
      cat('rug-160', 'Rug'),
    ],
    realProducts: false, notes: [],
  };
}

function readingNook(): Omit<ThemeBrief, 'by' | 'ms'> {
  const P = { sage: '#8aa38b', cream: '#efe6d6', oak: '#b08a5a', clay: '#c98b6b' };
  const t = 'calm reading nook, sage green, cream and warm oak';
  return {
    title: 'Calm reading nook', purpose: 'reading', forWhom: 'a reader', names: [], palette: Object.values(P), mood: 'calm, soft, quiet',
    objects: [
      { ...custom('Reading armchair', undefined, cm(85, 85, 95), { color: P.sage, prompt: `Deep wingback reading armchair with a footstool, ${sz(cm(85, 85, 95))}, sage green velvet ${P.sage}, oak legs` }, t), catalogId: 'armchair', place: 'window' },
      cat('floor-lamp', 'Floor lamp'),
      cat('bookshelf', 'Bookshelf'),
      cat('plant', 'Floor plant', 'corner'),
      cat('rug-160', 'Rug'),
      custom('Book shelf', 'wallshelf', cm(80, 22, 30), { color: P.oak }, t),
      custom('Read poster', 'poster', cm(50, 3, 70), { style: 'leaf', text: 'READ', color: P.cream, accent: '#3e5f46' }, t),
      custom('Wall clock', 'clock', cm(35, 5, 35), { color: P.oak }, t),
    ],
    realProducts: false, notes: [],
  };
}

function homeOffice(real: boolean, store: string): Omit<ThemeBrief, 'by' | 'ms'> {
  const s = (name: string, id: string, query: string): ThemeObject => (real ? { source: 'store', name, catalogId: id, query: `${store} ${query}` } : cat(id, name));
  const t = 'calm home office, white and light oak';
  return {
    title: real ? `Home office with ${store} products` : 'Home office', purpose: 'work', forWhom: 'remote work', names: [], palette: ['#f2efe9', '#d8c7a8', '#2f3a44'], mood: 'clean, focused',
    objects: [
      { ...s('Desk', 'desk-140', 'desk 140 cm'), place: 'window' },
      s('Office chair', 'office-chair', 'office chair'),
      s('Bookcase', 'bookshelf', 'bookcase'),
      s('Floor lamp', 'floor-lamp', 'floor lamp'),
      s('Plant', 'plant', 'artificial potted plant'),
      custom('Wall shelf', 'wallshelf', cm(80, 22, 30), { color: '#d8c7a8' }, t),
      custom('Wall clock', 'clock', cm(35, 5, 35), { color: '#2f3a44' }, t),
    ],
    realProducts: real, notes: real ? [] : [],
  };
}

function genericRoom(text: string, names: string[], motif: string | undefined, note?: string): Omit<ThemeBrief, 'by' | 'ms'> {
  const who = names[0];
  const dark = motif === 'bat';
  const P = dark ? { a: '#1c1e26', b: '#f2c94c', c: '#3a3f4b' } : motif === 'hero' ? { a: '#1f4fa8', b: '#e53935', c: '#f2c94c' } : motif === 'princess' ? { a: '#b9a3ff', b: '#ffffff', c: '#d4af37' } : { a: '#2f4f6f', b: '#f2c94c', c: '#efe6d6' };
  const theme = motif === 'hero' ? 'caped hero' : motif ?? 'playful';
  const t = `${theme} themed bedroom`;
  const style = motif === 'hero' ? 'star' : motif === 'princess' ? 'crown' : motif === 'game' ? 'controller' : motif;
  return {
    title: who ? `${who}'s ${theme} room` : `${theme[0].toUpperCase()}${theme.slice(1)} room`, purpose: 'bedroom', forWhom: who ?? 'a child', names, palette: Object.values(P), mood: dark ? 'moody, heroic' : 'bright, playful',
    objects: [
      { ...custom(`${theme} bed`, undefined, cm(90, 200, 100), { color: P.a, accent: P.b, prompt: `Single bed with a ${theme} headboard, ${sz(cm(90, 200, 100))}, colours ${P.a} and ${P.b}` }, t), catalogId: 'bed-single', place: 'wall' },
      cat('desk-120', 'Desk', 'window'), cat('desk-chair', 'Desk chair'), cat('wardrobe-100', 'Wardrobe'), cat('rug-160', 'Rug'),
      custom(`${theme} poster`, 'poster', cm(50, 3, 70), { style, text: who?.toUpperCase(), color: P.c, accent: P.a }, t),
      ...(who ? [custom(`${who} name sign`, 'sign', cm(70, 2.5, 22), { text: who, style, color: P.a, accent: P.b }, t)] : []),
      custom(`${theme} statue`, 'statue', cm(35, 35, 90), { style: motif ?? 'star', color: dark ? '#2b2b2b' : P.a, accent: P.b }, t),
      custom('Wall shelf', 'wallshelf', cm(80, 22, 30), { color: P.a }, t),
    ],
    realProducts: false, notes: note ? [`Uses ${note}.`] : [],
  };
}

// ---- general rooms (offline fallback for any idea the examples above do not cover) ----------

type Kind = 'service' | 'bar' | 'cafe' | 'movement' | 'nursery' | 'flat' | 'make' | 'living' | 'bedroom';
const KINDS: Array<[Kind, RegExp]> = [
  ['nursery', /\b(nursery|baby|babies|toddler|newborn)\b/],
  ['service', /\b(waiting|reception|lobby|dentist|doctor|clinic|salon|barber|groom(er|ing)?|vet|spa|massage|nail|tattoo|shop|boutique|store)\b/],
  ['bar', /\b(bar|pub|ramen|sushi|izakaya|noodle|counter|tavern|saloon)\b/],
  ['cafe', /\b(caf[eé]|coffee|tea ?room|restaurant|diner|bistro|bakery|pizzeria|canteen|board.?game)\b/],
  ['movement', /\b(yoga|pilates|gym|fitness|dance|meditation|martial|boxing|workout|stretch)\b/],
  ['flat', /\b(studio (flat|apartment)|flat|apartment|bedsit|tiny home|granny)\b/],
  ['make', /\b(recording|podcast|studio|workshop|craft|art|maker|sewing|music|lab|atelier|office|work)\b/],
  ['bedroom', /\b(bedroom|teen(ager)?'?s?|kids?|child(ren)?|boy|girl|sleep)\b/],
  ['living', /\b(lounge|den|cave|hall|club|living|cinema|movie|listening|longhouse|parlou?r|salon)\b/],
];

/** The broad kind of room words describe, or undefined when nothing matches. */
export function roomKind(text: string): Kind | undefined {
  const lc = text.toLowerCase();
  return KINDS.find(([, re]) => re.test(lc))?.[0];
}

const titleOf = (text: string) => {
  const t = text.trim().replace(/^(please\s+)?((make|build|design|create|plan|furnish|give)( me| us)?\s+)?(an?|the|my|our)\s+/i, '').replace(/[.!?]+$/, '');
  return (t[0]?.toUpperCase() ?? '') + t.slice(1, 50);
};

/** A sensible room of the right broad kind, with the idea's name on a sign, plus an honest note. */
function generalRoom(text: string, names: string[], people: number, motif?: string): Omit<ThemeBrief, 'by' | 'ms'> {
  const kind = roomKind(text) ?? 'living';
  const title = titleOf(text) || 'Room';
  const P = { a: '#3f5b6b', b: '#e9dfcf', c: '#c98b4b' };
  const n = Math.max(1, Math.min(12, people));
  const sign = custom(`${title} sign`, 'sign', cm(80, 2.5, 25), { text: title.slice(0, 24), color: P.a, accent: P.b }, title);
  const q = (o: ThemeObject, qty: number): ThemeObject => (qty > 1 ? { ...o, qty } : o);
  const sets: Record<Kind, ThemeObject[]> = {
    service: [cat('reception-desk', 'Reception desk', 'wall'), q(cat('waiting-chair', 'Waiting chair', 'wall'), Math.min(6, Math.max(3, n))), cat('coffee-table', 'Low table'), cat('plant', 'Plant', 'corner'), cat('storage-cabinet', 'Storage cabinet', 'wall')],
    bar: [cat('counter', 'Counter', 'wall'), q(cat('bar-stool', 'Bar stool'), Math.min(8, Math.max(2, n))), cat('display-shelf', 'Shelf', 'wall'), cat('plant', 'Plant', 'corner')],
    cafe: [q(cat('cafe-4', 'Table'), Math.min(4, Math.ceil(n / 4))), q(cat('chair', 'Chair'), Math.min(12, Math.max(4, n))), cat('counter', 'Counter', 'wall'), cat('display-shelf', 'Shelf', 'wall'), cat('plant', 'Plant', 'corner')],
    movement: [q(cat('rug-160', 'Mat area'), 2), cat('bench', 'Bench', 'wall'), cat('storage-cabinet', 'Storage', 'wall'), q(cat('plant', 'Plant', 'corner'), 2)],
    nursery: [cat('crib', 'Crib', 'wall'), cat('dresser', 'Changing dresser', 'wall'), cat('armchair', 'Nursing chair'), cat('toy-storage', 'Toy storage', 'wall'), cat('rug-160', 'Rug')],
    flat: [cat('bed-double', 'Bed', 'wall'), cat('sofa-2', 'Sofa', 'wall'), cat('dining-4', 'Table'), q(cat('chair', 'Chair'), 2), cat('wardrobe-100', 'Wardrobe', 'wall'), cat('rug-160', 'Rug')],
    make: [q(cat('desk-160', 'Work desk', 'wall'), Math.min(4, n)), q(cat('office-chair', 'Chair'), Math.min(4, n)), cat('bookshelf', 'Shelf', 'wall'), cat('storage-cabinet', 'Storage', 'wall'), cat('floor-lamp', 'Lamp')],
    bedroom: [cat('bed-single', 'Bed', 'wall'), cat('desk-120', 'Desk', 'window'), cat('desk-chair', 'Desk chair'), cat('wardrobe-100', 'Wardrobe', 'wall'), cat('rug-160', 'Rug')],
    living: [cat('sofa-3', 'Sofa', 'wall'), q(cat('armchair', 'Armchair'), 2), cat('coffee-table', 'Coffee table'), cat('tv-unit', 'Media unit', 'wall'), cat('rug-200', 'Rug'), cat('floor-lamp', 'Lamp')],
  };
  return {
    title, purpose: kind, forWhom: n > 1 ? `${n} people` : 'you', names, palette: Object.values(P), mood: 'calm, practical',
    objects: [...sets[kind], sign, motif ? custom(`${title} poster`, 'poster', cm(50, 3, 70), { style: motif, color: P.b, accent: P.a }, title) : custom('Wall clock', 'clock', cm(35, 5, 35), { color: P.a }, title)],
    realProducts: false, notes: ['Planned from rules as a general room. With Gemini connected, it is planned for this exact idea.'],
  };
}

/** The brief from words alone: themed examples, pets, names, characters mapped to generic looks. */
export function rulesBrief(text: string): ThemeBrief {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const lc = text.toLowerCase();
  const names = findNames(text);
  const fr = FRANCHISE.find(([re]) => re.test(lc));
  const store = /\bikea\b/.test(lc) ? 'IKEA' : (lc.match(/\bfrom ([a-z]+)\b/)?.[1] ?? 'IKEA');
  const real = /real (\w+ )?products|\bikea\b|from (a|the) store|\bbuy\b/.test(lc);
  const n = Number(lc.match(/for (\d+)/)?.[1]) || (/for two|for 2|two (people|players|gamers)/.test(lc) ? 2 : /for three|for 3/.test(lc) ? 3 : 1);
  let b: Omit<ThemeBrief, 'by' | 'ms'>;
  if (/\b(cat|kitten|kitty)\b/.test(lc) && !/hello kitty/.test(lc)) b = petRoom(text, names, false);
  else if (/\b(dog|puppy|doggy)\b/.test(lc)) b = petRoom(text, names, true);
  else if (fr?.[1] === 'pink' || /\bpink\b.*\b(room|bedroom)\b/.test(lc)) b = pinkRoom(names, fr?.[2]);
  else if (/gam(ing|er)/.test(lc)) b = gamingRoom(Math.min(4, n));
  else if (/read|nook|book|librar/.test(lc) && !/board.?game/.test(lc)) b = readingNook();
  else if (/\b(home office|office|study)\b/.test(lc) && !roomKind(lc.replace(/\b(home )?office|study|work\b/g, ''))) b = homeOffice(real, store);
  else if (fr || (!roomKind(lc) && (motifOf(lc) || THEMED.test(lc)))) b = genericRoom(text, names, fr?.[1] ?? motifOf(lc), fr?.[2]);
  else b = generalRoom(text, names, n, motifOf(lc));
  if (real && !b.realProducts) b = { ...b, realProducts: true, objects: b.objects.map((o) => (o.source === 'catalogue' ? { ...o, source: 'store', query: `${store} ${o.name}` } : o)) };
  return { ...b, by: 'rules', ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) };
}

// ---- model brief ------------------------------------------------------------------------------

export const BRIEF_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' }, purpose: { type: 'STRING' }, forWhom: { type: 'STRING' },
    names: { type: 'ARRAY', items: { type: 'STRING' } },
    palette: { type: 'ARRAY', items: { type: 'STRING' }, description: '3 to 5 hex colours.' },
    mood: { type: 'STRING' },
    realProducts: { type: 'BOOLEAN' },
    note: { type: 'STRING', nullable: true, description: 'When a brand or character was named: say the room uses a generic look in that spirit, without characters or logos.' },
    objects: {
      type: 'ARRAY', description: '6 to 14 objects.',
      items: {
        type: 'OBJECT',
        properties: {
          source: { type: 'STRING', enum: ['catalogue', 'custom', 'store'] },
          name: { type: 'STRING' },
          catalogId: { type: 'STRING', nullable: true, description: 'catalogue: the id. custom/store: closest catalogue stand-in id.' },
          recipe: { type: 'STRING', nullable: true, description: `custom only, when one fits: ${RECIPES.join(', ')}.` },
          prompt: { type: 'STRING', nullable: true, description: 'custom: full object description with exact size in cm, exact hex colours, theme details.' },
          query: { type: 'STRING', nullable: true, description: 'store: search phrase for a real product.' },
          sizeCm: { type: 'ARRAY', items: { type: 'NUMBER' }, nullable: true, description: '[width, depth, height] cm.' },
          mount: { type: 'STRING', enum: ['floor', 'wall'] },
          text: { type: 'STRING', nullable: true, description: 'Exact words to print (a name on a poster or sign).' },
          style: { type: 'STRING', nullable: true, description: 'Motif or statue theme: paw, heart, star, crown, bat, flower, moon, controller, book, leaf, cat, dog, hero, princess, abstract.' },
          color: { type: 'STRING', nullable: true }, accent: { type: 'STRING', nullable: true },
          place: { type: 'STRING', enum: ['corner', 'window', 'wall', 'free'], nullable: true },
          qty: { type: 'NUMBER', nullable: true },
        },
        required: ['source', 'name', 'mount'],
        propertyOrdering: ['name', 'source', 'catalogId', 'recipe', 'mount', 'sizeCm', 'qty', 'text', 'style', 'color', 'accent', 'place', 'prompt', 'query'],
      },
    },
  },
  required: ['title', 'purpose', 'forWhom', 'names', 'palette', 'mood', 'realProducts', 'objects'],
  propertyOrdering: ['title', 'purpose', 'forWhom', 'names', 'palette', 'mood', 'realProducts', 'note', 'objects'],
} as const;

const CATALOG_LINE = CATALOG.map((c) => `${c.id} (${c.name}, ${Math.round(c.w * 100)}x${Math.round(c.d * 100)})`).join(', ');

function system(): string {
  return `You plan rooms for any idea a person types: a business, a hobby, a pet, a person, a theme, a period, a culture or an imagined world. Return JSON for the schema.
First decide what the room is for, who uses it (people or animals, and how many), and what would make it unmistakable at a glance.
Then list 6 to 14 objects (qty for repeats, up to 12: "for 10" means 10 seats) that a real room of exactly this kind needs, sized to fit the room given:
- "catalogue" for plain basics the list has (catalogId from the list);
- "custom" for anything the list lacks or that carries the idea (a barber chair, a mixing desk, a longhouse fire pit, a ramen counter): name it plainly, give sizeCm [width, depth, height] and a full prompt that says what it is, its main parts, materials, exact size in cm and hex colours; recipe only when one fits exactly;
- wall decor with mount "wall": poster, sign, neon, banner, clock or wallshelf, with text for any words (names exactly as given; a sign with the room's name fits most rooms).
Seat everyone the idea mentions. Real sizes: chair seat 45 cm, bar stool 75 cm, counter 90 to 110 cm high, desk 74 cm. Keep 80 cm walkways from the door to every seat: floor objects together cover at most a third of the floor, and a tiny room gets few, small pieces. Prefer pieces against walls; seats go with the table, desk or counter they serve.
Pets get their own things (for a cat: cat tree, bed, scratching post, bowls on a mat, toy basket, litter box in a corner, a low window perch). Never use characters, logos or trademarks: map them to a generic look and say so in note.
"store" only when the person asked for real products or a store (query = store + product).
Catalogue ids (cm): ${CATALOG_LINE}.`;
}

const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined);
const CATALOG_IDS = new Set(CATALOG.map((c) => c.id));

/** One model object, cleaned; null when it has no name. */
export function cleanObject(r: unknown, realProducts: boolean): ThemeObject | null {
  if (!r || typeof r !== 'object') return null;
  const x = r as Record<string, unknown>;
  const name = typeof x.name === 'string' ? x.name.trim().slice(0, 60) : '';
  if (!name) return null;
  const recipe = (RECIPES as readonly string[]).includes(x.recipe as string) ? (x.recipe as Recipe) : undefined;
  let source: ThemeObject['source'] = x.source === 'custom' || x.source === 'store' ? x.source : 'catalogue';
  const catalogId = typeof x.catalogId === 'string' && CATALOG_IDS.has(x.catalogId) ? x.catalogId : undefined;
  if (source === 'catalogue' && !catalogId) source = 'custom';
  if (source === 'store' && !realProducts) source = catalogId ? 'catalogue' : 'custom';
  const size = Array.isArray(x.sizeCm) && x.sizeCm.length === 3 && x.sizeCm.every((v) => typeof v === 'number' && v > 0 && v < 800) ? (x.sizeCm as [number, number, number]) : undefined;
  const obj: ThemeObject = {
    source, name, catalogId, recipe, sizeCm: size,
    mount: x.mount === 'wall' || (recipe && WALL_RECIPES.has(recipe)) ? 'wall' : 'floor',
    prompt: typeof x.prompt === 'string' ? x.prompt.slice(0, 400) : undefined,
    query: typeof x.query === 'string' ? x.query.slice(0, 80) : undefined,
    text: typeof x.text === 'string' && x.text.trim() ? x.text.trim().slice(0, 40) : undefined,
    style: typeof x.style === 'string' ? x.style.slice(0, 30) : undefined,
    color: hex(x.color), accent: hex(x.accent),
    place: ['corner', 'window', 'wall', 'free'].includes(x.place as string) ? (x.place as ThemeObject['place']) : undefined,
    qty: typeof x.qty === 'number' && x.qty > 1 ? Math.min(12, Math.round(x.qty)) : undefined,
  };
  // The forge reads the size from the prompt: make sure it is there.
  if (obj.source === 'custom') {
    const base = obj.prompt ?? `${name}${obj.color ? `, colour ${obj.color}` : ''}${obj.text ? `, with the words "${obj.text}" printed on the front` : ''}`;
    obj.prompt = size && !/\d\s*(x|×)\s*\d/.test(base) ? `${base}, ${sz(size)}` : base;
  }
  return obj;
}

/** Clean a model brief; fall back to the rules brief for anything missing. */
export function cleanBrief(raw: unknown, text: string, ms: number, model?: string): ThemeBrief {
  const rules = rulesBrief(text);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const objs: ThemeObject[] = [];
  for (const r of Array.isArray(o.objects) ? o.objects.slice(0, 14) : []) {
    const obj = cleanObject(r, rules.realProducts);
    if (obj) objs.push(obj);
  }
  if (objs.length < 4) return { ...rules, notes: [...rules.notes, 'The model brief was too thin, so the rules brief was used.'] };
  // Names asked for are printed: keep a poster or sign with each name.
  const names = Array.isArray(o.names) ? o.names.filter((n): n is string => typeof n === 'string' && !!n.trim()).slice(0, 3) : rules.names;
  for (const n of rules.names) {
    if (objs.some((x) => x.text && x.text.toLowerCase() === n.toLowerCase())) continue;
    const poster = objs.find((x) => x.recipe === 'poster' && !x.text);
    const add = rules.objects.find((x) => x.text?.toLowerCase() === n.toLowerCase());
    if (poster) poster.text = n.toUpperCase(); else if (add) objs.push(add);
  }
  const palette = (Array.isArray(o.palette) ? o.palette.map(hex).filter((v): v is string => !!v) : []).slice(0, 5);
  const note = typeof o.note === 'string' && o.note.trim() ? [o.note.trim().slice(0, 200)] : [];
  return {
    title: typeof o.title === 'string' && o.title ? o.title.slice(0, 60) : rules.title,
    purpose: typeof o.purpose === 'string' && o.purpose ? o.purpose.slice(0, 40) : rules.purpose,
    forWhom: typeof o.forWhom === 'string' ? o.forWhom.slice(0, 60) : rules.forWhom,
    names: [...new Set([...names, ...rules.names])],
    palette: palette.length >= 2 ? palette : rules.palette,
    mood: typeof o.mood === 'string' ? o.mood.slice(0, 60) : rules.mood,
    objects: objs, realProducts: rules.realProducts || o.realProducts === true,
    notes: [...note, ...rules.notes.filter((n) => !/^Planned from rules/.test(n) && (!note.length || !/generic/.test(n)))],
    by: 'gemini', model, ms,
  };
}

export interface BriefOpts {
  signal?: AbortSignal;
  /** One line about the room ("5.5 x 6.5 m, 36 m2, ceiling 2.5 m, 1 door, 1 window"), so the plan fits it. */
  room?: string;
  /** Each object as soon as it has fully streamed in, before the brief is complete. */
  onObject?: (o: ThemeObject, index: number) => void;
}

/** One fast model call for the brief; the rules brief without a key or when the call fails. */
export async function themeBrief(text: string, opts: BriefOpts | AbortSignal = {}): Promise<ThemeBrief> {
  const o: BriefOpts = typeof AbortSignal !== 'undefined' && opts instanceof AbortSignal ? { signal: opts } : (opts as BriefOpts);
  const signal = o.signal;
  if (!aiReady()) return rulesBrief(text);
  // The brief gates everything after it: past the time limit the rules brief takes over.
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, BRIEF_LIMIT_MS);
  const real = rulesBrief(text).realProducts;
  let emitted = 0;
  const onPartial = o.onObject && ((raw: string) => {
    const list = (partialJson(raw) as { objects?: unknown[] } | undefined)?.objects;
    if (!Array.isArray(list)) return;
    // Every object before the last one in the stream is complete.
    for (; emitted < Math.min(14, list.length - 1); emitted++) {
      const obj = cleanObject(list[emitted], real);
      if (obj) o.onObject!(obj, emitted);
    }
  });
  try {
    const res = await ai<unknown>({
      task: 'fast', system: system(), parts: [{ text: `Room idea: """${text}"""${o.room ? `\nRoom: ${o.room}` : ''}` }],
      schema: BRIEF_SCHEMA, signal: ctrl.signal, temperature: 0.5, budgetMs: 2000, onPartial,
    });
    return cleanBrief(res.data, text, res.ms, res.model);
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('Theme brief fell back to rules:', (e as Error).message);
    const b = rulesBrief(text);
    return { ...b, notes: [...b.notes, 'The model was unavailable, so the brief came from rules.'] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

const BRIEF_LIMIT_MS = 6000;

