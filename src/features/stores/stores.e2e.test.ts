// Live checks against the reader, the web and Gemini. Skipped unless STORES_E2E=1 and
// VITE_GEMINI_KEY are set, so plain `npx vitest run` never touches the network.
import { describe, expect, it } from 'vitest';
import { getState } from '../../core/store';
import { compareListings } from './advise';
import { listingToItem } from './convert';
import { readListing } from './read';
import { searchProducts } from './search';

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const live = env.STORES_E2E === '1' || (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.STORES_E2E === '1';
const key = env.VITE_GEMINI_KEY ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.VITE_GEMINI_KEY ?? '';

describe.skipIf(!live)('stores live', () => {
  it('reads a listing, searches, converts and compares', async () => {
    if (key) getState().setSettings({ geminiKey: key });
    const page = await readListing('https://www.ikea.com/se/en/p/kivik-3-seat-sofa-gunnared-medium-grey-s49484807/');
    expect(page.price).toBeGreaterThan(0);
    expect(page.stated?.w).toBeGreaterThan(1);
    const item = await listingToItem(page);
    expect(item.w).toBe(page.stated!.w);
    expect(item.listing?.url).toBe(page.url);
    const found = await searchProducts('grey 3-seat sofa under 6 000 kr max 220 cm wide');
    expect(found.every((r) => r.url && r.fetchedAt)).toBe(true);
    const cmp = await compareListings([page, ...found].filter((r) => r.stated), { model: getState().model, budgetSek: 6000 });
    expect(cmp.pick).not.toBeNull();
  }, 240_000);
});
