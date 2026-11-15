// Offline room worlds: a kit per kind of room (cat room, ramen bar, dentist waiting room ...) and
// style layers (wizard, space, 1970s ...) that combine with any kit. A kit is plain data: floor
// pieces with real sizes, wall decor with printed words, a five colour palette, one hero piece and
// a lighting mood. Pure functions place and colour it: the hero hangs on the wall facing the door,
// decor sits at eye height clear of doors and windows, colour follows 60/30/10. Generic figures and
// motifs only. A matcher reads English, Swedish and Finnish.
import { catalogEntry } from '../furniture/catalog';
import type { Recipe, ThemeBrief, ThemeObject } from './brief';

type V3 = [number, number, number];
export type Light = 'warm' | 'cool' | 'neon';

interface Floor { id: string; name: string; size?: V3; desc?: string; place?: ThemeObject['place']; qty?: number; scale?: boolean; seat?: boolean; recipe?: Recipe }
interface Deco { name: string; recipe: Recipe; size: V3; text?: string; style?: string; pair?: boolean }
export interface Kit {
  id: string; re: RegExp; purpose: string; forWhom: string;
  /** dominant 60, secondary 30, accent 10, light decor, dark. */
  palette: [string, string, string, string, string];
  mood: string; light: Light;
  floor: Floor[]; hero: Deco; decor: Deco[];
  /** Mirror the pair decor on both sides of the hero. */
  pairs?: boolean;
}
export interface StyleLayer { id: string; re: RegExp; palette?: Kit['palette']; motif: string; word: string; mood: string; light?: Light; room: string }

const w = (s: string) => new RegExp(`(?<![a-zåäö])(${s})`, 'i');
const wb = (s: string) => new RegExp(`(?<![a-zåäö])(${s})(?![a-zåäö])`, 'i');
const F = (id: string, name: string, o: Partial<Floor> = {}): Floor => ({ id, name, ...o });
const C = (name: string, id: string, size: V3, desc: string, o: Partial<Floor> = {}): Floor => ({ id, name, size, desc, ...o });
const D = (name: string, recipe: Recipe, size: V3, o: Partial<Deco> = {}): Deco => ({ name, recipe, size, ...o });
const poster = (text: string, style?: string, name = `${text.toLowerCase()} poster`): Deco => D(name, 'poster', [50, 3, 70], { text, style });
const neon = (text: string, style?: string): Deco => D(`${text.toLowerCase()} neon`, 'neon', [70, 4, 30], { text, style });
const sign = (text: string, style?: string): Deco => D(`${text.toLowerCase()} sign`, 'sign', [70, 2.5, 22], { text, style });
const shelf = (name = 'Wall shelf'): Deco => D(name, 'wallshelf', [80, 22, 30]);
const rug = F('rug-160', 'Rug');

