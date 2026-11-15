// Furniture kinds: maps the many words people (and stores) use for one thing onto a single
// family, so "couch", "settee" and "sofa" are the same kind and a cat tree is not a shelf.

export type Family = 'desk' | 'sofa' | 'bookshelf' | 'tv-unit' | 'dresser' | 'nightstand' | 'bed' | 'wardrobe' | 'armchair' | 'bench' | 'stool' | 'cat-tree' | 'table';

/** Phrase or word (lower case, singular) to family. Longer phrases win over their parts. */
const WORDS: Record<string, Family> = {
  desk: 'desk', 'standing desk': 'desk', 'sit-stand desk': 'desk', 'sit stand desk': 'desk', 'work desk': 'desk', 'writing desk': 'desk', workstation: 'desk', 'computer desk': 'desk', 'office desk': 'desk',
  sofa: 'sofa', couch: 'sofa', settee: 'sofa', loveseat: 'sofa', 'love seat': 'sofa', 'sofa bed': 'sofa', sectional: 'sofa', 'corner sofa': 'sofa',
  bookshelf: 'bookshelf', bookcase: 'bookshelf', shelf: 'bookshelf', shelves: 'bookshelf', shelving: 'bookshelf', 'shelving unit': 'bookshelf', 'shelving-unit': 'bookshelf', 'book shelf': 'bookshelf', 'display shelf': 'bookshelf', rack: 'bookshelf',
  'tv unit': 'tv-unit', 'tv-unit': 'tv-unit', 'tv bench': 'tv-unit', 'tv-bench': 'tv-unit', 'tv stand': 'tv-unit', 'tv table': 'tv-unit', media: 'tv-unit', 'media unit': 'tv-unit', 'media console': 'tv-unit', sideboard: 'tv-unit',
  dresser: 'dresser', chest: 'dresser', 'chest of drawers': 'dresser', drawers: 'dresser', 'drawer unit': 'dresser', commode: 'dresser', bureau: 'dresser',
  nightstand: 'nightstand', 'night stand': 'nightstand', 'bedside table': 'nightstand', 'bedside-table': 'nightstand', 'night table': 'nightstand', 'bedside': 'nightstand',
  bed: 'bed', 'bed frame': 'bed', 'double bed': 'bed', 'single bed': 'bed', 'bunk bed': 'bed', cot: 'bed',
  wardrobe: 'wardrobe', closet: 'wardrobe', armoire: 'wardrobe', 'clothes cabinet': 'wardrobe', 'clothes rail': 'wardrobe',
  armchair: 'armchair', chair: 'armchair', 'lounge chair': 'armchair', 'accent chair': 'armchair', recliner: 'armchair', 'reading chair': 'armchair', 'office chair': 'armchair',
  bench: 'bench', 'bench seat': 'bench', 'seat bench': 'bench', banquette: 'bench', 'window seat': 'bench', 'storage bench': 'bench', pew: 'bench',
  stool: 'stool', 'bar stool': 'stool', 'counter stool': 'stool', ottoman: 'stool', pouf: 'stool', pouffe: 'stool',
  'cat-tree': 'cat-tree', 'cat tree': 'cat-tree', 'cat tower': 'cat-tree', 'cat condo': 'cat-tree', 'cat scratcher': 'cat-tree', 'cat scratching post': 'cat-tree', 'scratching post': 'cat-tree', 'cat bed': 'cat-tree', 'cat shelf': 'cat-tree', 'cat furniture': 'cat-tree',
  table: 'table', 'dining table': 'table', 'coffee table': 'table', 'side table': 'table', 'cafe table': 'table', 'café table': 'table', 'bistro table': 'table', 'round table': 'table', 'meeting table': 'table', 'counter': 'table',
};
const PHRASES = Object.keys(WORDS).sort((a, b) => b.length - a.length);

/** Families whose members stores file side by side; a desk may stand where a table is wanted and the reverse. */
const SAME: Family[][] = [['desk', 'table']];
export const sameFamily = (a: Family, b: Family) => a === b || SAME.some((g) => g.includes(a) && g.includes(b));

const clean = (t: string) => ` ${t.toLowerCase().replace(/[_/,;:()+]/g, ' ').replace(/\d+(?:[.,]\d+)?\s*(?:cm|mm|m)?\b/g, ' ').replace(/\s+/g, ' ').trim()} `;

/** Family of one word or phrase, or null when unknown. */
export function familyOf(word: string): Family | null {
  const w = word.toLowerCase().trim();
  if (WORDS[w]) return WORDS[w];
  const text = clean(w);
  for (const p of PHRASES) if (text.includes(` ${p} `) || text.includes(` ${p}s `)) return WORDS[p];
  return null;
}

/** The kind of an item: its name decides first ("cat tree" in category "other"), then its category. */
export function normalizeKind(name: string, category = ''): Family | null {
  return familyOf(name) ?? familyOf(category);
}

/** Two words name the same family. Unknown words are accepted only when both are unknown. */
export function sameWords(a: string, b: string): boolean {
  const fa = familyOf(a), fb = familyOf(b);
  if (fa && fb) return sameFamily(fa, fb);
  return !fa && !fb;
}

/** A width in centimetres written in the name ("standing desk 140", "desk 140x70"), when plausible for a piece of furniture. */
export function widthHintCm(name: string): number | null {
  const m = name.match(/(?:^|\s)(\d{2,3})(?:\s*[x×]\s*\d{2,3})?\s*(?:cm)?(?:\s|$)/i);
  const v = m ? Number(m[1]) : NaN;
  return v >= 30 && v <= 400 ? v : null;
}
