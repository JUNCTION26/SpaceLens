// "See it in your room" on iPhone: the design as a USDZ file at true scale (1 unit = 1 metre),
// opened by AR Quick Look. Other devices download the file instead.
import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { buildScene } from '../export/glb';

const MIME = 'model/vnd.usdz+zip';

async function toBlob(scene: THREE.Scene): Promise<Blob> {
  const data = await new USDZExporter().parseAsync(scene);
  return new Blob([data as BlobPart], { type: MIME });
}

/** The whole furnished room (floors, walls with openings, furniture) in metres. */
export function exportRoomUsdz(model: SpaceModel, furniture: FurnitureItem[] = model.furniture): Promise<Blob> {
  return toBlob(buildScene(model, furniture));
}

/** One item standing on the floor at its true size, so it can be placed in the real room. */
export function exportItemUsdz(item: FurnitureItem): Promise<Blob> {
  const scene = new THREE.Scene();
  scene.name = item.name;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(item.w, item.h, item.d), new THREE.MeshStandardMaterial({ color: new THREE.Color(item.color || '#999999'), name: item.name }));
  mesh.position.set(0, item.h / 2, 0);
  mesh.name = item.name;
  scene.add(mesh);
  return toBlob(scene);
}

/** True where AR Quick Look opens `<a rel="ar">` links (iPhone and iPad). */
export function supportsQuickLook(): boolean {
  if (typeof document === 'undefined') return false;
  const a = document.createElement('a');
  return !!a.relList?.supports?.('ar');
}

/** Opens the file in AR Quick Look on iOS; on other devices it is downloaded. */
export function openInAR(blob: Blob, name = 'SpaceLens.usdz'): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  if (supportsQuickLook()) {
    a.rel = 'ar';
    // Quick Look needs an image child inside the link to treat it as an AR link.
    a.appendChild(document.createElement('img'));
  } else {
    a.download = name;
  }
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60_000);
}