export const KITS: Kit[] = [
  { id: 'cat', re: w('kitten|kitty|cats?(?![a-zåäö])|katt|kisse|kissa|kissan'), purpose: 'cat room', forWhom: 'a cat', palette: ['#e9d8bf', '#c46b4b', '#f6efe4', '#c79a63', '#5a4636'], mood: 'warm, playful, safe', light: 'warm', pairs: true,
    floor: [C('Cat tree', 'plant', [60, 60, 150], 'cat tree with sisal posts, three carpeted platforms and a round bed on top', { recipe: 'cat-tree' }), C('Cat bed', 'plant', [55, 45, 20], 'round cat bed', { recipe: 'pet-bed', place: 'wall' }), C('Scratching post', 'plant', [40, 40, 80], 'sisal scratching post', { recipe: 'scratching-post' }), C('Bowls on a mat', 'plant', [50, 30, 8], 'food and water bowls on a mat', { recipe: 'pet-bowls', place: 'wall' }), C('Toy basket', 'plant', [40, 30, 28], 'woven toy basket', { recipe: 'toy-basket' }), C('Litter box', 'plant', [55, 45, 42], 'hooded litter box', { recipe: 'litter-box', place: 'corner' }), C('Window perch', 'plant', [60, 35, 50], 'low cushioned window perch', { recipe: 'window-perch', place: 'window' }), F('armchair', 'Armchair for you'), rug],
    hero: poster('MEOW', 'paw', 'cat poster'), decor: [poster('PURR', 'paw', 'side poster'), shelf()] },
  { id: 'dog', re: w('dogs?(?![a-zåäö])|puppy|puppies|hund|koira|koiran|pentu'), purpose: 'dog room', forWhom: 'a dog', palette: ['#c9a67a', '#4f6d5b', '#e8c872', '#f4ecdf', '#3d3126'], mood: 'warm, sturdy, friendly', light: 'warm', pairs: true,
    floor: [C('Dog bed', 'plant', [90, 70, 25], 'big cushioned dog bed', { recipe: 'pet-bed', place: 'wall' }), C('Bowls on a mat', 'plant', [60, 35, 12], 'raised food and water bowls on a mat', { recipe: 'pet-bowls', place: 'wall' }), C('Toy basket', 'plant', [50, 35, 30], 'woven toy basket', { recipe: 'toy-basket' }), C('Window bench', 'plant', [90, 35, 45], 'low cushioned window bench', { recipe: 'window-perch', place: 'window' }), F('bench', 'Lead bench', { place: 'wall' }), F('armchair', 'Armchair for you'), rug],
    hero: poster('GOOD DOG', 'paw', 'dog poster'), decor: [poster('WALKIES', 'paw', 'side poster'), shelf('Lead shelf')] },
  { id: 'nursery', re: w('nurser|baby|babies|newborn|toddler|barnkammar|bebis|spädbarn|vauva|vauvan'), purpose: 'nursery', forWhom: 'a baby', palette: ['#f3ead8', '#b8d4c8', '#f2c9a0', '#fffaf0', '#6b7a8a'], mood: 'soft, quiet, safe', light: 'warm', pairs: true,
    floor: [F('crib', 'Crib', { place: 'wall', scale: true }), F('dresser', 'Changing dresser', { place: 'wall' }), F('armchair', 'Nursing chair'), F('toy-storage', 'Toy storage', { place: 'wall' }), F('floor-lamp', 'Soft lamp'), rug],
    hero: poster('SWEET DREAMS', 'moon', 'dream poster'), decor: [poster('HELLO', 'star', 'side poster'), D('Cloud banner', 'banner', [90, 2, 50], { text: 'LITTLE ONE' }), shelf('Book shelf')] },
  { id: 'kids', re: w('kids?(?![a-zåäö])|child|children|barnrum|barn(?![a-zåäö])|lapsi|lapsen|lasten|lapsille|playroom|lekrum|leikki'), purpose: 'kids room', forWhom: 'a child', palette: ['#4f86c6', '#f2c94c', '#e85d5d', '#fff7e6', '#3a4660'], mood: 'bright, playful', light: 'warm', pairs: true,
    floor: [F('bed-single', 'Bed', { place: 'wall', scale: true }), F('desk-120', 'Desk', { place: 'window', scale: true }), F('desk-chair', 'Desk chair', { scale: true }), F('wardrobe-100', 'Wardrobe', { place: 'wall' }), F('toy-storage', 'Toy storage', { place: 'wall' }), F('play-table', 'Play table'), rug],
    hero: poster('MY ROOM', 'star', 'room poster'), decor: [poster('DREAM BIG', 'moon', 'side poster'), shelf('Book shelf'), D('Height banner', 'banner', [90, 2, 50], { text: 'GROWING UP' })] },
  { id: 'teen', re: w('teen|tonår|nuori|nuoren|nuorten'), purpose: 'teen room', forWhom: 'a teenager', palette: ['#2f3a4f', '#8a6fdf', '#2ee6c8', '#e9e6f2', '#14171f'], mood: 'cool, personal, chilled', light: 'neon', pairs: true,
    floor: [F('bed-single', 'Bed', { place: 'wall' }), F('desk-140', 'Desk', { place: 'window' }), F('office-chair', 'Desk chair'), F('wardrobe-100', 'Wardrobe', { place: 'wall' }), F('bookshelf-low', 'Low shelf', { place: 'wall' }), F('armchair', 'Bean chair'), rug],
    hero: neon('CHILL', 'moon'), decor: [poster('VIBES', 'star', 'left poster'), poster('LOUD', 'star', 'right poster'), shelf('Display shelf')] },
  { id: 'gaming', re: w('gam(ing|er|ers)|spelrum|spelrummet|pelihuone|pelaaja|esport'), purpose: 'gaming', forWhom: 'a gamer', palette: ['#1b1d24', '#2e6bff', '#26e0ff', '#22252e', '#8a3ffc'], mood: 'dark, focused, glowing', light: 'neon', pairs: true,
    floor: [C('Gaming desk', 'desk-140', [140, 70, 75], 'black gaming desk with a monitor shelf and a light strip', { place: 'wall', scale: true }), C('Gaming chair', 'office-chair', [70, 70, 130], 'gaming chair with a racing back', { scale: true }), F('sofa-2', 'Sofa for guests', { place: 'wall' }), F('bookshelf-low', 'Game shelf', { place: 'wall' }), rug],
    hero: neon('GAME ON', 'controller'), decor: [poster('PLAYER 1', 'controller', 'left poster'), poster('PLAYER 2', 'controller', 'right poster'), shelf('Game shelf')] },
  { id: 'office', re: w('home office|hemmakontor|kotitoimisto|työhuone|tyohuone|arbetsrum|study(?![a-zåäö])|office|kontor|toimisto'), purpose: 'work', forWhom: 'remote work', palette: ['#f2efe9', '#d8c7a8', '#4b8a6b', '#fffdf8', '#2f3a44'], mood: 'clean, focused', light: 'cool',
    floor: [F('desk-140', 'Desk', { place: 'window', scale: true }), F('office-chair', 'Office chair', { scale: true }), F('bookshelf', 'Bookcase', { place: 'wall' }), F('filing-cabinet', 'Filing cabinet', { place: 'wall' }), F('floor-lamp', 'Floor lamp'), F('plant', 'Plant', { place: 'corner' })],
    hero: poster('FOCUS', 'leaf', 'focus poster'), decor: [D('Wall clock', 'clock', [35, 5, 35]), shelf()] },
  { id: 'podcast', re: w('podcast|podd(?![a-zåäö])|radio studio|broadcast|podcasting'), purpose: 'podcast studio', forWhom: 'a host and guests', palette: ['#2b2f3a', '#c8503c', '#ff3b30', '#e8e2d6', '#14161c'], mood: 'dark, intimate, acoustic', light: 'neon', pairs: true,
    floor: [C('Podcast table', 'dining-4', [160, 80, 74], 'round-cornered podcast table with arm-mounted microphones', { place: 'wall' }), F('chair', 'Studio chair', { qty: 2, seat: true }), F('sofa-2', 'Guest sofa', { place: 'wall' }), F('storage-cabinet', 'Gear cabinet', { place: 'wall' }), C('Acoustic screen', 'room-divider', [120, 8, 170], 'free-standing foam acoustic screen'), rug],
    hero: neon('ON AIR', 'abstract'), decor: [D('Acoustic panel left', 'poster', [60, 5, 120], { text: 'REC', pair: true }), shelf('Record shelf')] },
  { id: 'music', re: w('music studio|musikstudio|musikrum|recording|inspelning|musiikki|äänitys|rehearsal|replokka|band practice|studio for music'), purpose: 'music studio', forWhom: 'a musician', palette: ['#3b2f2f', '#b8863b', '#e8453c', '#efe3cf', '#16130f'], mood: 'warm, dim, creative', light: 'warm', pairs: true,
    floor: [C('Mixing desk', 'desk-160', [160, 80, 95], 'mixing desk with two monitors and a keyboard tray', { place: 'wall' }), F('office-chair', 'Studio chair'), C('Upright piano', 'sideboard', [150, 60, 120], 'upright piano with lid', { place: 'wall' }), C('Guitar stand', 'plant', [40, 40, 100], 'guitar stand with a guitar'), F('sofa-2', 'Listening sofa', { place: 'wall' }), rug],
    hero: neon('PLAY LOUD', 'abstract'), decor: [poster('VINYL', 'star', 'left poster'), poster('ENCORE', 'star', 'right poster'), shelf('Record shelf')] },
  { id: 'art', re: w('art studio|painting|painter|atelier|ateljé|konstnär|taidestudio|maalaus|craft|sewing|pottery|workshop|verkstad'), purpose: 'art studio', forWhom: 'a maker', palette: ['#f1ece2', '#4a7fb5', '#e8a33d', '#fffdf6', '#3a3a3a'], mood: 'bright, airy, creative', light: 'cool', pairs: true,
    floor: [C('Easel', 'plant', [60, 60, 170], 'wooden studio easel with a blank canvas'), F('desk-160', 'Big worktable', { place: 'wall' }), F('chair', 'Stool', { qty: 2 }), F('storage-cabinet', 'Supply cabinet', { place: 'wall' }), F('display-shelf', 'Drying shelf', { place: 'wall' }), F('floor-lamp', 'Task lamp')],
    hero: poster('MAKE ART', 'flower', 'canvas poster'), decor: [poster('COLOUR', 'star', 'left poster'), poster('LINE', 'star', 'right poster'), shelf('Paint shelf')] },
  { id: 'nook', re: w('reading|nook|bookworm|läshörna|läs|lukunurkka|lukuhuone|lukea'), purpose: 'reading', forWhom: 'a reader', palette: ['#8aa38b', '#efe6d6', '#c98b6b', '#f7f1e4', '#3e5f46'], mood: 'calm, soft, quiet', light: 'warm',
    floor: [C('Reading armchair', 'armchair', [85, 85, 95], 'deep wingback reading armchair with a footstool', { place: 'window' }), F('floor-lamp', 'Floor lamp'), F('bookshelf', 'Bookshelf', { place: 'wall' }), F('plant', 'Floor plant', { place: 'corner' }), rug],
    hero: poster('READ', 'leaf', 'read poster'), decor: [D('Wall clock', 'clock', [35, 5, 35]), shelf('Book shelf')] },
  { id: 'library', re: w('library|libraries|bibliotek|kirjasto'), purpose: 'library', forWhom: 'readers', palette: ['#5a3d2b', '#c9a36a', '#2f5d50', '#f0e4cc', '#1d1510'], mood: 'warm, hushed, studious', light: 'warm', pairs: true,
    floor: [F('bookshelf', 'Bookcase', { qty: 3, place: 'wall' }), F('dining-4', 'Reading table'), F('chair', 'Reading chair', { qty: 4, seat: true }), F('armchair', 'Armchair'), F('floor-lamp', 'Reading lamp'), rug],
    hero: sign('LIBRARY', 'book'), decor: [poster('SHHH', 'book', 'left poster'), poster('OPEN BOOKS', 'book', 'right poster'), D('Wall clock', 'clock', [35, 5, 35])] },
  { id: 'gym', re: w('home gym|gym(?![a-zåäö])|workout|fitness|crossfit|kuntosali|träningsrum|training room'), purpose: 'home gym', forWhom: 'training', palette: ['#2d3138', '#e8532b', '#f2c94c', '#e9ecef', '#101215'], mood: 'cool, bright, energetic', light: 'cool', pairs: true,
    floor: [C('Weight bench', 'bench', [130, 50, 45], 'padded weight bench'), C('Dumbbell rack', 'display-shelf', [120, 40, 90], 'two-tier dumbbell rack with dumbbells', { place: 'wall' }), C('Squat rack', 'storage-cabinet', [130, 130, 215], 'steel squat rack with a bar'), C('Exercise mat', 'rug-160', [200, 100, 2], 'black rubber exercise mat'), F('storage-cabinet', 'Towel cabinet', { place: 'wall' }), F('plant', 'Plant', { place: 'corner' })],
    hero: neon('NO EXCUSES', 'abstract'), decor: [poster('LIFT', 'star', 'left poster'), poster('SWEAT', 'star', 'right poster'), D('Wall clock', 'clock', [35, 5, 35])] },
  { id: 'yoga', re: w('yoga|pilates|meditat|joga|mindfulness|stretch'), purpose: 'yoga room', forWhom: 'practice', palette: ['#e9dfd0', '#8aa38b', '#d9a066', '#fbf6ec', '#4a4036'], mood: 'calm, warm, still', light: 'warm', pairs: true,
    floor: [C('Yoga mats', 'rug-160', [180, 70, 2], 'rolled-out yoga mat', { qty: 2 }), F('bench', 'Bench', { place: 'wall' }), F('storage-cabinet', 'Prop cabinet', { place: 'wall' }), F('plant', 'Plant', { qty: 2, place: 'corner' }), F('floor-lamp', 'Soft lamp')],
    hero: poster('BREATHE', 'flower', 'breathe poster'), decor: [poster('STILL', 'leaf', 'left poster'), poster('FLOW', 'leaf', 'right poster'), shelf('Candle shelf')] },
  { id: 'cinema', re: w('cinema|movie|home theat|biorum|bio(?![a-zåäö])|elokuva|leffa|kotiteatteri|screening'), purpose: 'home cinema', forWhom: 'film nights', palette: ['#3a1f2b', '#8b2f3f', '#e8b04b', '#efe0c4', '#120a0e'], mood: 'dark, velvet, cinematic', light: 'neon', pairs: true,
    floor: [F('sofa-3', 'Big sofa', { place: 'wall' }), F('armchair', 'Armchair', { qty: 2, seat: true }), F('tv-unit', 'Screen unit', { place: 'wall' }), F('coffee-table', 'Snack table'), C('Popcorn cart', 'plant', [60, 45, 150], 'red popcorn cart on wheels'), rug],
    hero: neon('NOW SHOWING', 'star'), decor: [poster('PREMIERE', 'star', 'left poster'), poster('ENCORE', 'star', 'right poster'), shelf('Film shelf')] },
  { id: 'ramen', re: w('ramen|noodle|sushi|izakaya|nuudeli|nudel'), purpose: 'ramen bar', forWhom: 'diners', palette: ['#2a2220', '#c8402c', '#f2b84b', '#efe3cc', '#120d0c'], mood: 'warm, steamy, lively', light: 'warm', pairs: true,
    floor: [C('Ramen counter', 'counter', [300, 70, 100], 'wooden ramen counter with a steel pass', { place: 'wall' }), F('bar-stool', 'Counter stool', { qty: 6, seat: true }), C('Noodle station', 'kitchen-island', [140, 70, 90], 'noodle station with stock pots'), F('display-shelf', 'Bowl shelf', { place: 'wall' }), F('plant', 'Plant', { place: 'corner' })],
    hero: D('Ramen banner', 'banner', [90, 2, 50], { text: 'RAMEN' }), decor: [neon('OPEN', 'abstract'), poster('NOODLES', 'flower', 'menu poster'), shelf('Sauce shelf')] },
  { id: 'coffee', re: w('coffee|caf[eé]|kaffe|kahvila|kahvi|espresso|tea ?room|bistro'), purpose: 'coffee shop', forWhom: 'guests', palette: ['#6b4a35', '#e8d9c0', '#d98b3a', '#faf3e6', '#2b1d14'], mood: 'warm, cosy, aromatic', light: 'warm', pairs: true,
    floor: [C('Espresso counter', 'counter', [220, 65, 100], 'wooden counter with an espresso machine', { place: 'wall' }), F('cafe-2', 'Cafe table', { qty: 3 }), F('chair', 'Cafe chair', { qty: 5, seat: true }), F('display-shelf', 'Cake shelf', { place: 'wall' }), F('plant', 'Plant', { place: 'corner' })],
    hero: D('Menu banner', 'banner', [90, 2, 50], { text: 'COFFEE' }), decor: [poster('LATTE', 'leaf', 'left poster'), poster('BEANS', 'leaf', 'right poster'), neon('OPEN', 'abstract')] },
  { id: 'cocktail', re: wb('cocktails?|bar|pub|krog|baari|tavern|lounge bar|drink bar'), purpose: 'cocktail bar', forWhom: 'guests', palette: ['#1f2433', '#7a2f5c', '#f5b83d', '#e8dfd0', '#0c0e15'], mood: 'dark, glossy, moody', light: 'neon', pairs: true,
    floor: [C('Bar counter', 'counter', [280, 65, 110], 'dark bar counter with a brass foot rail', { place: 'wall' }), F('bar-stool', 'Bar stool', { qty: 6, seat: true }), F('cafe-2', 'High table'), F('display-shelf', 'Bottle shelf', { place: 'wall' }), F('plant', 'Plant', { place: 'corner' })],
    hero: neon('COCKTAILS', 'star'), decor: [poster('SHAKEN', 'star', 'left poster'), poster('STIRRED', 'star', 'right poster'), shelf('Bottle shelf')] },
  { id: 'bakery', re: w('bakery|bakeri|konditori|leipomo|pastry|bread|patisserie'), purpose: 'bakery', forWhom: 'customers', palette: ['#f1dcb8', '#c98d4f', '#e2576f', '#fff8ea', '#5a3a22'], mood: 'warm, sweet, fresh', light: 'warm', pairs: true,
    floor: [C('Pastry counter', 'counter', [240, 70, 105], 'glass-fronted pastry counter', { place: 'wall' }), C('Bread rack', 'display-shelf', [90, 40, 180], 'wooden bread rack with baskets', { place: 'wall' }), F('cafe-2', 'Cafe table', { qty: 2 }), F('chair', 'Chair', { qty: 4, seat: true }), F('plant', 'Plant', { place: 'corner' })],
    hero: D('Fresh banner', 'banner', [90, 2, 50], { text: 'FRESH BREAD' }), decor: [poster('BAKED', 'flower', 'left poster'), poster('DAILY', 'flower', 'right poster'), neon('OPEN', 'abstract')] },
  { id: 'dentist', re: w('dentist|tandläkar|hammaslääkär|dental'), purpose: 'dentist waiting room', forWhom: 'patients', palette: ['#e8f1f4', '#7fb8c9', '#3d8fa6', '#ffffff', '#2f4a57'], mood: 'clean, calm, bright', light: 'cool', pairs: true,
    floor: [F('reception-desk', 'Reception desk', { place: 'wall' }), F('waiting-chair', 'Waiting chair', { qty: 5, seat: true, place: 'wall' }), F('coffee-table', 'Magazine table'), F('plant', 'Plant', { place: 'corner' }), F('storage-cabinet', 'Storage cabinet', { place: 'wall' })],
    hero: sign('DENTAL CARE', 'star'), decor: [poster('SMILE', 'star', 'left poster'), poster('BRUSH TWICE', 'star', 'right poster'), D('Wall clock', 'clock', [35, 5, 35])] },
  { id: 'clinic', re: w('clinic|doctor|klinik|läkar|vårdcentral|vastaanotto|lääkäri|physio|massage|therapy|terapi'), purpose: 'clinic', forWhom: 'patients', palette: ['#eef3f1', '#8fbfae', '#4a9a86', '#ffffff', '#33474a'], mood: 'clean, calm, reassuring', light: 'cool', pairs: true,
    floor: [F('treatment-bed', 'Treatment bed', { place: 'wall' }), F('clinic-stool', 'Clinic stool'), F('desk-120', 'Doctor desk', { place: 'wall' }), F('chair', 'Patient chair', { qty: 2 }), F('filing-cabinet', 'Records cabinet', { place: 'wall' }), F('plant', 'Plant', { place: 'corner' })],
    hero: sign('CLINIC', 'leaf'), decor: [poster('HEALTH', 'leaf', 'left poster'), poster('CARE', 'leaf', 'right poster'), D('Wall clock', 'clock', [35, 5, 35])] },
  { id: 'classroom', re: w('classroom|school|klassrum|skola|luokka|koulu|lecture|tutor'), purpose: 'classroom', forWhom: 'pupils', palette: ['#f3ecd9', '#4b7bb5', '#e8a33d', '#ffffff', '#2e3e55'], mood: 'bright, orderly, lively', light: 'cool', pairs: true,
    floor: [F('desk-120', 'Pupil desk', { qty: 6, seat: true }), F('chair', 'Pupil chair', { qty: 6, seat: true }), F('desk-160', 'Teacher desk', { place: 'wall' }), F('bookshelf', 'Book shelf', { place: 'wall' }), F('storage-cabinet', 'Supply cabinet', { place: 'wall' })],
    hero: D('Board banner', 'banner', [120, 2, 60], { text: 'WELCOME' }), decor: [poster('ABC', 'book', 'left poster'), poster('123', 'book', 'right poster'), D('Wall clock', 'clock', [35, 5, 35])] },
  { id: 'shop', re: w('shop|store|boutique|butik|kauppa|myymälä|kiosk|market stall|gift'), purpose: 'small shop', forWhom: 'customers', palette: ['#f2e8da', '#2f5d6b', '#e0884a', '#fffaf2', '#262626'], mood: 'inviting, tidy, bright', light: 'warm', pairs: true,
    floor: [C('Shop counter', 'counter', [160, 60, 100], 'shop counter with a till', { place: 'wall' }), F('display-shelf', 'Display shelf', { qty: 3, place: 'wall' }), C('Display table', 'cafe-4', [90, 90, 85], 'square display table for goods'), F('plant', 'Plant', { place: 'corner' })],
    hero: sign('OPEN', 'star'), decor: [poster('NEW IN', 'star', 'left poster'), poster('SALE', 'star', 'right poster'), neon('WELCOME', 'abstract')] },
  { id: 'hotel', re: w('hotel|hotell|motel|guest room|gästrum|hotelli|b&b|bnb|vierashuone|airbnb'), purpose: 'hotel room', forWhom: 'guests', palette: ['#e9e1d3', '#4a5d73', '#b8863b', '#faf6ee', '#2a2f38'], mood: 'calm, crisp, welcoming', light: 'warm', pairs: true,
    floor: [F('bed-160', 'Bed', { place: 'wall', scale: true }), F('nightstand', 'Nightstand', { qty: 2 }), F('desk-120', 'Writing desk', { place: 'window' }), F('desk-chair', 'Desk chair'), F('wardrobe-100', 'Wardrobe', { place: 'wall' }), F('armchair', 'Armchair'), rug],
    hero: D('Headboard art', 'banner', [120, 2, 60], { text: 'WELCOME' }), decor: [poster('REST', 'moon', 'left poster'), poster('ENJOY', 'moon', 'right poster'), D('Wall clock', 'clock', [35, 5, 35])] },
  { id: 'bedroom', re: w('bedroom|sovrum|makuuhuone|sleeping'), purpose: 'bedroom', forWhom: 'sleep', palette: ['#d9d2c5', '#7f8fa6', '#c98b6b', '#f7f3ea', '#3b3f4a'], mood: 'calm, soft, restful', light: 'warm', pairs: true,
    floor: [F('bed-double', 'Bed', { place: 'wall', scale: true }), F('nightstand', 'Nightstand', { qty: 2 }), F('wardrobe-150', 'Wardrobe', { place: 'wall' }), F('dresser', 'Dresser', { place: 'wall' }), F('floor-lamp', 'Lamp'), rug],
    hero: poster('SLEEP WELL', 'moon', 'headboard poster'), decor: [poster('REST', 'moon', 'left poster'), poster('DREAM', 'moon', 'right poster'), shelf()] },
];

