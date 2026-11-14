/** Room purpose from a printed label, in the languages the plans use (de, fr, it, en, sv, fi). */

const RULES: Array<[RegExp, string, string]> = [
  // [pattern, purpose, English name]
  [/^(wohnen\/essen|wohn.?\/?ess|living\/dining|séjour\/repas|soggiorno\/pranzo)/, 'living', 'Living and dining'],
  [/(wohnen|wohnzimmer|living|séjour|sejour|salon|soggiorno|vardagsrum|olohuone|allrum)/, 'living', 'Living room'],
  [/(küche|kuche|kitchen|cuisine|cucina|kök|kok|keittiö|keittio|kitchenette|kochen)/, 'kitchen', 'Kitchen'],
  [/(essen|dining|repas|pranzo|matrum|ruokailu|salle à manger)/, 'dining', 'Dining'],
  [/(schlaf|bedroom|chambre|camera|stanza da letto|sovrum|makuuhuone|\bmh\b)/, 'bedroom', 'Bedroom'],
  [/^(zimmer|room|stanza|pièce|piece|rum|huone)$/, 'bedroom', 'Room'],
  [/(bad|bath|salle de bain|salle d'eau|bagno|badrum|kylpyhuone|dusche|douche|doccia|\bkph\b)/, 'bathroom', 'Bathroom'],
  [/(^wc$|toilet|toilette|gabinetto|^dusche\/wc|^bad\/wc)/, 'wc', 'WC'],
  [/(korridor|gang|flur|diele|corridor|hall|couloir|dégagement|degagement|corridoio|disimpegno|ingresso|entrée|entree|entrance|eingang|hallway|eteinen|entré|tambur)/, 'hallway', 'Hallway'],
  [/(treppe|stair|escalier|scala|trapp|porras)/, 'stair', 'Stairs'],
  [/(reduit|réduit|abstell|storage|ripostiglio|débarras|debarras|förråd|forrad|varasto|keller|cave|cantina|vaatehuone|closet)/, 'storage', 'Storage'],
  [/(wasch|laundry|buanderie|lavanderia|tvätt|tvatt|kodinhoito|\bkhh\b)/, 'utility', 'Laundry'],
  [/(büro|buro|office|bureau|ufficio|arbeits|kontor|työhuone|study|atelier|gewerbe)/, 'office', 'Office'],
  [/(balkon|balcon|balcony|balcone|loggia|terrasse|terrazza|terrace|veranda|sitzplatz|parveke)/, 'balcony', 'Balcony'],
];

export function purposeOf(label: string | undefined): { purpose: string; english: string } | null {
  if (!label) return null;
  const s = label.toLowerCase().normalize('NFC').trim();
  for (const [re, purpose, english] of RULES) if (re.test(s)) return { purpose, english };
  return null;
}

export const OUTDOOR_PURPOSES = new Set(['balcony']);
