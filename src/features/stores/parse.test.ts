import { describe, expect, it } from 'vitest';
import {
  extractJsonBlock, fmtDims, isCategoryUrl, isLikelyProductUrl, isListTitle, mainSection, parseDdgResults, parseDimensions, parseNumber, parsePrice, parsePrices,
  parseQueryLimits, parseReaderMarkdown, searchTerms, stripStoreSuffix, timeAgo,
} from './parse';

describe('prices', () => {
  it('reads Swedish kronor with spaces', () => {
    expect(parsePrice('5 995 kr')).toEqual({ amount: 5995, currency: 'SEK' });
    expect(parsePrice('Pris 5 995 kr')).toEqual({ amount: 5995, currency: 'SEK' });
    expect(parsePrice('5 195:-Price 5195:-')).toEqual({ amount: 5195, currency: 'SEK' });
    expect(parsePrice('1 299,00 kr')).toEqual({ amount: 1299, currency: 'SEK' });
    expect(parsePrice('SEK 12 495')).toEqual({ amount: 12495, currency: 'SEK' });
  });
  it('reads euros, dollars and pounds', () => {
    expect(parsePrice('€499')).toEqual({ amount: 499, currency: 'EUR' });
    expect(parsePrice('826,99 €')).toEqual({ amount: 826.99, currency: 'EUR' });
    expect(parsePrice('€1.299,00')).toEqual({ amount: 1299, currency: 'EUR' });
    expect(parsePrice('$1,299.99')).toEqual({ amount: 1299.99, currency: 'USD' });
    expect(parsePrice('£349')).toEqual({ amount: 349, currency: 'GBP' });
    expect(parsePrice('EUR 89.90')).toEqual({ amount: 89.9, currency: 'EUR' });
  });
  it('maps kr to the store country when asked', () => {
    expect(parsePrice('7 990,- kr', 'NOK')?.currency).toBe('NOK');
  });
  it('ignores bare numbers and sizes', () => {
    expect(parsePrice('Width 228 cm, 3 seats')).toBeNull();
  });
  it('lists every price in order', () => {
    expect(parsePrices('From 19 SEK. 5 195:- now, was 6 495 kr').map((p) => p.amount)).toEqual([19, 5195, 6495]);
  });
  it('parses number formats', () => {
    expect(parseNumber('5 995')).toBe(5995);
    expect(parseNumber('12,995')).toBe(12995);
    expect(parseNumber('826,99')).toBe(826.99);
    expect(parseNumber('1.299')).toBe(1299);
  });
});

describe('dimensions', () => {
  it('reads labelled triples', () => {
    expect(parseDimensions('W 220 x D 95 x H 82 cm')).toEqual({ w: 2.2, d: 0.95, h: 0.82 });
    expect(parseDimensions('B 220 × T 95 × H 82 cm')).toEqual({ w: 2.2, d: 0.95, h: 0.82 });
    expect(parseDimensions('H 820 x W 2200 x D 950 mm')).toEqual({ h: 0.82, w: 2.2, d: 0.95 });
  });
  it('reads an order prefix', () => {
    expect(parseDimensions('Sofa Palmira, B/T/H: 220 x 71 x 85 cm')).toEqual({ w: 2.2, d: 0.71, h: 0.85 });
  });
  it('reads single labels in several languages', () => {
    expect(parseDimensions('Bredd: 220 cm')).toEqual({ w: 2.2 });
    expect(parseDimensions('Bredd: 220 cm\nDjup: 95 cm\nHöjd: 82 cm')).toEqual({ w: 2.2, d: 0.95, h: 0.82 });
    expect(parseDimensions('*   Width 228 cm\n*   Depth 95 cm\n*   Height 83 cm\n*   Seat width 180 cm')).toEqual({ w: 2.28, d: 0.95, h: 0.83 });
  });
  it('skips compound labels like seat height', () => {
    const t = '**Höhe Armlehnen:** 74 cm  \n**Tiefe:** 102 cm  \n**Sitzhöhe:** 43 cm  \n**Breite:** 220 cm  \n**Höhe:** 87 cm';
    expect(parseDimensions(t)).toEqual({ w: 2.2, d: 1.02, h: 0.87 });
  });
  it('reads bare triples as W x D x H', () => {
    expect(parseDimensions('3-Sitzer-Sofa 228 x 80 x 93 cm')).toEqual({ w: 2.28, d: 0.8, h: 0.93 });
  });
  it('formats with gaps', () => {
    expect(fmtDims({ w: 2.2, h: 0.82 })).toBe('220 × ? × 82 cm');
  });
});