export const STYLES: StyleLayer[] = [
  { id: 'princess', re: w('princess|prinsess|prinsessa|doll|dock(?![a-zåäö]*skåp)|nukke|fairy|unicorn|enhörning|yksisarvinen|pink(?![a-zåäö])|rosa|pinkki|glam'), palette: ['#ffc1dc', '#fff7fb', '#ff4fa3', '#fffafc', '#d4af37'], motif: 'crown', word: 'DREAM', mood: 'glamorous, glossy', light: 'warm', room: 'bedroom' },
  { id: 'wizard', re: w('wizard|witch|magic|spell|trollkarl|häxa|magi|taikuri|velho|noita|taika'), palette: ['#2b2350', '#6a4fb3', '#f2c94c', '#e6dcf5', '#120d26'], motif: 'moon', word: 'MAGIC', mood: 'mystic, candlelit', light: 'warm', room: 'library' },
  { id: 'space', re: w('space(?![a-zåäö])|galaxy|astronaut|rymd|avaruus|planet|rocket|cosmic'), palette: ['#12162e', '#3a4a9f', '#ff7a45', '#dfe6ff', '#05060f'], motif: 'star', word: 'ORBIT', mood: 'cool, starry', light: 'neon', room: 'kids' },
  { id: 'jungle', re: w('jungle|safari|tropical|djungel|viidakko|rainforest'), palette: ['#2f6b45', '#8fbf6a', '#e8a33d', '#f1ecd2', '#1c3a28'], motif: 'leaf', word: 'WILD', mood: 'lush, green, warm', light: 'warm', room: 'kids' },
  { id: 'beach', re: w('beach|seaside|nautical|ocean|strand|ranta|rantа|surf|coastal|havs|merellinen'), palette: ['#f2e4c4', '#4a9ab8', '#e8765a', '#fffaf0', '#24485a'], motif: 'flower', word: 'SEA', mood: 'sunny, breezy', light: 'warm', room: 'living' },
  { id: 'cabin', re: w('cabin|cottage|rustic|lodge|stuga|mökki|log house|timber|viking'), palette: ['#8a5a36', '#d9c3a0', '#a33b2e', '#f1e6d2', '#3a2619'], motif: 'leaf', word: 'HOME', mood: 'warm, woody, snug', light: 'warm', room: 'living' },
  { id: 'japanese', re: w('japanese|japan|zen(?![a-zåäö])|japandi|tatami|japansk|japanilai'), palette: ['#e9e0cf', '#7a8a6a', '#c0392b', '#faf6ec', '#2e2a26'], motif: 'flower', word: 'ZEN', mood: 'calm, minimal, natural', light: 'warm', room: 'yoga' },
  { id: 'scandi', re: w('scandinavian|nordic|scandi|skandinav|pohjoismai|hygge'), palette: ['#f4f1ea', '#c9b99a', '#6f8fa6', '#ffffff', '#3b3f45'], motif: 'leaf', word: 'HYGGE', mood: 'light, calm, natural', light: 'warm', room: 'living' },
  { id: 'industrial', re: w('industrial|loft(?![a-zåäö])|industri|teollisuus'), palette: ['#4a4d52', '#a65f3a', '#e8b04b', '#d9d9d6', '#1c1d20'], motif: 'star', word: 'LOFT', mood: 'raw, dark, honest', light: 'neon', room: 'living' },
  { id: 'seventies', re: w('1970|70s|70-tal|70-luku|seventies|retro|disco'), palette: ['#c98a2b', '#6b8a3a', '#c4552b', '#f3e2b8', '#4a2f1a'], motif: 'flower', word: 'GROOVY', mood: 'warm, groovy, earthy', light: 'warm', room: 'living' },
];

