// Exchange rates to SEK, for carrying foreign listings into the bill of furniture.
// Live ECB reference rates come from frankfurter.dev (free, no key, allows browser requests);
// if that fails a built-in estimate is used and labelled as such. The person can always edit it.

export interface Rate { rate: number; source: string }

const FALLBACK: Record<string, number> = { SEK: 1, EUR: 11.1, USD: 10.0, GBP: 12.7, NOK: 0.95, DKK: 1.49, CHF: 11.9, PLN: 2.6 };
let live: { at: number; date: string; perSek: Record<string, number> } | null = null;

async function loadLive(): Promise<typeof live> {
  if (live && Date.now() - live.at < 6 * 3600_000) return live;
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=SEK');
    if (!res.ok) return live;
    const j = (await res.json()) as { date: string; rates: Record<string, number> };
    live = { at: Date.now(), date: j.date, perSek: j.rates };
  } catch { /* offline or blocked */ }
  return live;
}

/** How many SEK one unit of `currency` is worth. */
export async function rateToSek(currency: string): Promise<Rate> {
  const c = currency.toUpperCase();
  if (c === 'SEK') return { rate: 1, source: 'same currency' };
  const l = await loadLive();
  const per = l?.perSek[c];
  if (per && per > 0) return { rate: Math.round((1 / per) * 10000) / 10000, source: `ECB rate ${l!.date}` };
  return { rate: FALLBACK[c] ?? 1, source: FALLBACK[c] ? 'built-in estimate' : 'unknown currency, set the rate' };
}

export const toSek = (amount: number, rate: number) => Math.round(amount * rate);
