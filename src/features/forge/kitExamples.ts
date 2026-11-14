// Few-shot examples written the way the model should write: a handful of kit items and plain parts.
// They teach the vocabulary (kits, styles, mirror, accent) with few tokens, and every one of them is
// expanded and checked by the tests, so the examples themselves always build clean objects.
// Metres; origin at the floor centre; front faces +z; pos is the centre of each box.

export interface KitExample { prompt: string; json: Record<string, unknown> }

type Item = Record<string, unknown>;
const I = (name: string, size: number[], pos: number[], material: string, extra: Item = {}): Item => ({ name, ...extra, size, pos, material });

export const KIT_EXAMPLES: KitExample[] = [
  {
    prompt: 'walnut desk 160x80 with a drawer pedestal on the right and black steel legs',
    json: {
      name: 'Walnut desk with drawer pedestal', size: { w: 1.6, d: 0.8, h: 0.75 },
      parts: [
        I('Desktop', [1.6, 0.03, 0.8], [0, 0.735, 0], 'walnut', { shape: 'rounded', radius: 0.006 }),
        I('Left leg', [0.05, 0.72, 0.05], [-0.765, 0.36, 0.35], 'black-metal', { shape: 'box', mirror: 'z' }),
        I('Left foot rail', [0.05, 0.03, 0.75], [-0.765, 0.015, 0], 'black-metal', { shape: 'box' }),
        I('Modesty panel', [1.08, 0.3, 0.018], [-0.2, 0.57, -0.33], 'walnut', { shape: 'panel' }),
        I('Pedestal', [0.44, 0.72, 0.74], [0.56, 0.36, 0], 'walnut', { kit: 'carcass', style: 'plinth' }),
        I('Drawer', [0.404, 0.63, 0.72], [0.56, 0.405, 0.01], 'walnut', { kit: 'drawers', count: 3, style: 'bar brass' }),
      ],
      semantics: { category: 'desk', role: 'surface', wallBacked: true, frontClearanceM: 0.9, sideClearanceM: 0.1, pairsWith: ['office-chair'], faces: 'window', description: 'A walnut desk on black steel legs with a three-drawer pedestal on the right.' },
    },
  },
  {
    prompt: 'pink princess canopy bed 90x200 with an arched headboard',
    json: {
      name: 'Pink princess canopy bed', size: { w: 1.06, d: 2.12, h: 2.0 },
      parts: [
        I('Feet', [1.0, 0.08, 1.96], [0, 0.04, 0], 'brass', { kit: 'legs', style: 'bun' }),
        I('Bed frame', [1.0, 0.26, 2.0], [0, 0.21, 0], 'plastic', { shape: 'rounded', radius: 0.05, color: '#ffffff' }),
        I('Bedding', [0.92, 0.3, 1.94], [0, 0.49, 0.02], 'linen', { kit: 'bedding', count: 1, style: 'heart', color: '#f4a6c6', accent: '#e0218a' }),
        I('Headboard', [1.0, 1.1, 0.06], [0, 0.8, -1.03], 'velvet', { kit: 'headboard', style: 'scallop', color: '#f4a6c6' }),
        I('Canopy', [1.06, 2.0, 2.12], [0, 1.0, 0], 'white-laminate', { kit: 'canopy', style: 'princess', color: '#ffffff', accent: '#ffd1e3' }),
        I('Footboard', [1.0, 0.5, 0.05], [0, 0.34, 1.025], 'plastic', { shape: 'extrude', style: 'arch', color: '#ffffff' }),
      ],
      semantics: { category: 'bed', role: 'sleeping', wallBacked: true, frontClearanceM: 0.7, sideClearanceM: 0.4, pairsWith: ['nightstand'], faces: 'room', description: 'A playful pink single canopy bed with a scalloped headboard, drapes and a heart cushion.' },
    },
  },
  {
    prompt: 'built-in double wall bed that folds down from an oak cabinet',
    json: {
      name: 'Fold-down wall bed', size: { w: 1.7, d: 0.45, h: 2.2 },
      parts: [I('Wall bed', [1.7, 2.2, 0.45], [0, 1.1, 0], 'oak', { kit: 'wallbed', accent: '#f4f2ee', style: 'black' })],
      semantics: { category: 'bed', role: 'sleeping', wallBacked: true, frontClearanceM: 2.1, sideClearanceM: 0.1, pairsWith: [], faces: 'room', description: 'A built-in double wall bed: an oak front folds down from a white cabinet into a made bed.' },
    },
  },
  {
    prompt: 'three-seat sofa in sage fabric with walnut legs',
    json: {
      name: 'Three-seat sofa', size: { w: 2.2, d: 0.92, h: 0.82 },
      parts: [
        I('Legs', [2.1, 0.12, 0.82], [0, 0.06, 0], 'walnut', { kit: 'legs', count: 6, style: 'tapered' }),
        I('Base', [2.2, 0.26, 0.92], [0, 0.25, 0], 'fabric', { shape: 'rounded', radius: 0.04, color: '#6f7f73' }),
        I('Back', [2.2, 0.44, 0.2], [0, 0.6, -0.36], 'fabric', { shape: 'rounded', radius: 0.05, color: '#6f7f73' }),
        I('Left arm', [0.2, 0.26, 0.72], [-1.0, 0.51, 0.1], 'fabric', { shape: 'rounded', radius: 0.06, color: '#6f7f73', mirror: 'x' }),
        I('Seat cushion', [1.8, 0.16, 0.62], [0, 0.46, 0.14], 'fabric', { kit: 'cushions', count: 3, color: '#6f7f73' }),
        I('Back cushion', [1.8, 0.38, 0.2], [0, 0.64, -0.17], 'fabric', { kit: 'cushions', count: 3, style: 'back', color: '#6f7f73' }),
        I('Throw pillow', [1.5, 0.38, 0.14], [0, 0.73, -0.02], 'linen', { kit: 'cushions', count: 2, style: 'pillows', color: '#c9a227', accent: '#e8e1d3' }),
      ],
      semantics: { category: 'sofa', role: 'seating', wallBacked: true, frontClearanceM: 0.8, sideClearanceM: 0.1, pairsWith: ['coffee-table'], faces: 'screen', description: 'A three-seat sofa in sage green fabric with loose cushions on walnut legs.' },
    },
  },
  {
    prompt: 'curved velvet banquette bench 220 wide in rust',
    json: {
      name: 'Curved velvet banquette', size: { w: 2.2, d: 1.0, h: 0.85 },
      parts: [
        I('Plinth', [2.2, 0.08, 0.35], [0, 0.04, 0], 'walnut', { kit: 'arc', radius: 0.5, inset: 0.05 }),
        I('Seat base', [2.2, 0.3, 0.35], [0, 0.23, 0], 'velvet', { kit: 'arc', radius: 0.62, color: '#a8482a' }),
        I('Back', [2.2, 0.47, 0.35], [0, 0.615, 0], 'velvet', { kit: 'arc', radius: 0.16, color: '#a8482a' }),
        I('Seat cushion', [2.2, 0.1, 0.35], [0, 0.43, 0], 'velvet', { kit: 'arc', radius: 0.44, inset: 0.16, count: 3, color: '#a8482a' }),
      ],
      semantics: { category: 'bench', role: 'seating', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0.1, pairsWith: ['table'], faces: 'table', description: 'A curved banquette in rust velvet on a walnut plinth.' },
    },
  },
  {
    prompt: 'round oak dining table 120 on a pedestal',
    json: {
      name: 'Round pedestal dining table', size: { w: 1.2, d: 1.2, h: 0.75 },
      parts: [
        I('Tabletop', [1.2, 0.035, 1.2], [0, 0.7325, 0], 'oak', { shape: 'cylinder' }),
        I('Apron ring', [0.7, 0.06, 0.7], [0, 0.685, 0], 'oak', { shape: 'cylinder' }),
        I('Pedestal', [0.62, 0.655, 0.62], [0, 0.3275, 0], 'oak', { kit: 'pedestal', style: 'cross turned' }),
      ],
      semantics: { category: 'table', role: 'surface', wallBacked: false, frontClearanceM: 0.8, sideClearanceM: 0.8, pairsWith: ['chair'], faces: 'none', description: 'A round oak dining table for four on a turned pedestal.' },
    },
  },
  {
    prompt: 'grey mesh office chair with arms',
    json: {
      name: 'Office chair', size: { w: 0.66, d: 0.66, h: 1.1 },
      parts: [
        I('Base', [0.66, 0.46, 0.66], [0, 0.23, 0], 'black-metal', { kit: 'casters' }),
        I('Seat', [0.5, 0.09, 0.48], [0, 0.505, 0.03], 'fabric', { shape: 'cushion', color: '#5a5f66' }),
        I('Seat shell', [0.48, 0.03, 0.44], [0, 0.46, 0.03], 'plastic', { shape: 'rounded', color: '#222222' }),
        I('Back support', [0.06, 0.32, 0.03], [0, 0.6, -0.22], 'plastic', { shape: 'box', color: '#222222' }),
        I('Backrest', [0.46, 0.55, 0.06], [0, 0.82, -0.24], 'fabric', { shape: 'cushion', color: '#5a5f66', rot: [-0.12, 0, 0] }),
        I('Arm post', [0.04, 0.2, 0.05], [-0.27, 0.6, 0], 'plastic', { shape: 'box', color: '#222222', mirror: 'x' }),
        I('Arm pad', [0.08, 0.035, 0.24], [-0.27, 0.715, 0.02], 'plastic', { shape: 'rounded', radius: 0.015, color: '#222222', mirror: 'x' }),
      ],
      semantics: { category: 'office-chair', role: 'seating', wallBacked: false, frontClearanceM: 0.6, sideClearanceM: 0.1, pairsWith: ['desk'], faces: 'table', description: 'A grey office chair with arms on a five-star castor base.' },
    },
  },
  {
    prompt: 'tall birch bookcase 90 wide with books',
    json: {
      name: 'Birch bookcase', size: { w: 0.9, d: 0.32, h: 1.9 },
      parts: [I('Bookcase', [0.9, 1.9, 0.32], [0, 0.95, 0], 'birch', { kit: 'bookcase', count: 4, style: 'books decor' })],
      semantics: { category: 'bookshelf', role: 'storage', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0.05, pairsWith: [], faces: 'room', description: 'A tall birch bookcase with five shelves of books.' },
    },
  },
  {
    prompt: 'white sideboard 160 with fluted doors and oak legs',
    json: {
      name: 'Fluted sideboard', size: { w: 1.6, d: 0.45, h: 0.78 },
      parts: [
        I('Legs', [1.5, 0.16, 0.38], [0, 0.08, 0], 'oak', { kit: 'legs', style: 'splayed' }),
        I('Body', [1.6, 0.62, 0.45], [0, 0.47, 0], 'white-laminate', { kit: 'carcass', style: 'legs', count: 2 }),
        I('Door', [1.564, 0.584, 0.02], [0, 0.47, 0.215], 'white-laminate', { kit: 'doors', count: 3, style: 'fluted push' }),
        I('Top', [1.62, 0.02, 0.46], [0, 0.79, 0], 'oak', { shape: 'panel' }),
      ],
      semantics: { category: 'cabinet', role: 'storage', wallBacked: true, frontClearanceM: 0.7, sideClearanceM: 0.05, pairsWith: [], faces: 'room', description: 'A white sideboard with fluted doors, an oak top and splayed oak legs.' },
    },
  },
  {
    prompt: 'black upright piano with a stool',
    json: {
      name: 'Upright piano', size: { w: 1.5, d: 0.62, h: 1.25 },
      parts: [
        I('Case', [1.5, 1.25, 0.4], [0, 0.625, -0.11], 'plastic', { shape: 'rounded', radius: 0.01, color: '#111111' }),
        I('Key bed', [1.4, 0.08, 0.26], [0, 0.71, 0.18], 'plastic', { shape: 'box', color: '#111111' }),
        I('Keys', [1.24, 0.035, 0.15], [0, 0.7675, 0.22], 'plastic', { kit: 'keyboard', color: '#111111' }),
        I('Cheek', [0.08, 0.14, 0.27], [-0.66, 0.74, 0.18], 'plastic', { shape: 'rounded', radius: 0.02, color: '#111111', mirror: 'x' }),
        I('Toe block', [0.08, 0.67, 0.08], [-0.66, 0.335, 0.27], 'plastic', { shape: 'box', color: '#111111', mirror: 'x' }),
        I('Fallboard', [1.24, 0.12, 0.02], [0, 0.86, 0.09], 'plastic', { shape: 'panel', color: '#111111' }),
        I('Music desk', [0.7, 0.24, 0.02], [0, 1.02, 0.09], 'plastic', { shape: 'panel', color: '#111111', rot: [-0.15, 0, 0] }),
        I('Pedal', [0.04, 0.02, 0.1], [-0.07, 0.08, 0.14], 'brass', { shape: 'box', count: 3, step: [0.07, 0, 0] }),
      ],
      semantics: { category: 'piano', role: 'decor', wallBacked: true, frontClearanceM: 0.9, sideClearanceM: 0.1, pairsWith: ['stool'], faces: 'room', description: 'A gloss black upright piano.' },
    },
  },
  {
    prompt: 'pine loft bed with a ladder and a desk underneath',
    json: {
      name: 'Loft bed with desk', size: { w: 1.0, d: 2.0, h: 1.8 },
      parts: [
        I('Corner post', [0.07, 1.8, 0.07], [-0.465, 0.9, -0.965], 'pine', { shape: 'box', mirror: 'xz' }),
        I('Deck frame', [1.0, 0.12, 2.0], [0, 1.24, 0], 'pine', { kit: 'frame', radius: 0.035 }),
        I('Bedding', [0.9, 0.28, 1.9], [0, 1.44, 0], 'linen', { kit: 'bedding', count: 1, color: '#4a6a8f' }),
        I('Guard rail', [0.04, 0.06, 1.86], [-0.465, 1.7, 0], 'pine', { shape: 'box', mirror: 'x' }),
        I('Ladder', [0.42, 1.6, 0.04], [0.22, 0.8, 1.02], 'pine', { kit: 'ladder', count: 5 }),
        I('Desk top', [0.86, 0.03, 1.2], [0, 0.735, -0.3], 'pine', { shape: 'panel' }),
      ],
      semantics: { category: 'bunk-bed', role: 'sleeping', wallBacked: true, frontClearanceM: 0.7, sideClearanceM: 0.3, pairsWith: ['chair'], faces: 'room', description: 'A pine loft bed with a ladder and a desk underneath.' },
    },
  },
  {
    prompt: 'retro jukebox with an arched top and glowing panels',
    json: {
      name: 'Retro jukebox', size: { w: 0.8, d: 0.6, h: 1.5 },
      parts: [
        I('Plinth', [0.8, 0.08, 0.6], [0, 0.04, 0], 'black-laminate', { shape: 'box' }),
        I('Body', [0.8, 1.42, 0.55], [0, 0.79, -0.025], 'walnut', { shape: 'extrude', style: 'arch' }),
        I('Front glow', [0.62, 1.2, 0.02], [0, 0.72, 0.26], 'plastic', { shape: 'extrude', style: 'arch', color: '#f2a640' }),
        I('Window', [0.44, 0.3, 0.02], [0, 1.12, 0.275], 'glass', { kit: 'screen', accent: '#e8742a' }),
        I('Speaker grille', [0.4, 0.3, 0.015], [0, 0.42, 0.275], 'steel', { shape: 'panel' }),
        I('Side light', [0.03, 1.1, 0.03], [-0.33, 0.7, 0.27], 'plastic', { shape: 'tube', color: '#ff4f7a', mirror: 'x' }),
      ],
      semantics: { category: 'jukebox', role: 'decor', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0.05, pairsWith: [], faces: 'room', description: 'A retro jukebox with an arched walnut case and glowing amber panels.' },
    },
  },
];