describe('reader and search pages', () => {
  const md = `Title: KIVIK 3-seat sofa, Gunnared medium grey  - IKEA Sweden

URL Source: https://www.ikea.com/se/en/p/kivik-3-seat-sofa-s49484807/

Markdown Content:
[Click & collect, from 19 SEK*](https://www.ikea.com/x)
![Image 18](https://www.ikea.com/global/assets/logos/brand/ikea.svg)
![Image 19: KIVIK sofa](https://www.ikea.com/se/en/images/products/kivik-3-seat-sofa__1577019_s5.jpg?f=u)
# KIVIK 3-seat sofa
5 195:-Price 5195:-
`;
  it('splits the page', () => {
    const p = parseReaderMarkdown(md);
    expect(p.title).toContain('KIVIK');
    expect(p.sourceUrl).toContain('ikea.com');
    expect(p.images).toEqual(['https://www.ikea.com/se/en/images/products/kivik-3-seat-sofa__1577019_s5.jpg?f=u']);
    expect(parsePrice(mainSection(p.body, p.title))).toEqual({ amount: 5195, currency: 'SEK' });
  });
  it('strips the store suffix', () => {
    expect(stripStoreSuffix('KIVIK 3-seat sofa, Gunnared medium grey  - IKEA Sweden', 'ikea.com')).toBe('KIVIK 3-seat sofa, Gunnared medium grey');
    expect(stripStoreSuffix('3-Sitzer Sofa EKSJO kaufen | home24', 'home24.de')).toBe('3-Sitzer Sofa EKSJO');
  });
  it('decodes DuckDuckGo links', () => {
    const hits = parseDdgResults('## [KIVIK 3-seat sofa - IKEA](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ikea.com%2Fse%2Fen%2Fp%2Fkivik-s49484807%2F&rut=abc)\n## [Ad](https://duckduckgo.com/y.js?ad=1)');
    expect(hits).toEqual([{ title: 'KIVIK 3-seat sofa - IKEA', url: 'https://www.ikea.com/se/en/p/kivik-s49484807/' }]);
  });
  it('tells products from categories', () => {
    expect(isLikelyProductUrl('https://www.ikea.com/se/en/p/kivik-3-seat-sofa-s49484807/')).toBe(true);
    expect(isLikelyProductUrl('https://www.home24.de/produkt/3-sitzer-sofa-eksjo-c809')).toBe(true);
    expect(isLikelyProductUrl('https://www.ikea.com/se/en/cat/three-seat-sofas-10670/')).toBe(false);
    expect(isLikelyProductUrl('https://www.walmart.com/browse/home/sofas-couches/gray/4044_103150_4038_9394595/Y29s')).toBe(false);
    expect(isLikelyProductUrl('https://www.amazon.com/3-seater-grey-sofa/s?k=3+seater+grey+sofa')).toBe(false);
    expect(isCategoryUrl('https://rowicohome.com/en/furniture/sofas/3-seater-sofas/grey-3-seater-sofas')).toBe(true);
    expect(isCategoryUrl('https://www.diy.com/home-furniture-storage/furniture/sofas.cat?Colour+group=Grey')).toBe(true);
    expect(isCategoryUrl('https://jysk.se/vardagsrum/soffor/soffa-gedved-3-sits-gra')).toBe(false);
    expect(isListTitle('Grey 3 Seater Sofas | John Lewis & Partners')).toBe(true);
    expect(isListTitle('Soffa GEDVED 3-sits grå')).toBe(false);
  });
});

describe('query limits and helpers', () => {
  it('reads budget and size limits', () => {
    expect(parseQueryLimits('grey 3-seat sofa under 6 000 kr max 220 cm wide')).toEqual({ maxPrice: 6000, currency: 'SEK', maxW: 2.2 });
    expect(parseQueryLimits('oak desk below €500')).toEqual({ maxPrice: 500, currency: 'EUR' });
  });
  it('strips limits from the search words', () => {
    expect(searchTerms('grey 3-seat sofa under 6 000 kr max 220 cm wide')).toBe('grey 3-seat sofa');
    expect(searchTerms('oak desk below €500')).toBe('oak desk');
  });
  it('extracts a JSON block', () => {
    expect(extractJsonBlock('Here:\n```json\n{"results":[1]}\n```')).toEqual({ results: [1] });
    expect(extractJsonBlock('noise {"a":2} tail')).toEqual({ a: 2 });
    expect(extractJsonBlock('nothing')).toBeNull();
  });
  it('says how old a reading is', () => {
    expect(timeAgo(0, 10_000)).toBe('just now');
    expect(timeAgo(0, 120_000)).toBe('2 min ago');
  });
});
