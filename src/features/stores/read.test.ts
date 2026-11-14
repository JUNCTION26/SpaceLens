import { describe, expect, it } from 'vitest';
import { listingFromMarkdown } from './read';

const product = `Title: KIVIK 3-seat sofa, grey - IKEA Sweden

URL Source: https://www.ikea.com/se/en/p/kivik-3-seat-sofa-grey-s49484807/

Markdown Content:
[Click & collect, from 19 SEK*](https://www.ikea.com/se/en/customer-service/)
![Christmas candle](https://www.ikea.com/ext/ingkadam/m/1/original/PE1.jpg)

# KIVIK 3-seat sofa, grey

![sofa](https://www.ikea.com/se/en/images/products/kivik-3-seat-sofa-grey__1_s5.jpg)

5 195 SEK

Width: 228 cm
Depth: 95 cm
Height: 83 cm

## Related products

### [VIMLE](https://www.ikea.com/se/en/p/vimle-sofa-s1/)3-seat sofa
4 995 SEK
Width: 250 cm
`;

describe('store page reading', () => {
  it('takes the main product price, size and first product photo, not related blocks', async () => {
    const l = await listingFromMarkdown(product, 'https://www.ikea.com/se/en/p/kivik-3-seat-sofa-grey-s49484807/');
    expect(l.price).toBe(5195);
    expect(l.stated).toMatchObject({ w: 2.28, d: 0.95, h: 0.83 });
    expect(l.imageUrl).toMatch(/images\/products\/kivik/);
  });

  it('reads nothing from a page the store redirected to its front page', async () => {
    const md = `Title: All products - IKEA

URL Source: https://www.ikea.com/se/sv/p/lack-soffbord-svart-00449908/

Final URL: https://www.ikea.com/se/sv/cat/produkter-products/

Markdown Content:
[Click and collect, from 19:-*](https://www.ikea.com/x)
![Candle](https://www.ikea.com/ext/ingkadam/m/1/original/PE1.jpg)
`;
    const l = await listingFromMarkdown(md, 'https://www.ikea.com/se/sv/p/lack-soffbord-svart-00449908/');
    expect(l.price).toBeNull();
    expect(l.stated).toBeUndefined();
    expect(l.images).toEqual([]);
    expect(l.title).toMatch(/lack/i);
    expect(l.note).toMatch(/general page/);
  });
});
