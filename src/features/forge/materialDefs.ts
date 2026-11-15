// Pure material data (no 3D library), so colour logic can read it on the first screen.
import type { MaterialId } from '../../core/types';

export type Kind = 'wood' | 'fabric' | 'metal' | 'stone' | 'plain' | 'glass' | 'plant' | 'leather' | 'rattan' | 'quilt';

export interface MaterialDef {
  /** Base colour when the part has none and no photo texture is loaded. */
  color: string;
  rough: number;
  metal: number;
  kind: Kind;
  /** Metres covered by one procedural tile. */
  tileM: number;
  /** Photo texture colours are kept as-is when the part has no colour. */
  natural?: boolean;
  /** Multiplier on the photo texture when the part has no colour (to correct a too-light scan). */
  photoTint?: string;
  normal?: number;
  sheen?: number;
  clearcoat?: number;
  opacity?: number;
}

export const MATERIAL_DEFS: Record<MaterialId, MaterialDef> = {
  oak: { color: '#c39a6b', rough: 0.55, metal: 0, kind: 'wood', tileM: 1.2, natural: true, normal: 0.5, clearcoat: 0.08 },
  walnut: { color: '#6e4a32', rough: 0.5, metal: 0, kind: 'wood', tileM: 1.2, natural: true, photoTint: '#8c6a56', normal: 0.5, clearcoat: 0.12 },
  pine: { color: '#d8b47f', rough: 0.6, metal: 0, kind: 'wood', tileM: 0.9, natural: true, normal: 0.5 },
  birch: { color: '#e3cfae', rough: 0.55, metal: 0, kind: 'wood', tileM: 1.0, natural: true, normal: 0.4 },
  'white-laminate': { color: '#f1efea', rough: 0.42, metal: 0, kind: 'plain', tileM: 0.6, clearcoat: 0.1 },
  'black-laminate': { color: '#1f1f21', rough: 0.42, metal: 0, kind: 'plain', tileM: 0.6, clearcoat: 0.1 },
  'black-metal': { color: '#1c1c1e', rough: 0.42, metal: 0.75, kind: 'metal', tileM: 0.5, normal: 0.08 },
  steel: { color: '#b9bdc3', rough: 0.3, metal: 1, kind: 'metal', tileM: 0.5, normal: 0.1 },
  brass: { color: '#c9a24c', rough: 0.28, metal: 1, kind: 'metal', tileM: 0.5, normal: 0 },
  chrome: { color: '#eceef1', rough: 0.08, metal: 1, kind: 'metal', tileM: 0.5, normal: 0 },
  fabric: { color: '#9b968d', rough: 0.95, metal: 0, kind: 'fabric', tileM: 0.12, normal: 0.6 },
  linen: { color: '#d8cfbf', rough: 0.96, metal: 0, kind: 'fabric', tileM: 0.1, normal: 0.7 },
  velvet: { color: '#4d6a48', rough: 0.85, metal: 0, kind: 'fabric', tileM: 0.12, normal: 0.3, sheen: 1 },
  leather: { color: '#7b4a2c', rough: 0.5, metal: 0, kind: 'leather', tileM: 0.4, natural: true, normal: 0.5, clearcoat: 0.25 },
  wool: { color: '#bfb7a8', rough: 0.98, metal: 0, kind: 'fabric', tileM: 0.08, normal: 0.9, sheen: 0.4 },
  glass: { color: '#e9f2f6', rough: 0.04, metal: 0, kind: 'glass', tileM: 1, opacity: 0.28 },
  marble: { color: '#ebe8e3', rough: 0.22, metal: 0, kind: 'stone', tileM: 1.2, natural: true, clearcoat: 0.6, normal: 0.2 },
  concrete: { color: '#a9a59e', rough: 0.9, metal: 0, kind: 'stone', tileM: 1.5, natural: true, normal: 0.6 },
  plastic: { color: '#e8e6e1', rough: 0.38, metal: 0, kind: 'plain', tileM: 0.6, clearcoat: 0.2 },
  mattress: { color: '#f3f1ec', rough: 0.95, metal: 0, kind: 'quilt', tileM: 0.25, normal: 0.8 },
  rattan: { color: '#c7a06a', rough: 0.75, metal: 0, kind: 'rattan', tileM: 0.08, normal: 1 },
  ceramic: { color: '#f0ede7', rough: 0.25, metal: 0, kind: 'plain', tileM: 0.6, clearcoat: 0.8 },
  plant: { color: '#4b7a3c', rough: 0.65, metal: 0, kind: 'plant', tileM: 0.15, normal: 0.6, sheen: 0.3 },
};