/** A catch-all living room for a style with no room named. */
const LIVING: Kit = { id: 'living', re: /$^/, purpose: 'living room', forWhom: 'you', palette: ['#d9cdb8', '#6f7f8f', '#c98b4b', '#f7f1e4', '#33373d'], mood: 'calm, practical', light: 'warm', pairs: true,
  floor: [F('sofa-3', 'Sofa', { place: 'wall' }), F('armchair', 'Armchair', { qty: 2 }), F('coffee-table', 'Coffee table'), F('tv-unit', 'Media unit', { place: 'wall' }), F('floor-lamp', 'Lamp'), F('plant', 'Plant', { place: 'corner' }), F('rug-200', 'Rug')],
  hero: poster('HOME', 'leaf', 'home poster'), decor: [poster('WELCOME', 'leaf', 'side poster'), shelf()] };

export const kitById = (id: string): Kit | undefined => KITS.find((k) => k.id === id) ?? (id === 'living' ? LIVING : undefined);

export interface KitMatch { kit: Kit; styles: StyleLayer[] }

/** The room world a sentence names: the first matching kit, plus every style layer it mentions. */
export function matchKit(text: string): KitMatch | undefined {
  const lc = text.toLowerCase();
  const styles = STYLES.filter((s) => s.re.test(lc));
  const kit = KITS.find((k) => k.re.test(lc)) ?? (styles[0] ? kitById(styles[0].room) : undefined);
  if (!kit) return undefined;
  // A style named as the room itself ("wizard library") picks that room; a bare style picks its default room.
  return { kit, styles };
}

