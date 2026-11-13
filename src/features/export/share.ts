import type { SpaceModel } from '../../core/types';
import { getState } from '../../core/store';
import { validateModel } from './validate';

/** Drops evidence images so the link stays small. */
export function stripForShare(m: SpaceModel): SpaceModel {
  return { ...m, evidence: m.evidence.map(({ imageUrl: _drop, ...e }) => e) };
}

export const toB64u = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeModel(m: SpaceModel): Promise<string> {
  return toB64u(await pipe(new TextEncoder().encode(JSON.stringify(stripForShare(m))), new CompressionStream('deflate-raw')));
}
export async function decodeModel(s: string): Promise<SpaceModel> {
  return validateModel(JSON.parse(new TextDecoder().decode(await pipe(fromB64u(s), new DecompressionStream('deflate-raw')))));
}

export async function shareLink(m: SpaceModel): Promise<string> {
  return `${location.origin}${location.pathname}#m=${await encodeModel(m)}`;
}

export async function loadFromHash(): Promise<boolean> {
  if (typeof location === 'undefined') return false;
  const k = new URLSearchParams(location.hash.slice(1)).get('m');
  if (!k) return false;
  try {
    const model = await decodeModel(k);
    const st = getState();
    st.dispatch({ type: 'REPLACE_MODEL', model });
    st.toast('Opened shared design', 'ok');
    return true;
  } catch {
    getState().toast('Could not open the shared link', 'error');
    return false;
  }
}

let ran = false;
if (!ran && typeof window !== 'undefined' && !import.meta.env?.VITEST) { ran = true; void loadFromHash(); }