// ---- numbers and names ----------------------------------------------------------------------

const NUM: Record<string, number> = { one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, en: 1, ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, yksi: 1, kaksi: 2, kahdelle: 2, kolme: 3, kolmelle: 3, neljä: 4, neljälle: 4, viisi: 5, kuusi: 6 };
const WHO = 'kids?|child(ren)?|people|persons?|players?|gamers?|beds?|desks?|siblings?|twins?|barn|personer|spelare|syskon|lapsi|lasta|lapselle|lapselle|pelaajaa|ihmistä|sängyt|sängar|skrivbord';

/** How many people or beds the sentence asks for (1 to 6): "for two kids", "3 desks", "för två barn". */
export function countOf(text: string): number {
  const lc = text.toLowerCase();
  const word = Object.keys(NUM).filter((k) => k.length > 1).join('|');
  const m = lc.match(new RegExp(`(?<![a-zåäö0-9])(\\d+|${word})\\s+(?:${WHO})(?![a-zåäö])`)) ?? lc.match(new RegExp(`(?:for|för|kahdelle|kolmelle)\\s+(\\d+|${word})(?![a-zåäö0-9])`)) ?? lc.match(/(?<![a-zåäö0-9])(kahdelle|kolmelle|neljälle)(?![a-zåäö])/);
  if (!m) return 1;
  const v = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM[m[1]] ?? 1;
  return Math.max(1, Math.min(6, v));
}

/** Proper names to print: "named Gerard", "heter Lisa", "nimeltä Aino", "Lily's room", "for Max". */
export function namesIn(text: string): string[] {
  const out: string[] = [];
  const cap = '([A-ZÅÄÖ][a-zåäöé]+(?:\\s+[A-ZÅÄÖ][a-zåäöé]+)?)';
  const res = [new RegExp(`(?:named|called|name is|heter|kallas|nimeltä|nimeltään|nimi on|for|för)\\s+${cap}`, 'g'), new RegExp(`${cap}['’]s\\s+(?:[a-zåäö]+\\s+)?(?:room|nook|studio|bar|cafe|café|shop|bakery|place|den)`, 'g'), new RegExp(`${cap}(?:n|s)\\s+(?:rum|huone|studio|kahvila|kauppa)`, 'g')];
  for (const re of res) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) if (!/^(My|The|A|An|Two|Three|Four|Me|Us|Him|Her|IKEA|En|Ett|Två|Tre|Mig|Oss|Kahdelle)$/i.test(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

// ---- art direction (pure) -------------------------------------------------------------------

/** Wall decor centres sit between 1.4 and 1.6 m: eye height. */
export const EYE_MIN = 1.4, EYE_MAX = 1.6;
export const eyeCentre = (wanted = 1.5): number => Math.max(EYE_MIN, Math.min(EYE_MAX, wanted));

/** The wall facing the door: the hero piece goes there. */
export const heroWall = (doorWall: number, wallCount: number): number => (doorWall + Math.max(2, Math.round(wallCount / 2))) % Math.max(1, wallCount);

export interface Span { from: number; to: number; kind: 'door' | 'window' }

/** True when an item centred at x with the given width overlaps a door or window span (10 cm margin). */
export function hitsOpening(x: number, width: number, spans: Span[], margin = 0.1): boolean {
  return spans.some((s) => x - width / 2 < s.to + margin && x + width / 2 > s.from - margin);
}

/** Nearest centre to `want` on a wall of length `len` where the item clears every door and window, or null. */
export function fitOnWall(len: number, width: number, spans: Span[], want = len / 2): number | null {
  const lo = width / 2 + 0.1, hi = len - width / 2 - 0.1;
  if (hi < lo) return null;
  const cands = [want, ...spans.flatMap((s) => [s.from - 0.1 - width / 2, s.to + 0.1 + width / 2]), lo, hi]
    .map((x) => Math.max(lo, Math.min(hi, x))).filter((x) => !hitsOpening(x, width, spans, 0.099));
  if (!cands.length) return null;
  return cands.sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
}

/** Centres for a symmetric pair around the hero: [left, right], or null when either would leave the wall. */
export function pairAround(heroX: number, heroW: number, itemW: number, wallLen: number, gap = 0.25): [number, number] | null {
  const off = heroW / 2 + gap + itemW / 2;
  const l = heroX - off, r = heroX + off;
  return l - itemW / 2 >= 0.1 && r + itemW / 2 <= wallLen - 0.1 ? [l, r] : null;
}

const areaOf = (o: ThemeObject): number => {
  if (o.sizeCm) return (o.sizeCm[0] * o.sizeCm[1]) / 1e4;
  const c = o.catalogId ? catalogEntry(o.catalogId) : undefined;
  return c ? c.w * c.d : 0.5;
};
const total = (o: ThemeObject) => areaOf(o) * Math.max(1, o.qty ?? 1);
const isWall = (o: ThemeObject) => o.mount === 'wall';

/**
 * 60/30/10: the large floor pieces are split greedily between the dominant and secondary colour
 * (about 2:1 by floor area), small pieces and wall decor carry the accent (10), the hero uses the
 * dark and accent colours so it stands out.
 */
export function apply603010(objects: ThemeObject[], palette: string[]): ThemeObject[] {
  const [p0, p1, p2, p3, p4] = [0, 1, 2, 3, 4].map((i) => palette[i] ?? palette[palette.length - 1] ?? '#d9c7a8');
  const big = objects.filter((o) => !isWall(o) && total(o) >= 0.3 && o.recipe !== 'statue').sort((a, b) => total(b) - total(a));
  const share = new Map<ThemeObject, 0 | 1>();
  let a0 = 0, a1 = 0;
  for (const o of big) {
    if (a0 / 0.6 <= a1 / 0.3) { share.set(o, 0); a0 += total(o); } else { share.set(o, 1); a1 += total(o); }
  }
  return objects.map((o) => {
    if (o.color && o.locked) return o;
    if (isWall(o)) return o.hero ? { ...o, color: p4, accent: p2 } : o.recipe === 'neon' ? { ...o, color: p2, accent: p3 } : { ...o, color: p3, accent: o.recipe === 'poster' ? p2 : p4 };
    const s = share.get(o);
    if (s === 0) return { ...o, color: p0, accent: p3 };
    if (s === 1) return { ...o, color: p1, accent: p0 };
    return { ...o, color: p2, accent: p4 };
  });
}

/** Floor area carried by each colour class: dominant, secondary and accent shares of all floor pieces. */
export function colourShares(objects: ThemeObject[], palette: string[]): { dominant: number; secondary: number; accent: number } {
  const floor = objects.filter((o) => !isWall(o));
  const sum = floor.reduce((s, o) => s + total(o), 0) || 1;
  const of = (c?: string) => floor.filter((o) => o.color === c).reduce((s, o) => s + total(o), 0) / sum;
  return { dominant: of(palette[0]), secondary: of(palette[1]), accent: of(palette[2]) };
}

// ---- building a brief -----------------------------------------------------------------------

const sizeText = (s: V3) => `${s[0]} x ${s[1]} x ${s[2]} cm`;

function floorObject(f: Floor, n: number, theme: string): ThemeObject {
  const qty = (f.qty ?? 1) * (f.scale ? n : 1);
  const q = f.seat ? Math.max(qty, Math.min(8, n * 2)) : qty;
  const o: ThemeObject = f.size
    ? { source: 'custom', name: f.name, catalogId: f.id, recipe: f.recipe, sizeCm: f.size, mount: 'floor', place: f.place, prompt: `${f.name}, ${f.desc ?? f.name}, ${sizeText(f.size)}, ${theme}` }
    : { source: 'catalogue', name: f.name, catalogId: f.id, place: f.place, mount: 'floor' };
  return q > 1 ? { ...o, qty: Math.min(12, q) } : o;
}

function decoObject(d: Deco, text: string | undefined, style: string, theme: string, hero = false): ThemeObject {
  const words = text ?? d.text;
  return {
    source: 'custom', name: d.name, recipe: d.recipe, sizeCm: d.size, mount: 'wall', text: words, style: d.style ?? style, place: 'wall', hero, eyeM: eyeCentre(1.5),
    prompt: `${d.name}, ${sizeText(d.size)}, ${theme}${words ? `, with the words "${words}" printed on it` : ''}`,
  };
}

/** The offline brief for a matched room world: kit and style layers, count and names applied. */
export function kitBrief(text: string, match: KitMatch, names: string[] = namesIn(text)): Omit<ThemeBrief, 'by' | 'ms'> {
  const { kit, styles } = match;
  const style = styles[0];
  const n = countOf(text);
  const palette = [...(style?.palette ?? kit.palette)] as Kit['palette'];
  const theme = `${style ? `${style.id} style ` : ''}${kit.purpose}, ${kit.mood}`;
  const motif = style?.motif ?? kit.hero.style ?? 'star';
  const who = names[0];
  const printed = (d: Deco) => (who && ['poster', 'sign', 'neon', 'banner'].includes(d.recipe) ? who.toUpperCase() : undefined);
  const heroObj = decoObject(kit.hero, printed(kit.hero), kit.hero.style ?? motif, theme, true);
  const decor = kit.decor.map((d) => decoObject(d, undefined, d.style ?? motif, theme));
  if (style) decor.push(decoObject(sign(style.word, style.motif), undefined, style.motif, theme));
  const floor = kit.floor.map((f) => floorObject(f, n, theme));
  const objects = apply603010([...floor, heroObj, ...decor], palette);
  const title = who ? `${who}'s ${kit.purpose}` : `${style ? `${style.id[0].toUpperCase()}${style.id.slice(1)} ` : ''}${kit.purpose[0].toUpperCase()}${kit.purpose.slice(1)}`;
  return {
    title, purpose: kit.purpose, forWhom: n > 1 ? `${n} ${kit.forWhom.replace(/^an? /, '')}s` : who ? `${who}` : kit.forWhom, names, palette,
    mood: style ? `${kit.mood}, ${style.mood}` : kit.mood, light: style?.light ?? kit.light, objects, realProducts: false, notes: [],
  };
}
