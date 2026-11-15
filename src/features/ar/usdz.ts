// "See it in your room" on iPhone: the design as a USDZ file at true scale (1 unit = 1 metre),
// opened by AR Quick Look. Other devices download the file instead.
import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { buildScene } from '../export/glb';
import { fitSpec } from '../forge/fit';
import { partGeometry, textTexture } from '../forge/GeneratedMesh';
import { materialFor } from '../forge/materials';

const MIME = 'model/vnd.usdz+zip';

async function toBlob(scene: THREE.Scene): Promise<Blob> {
  const data = await new USDZExporter().parseAsync(scene);
  return new Blob([data as BlobPart], { type: MIME });
}

/** A generated object as real meshes (its own parts, colours and printed words), standing on the floor at its true size. */
function customGroup(item: FurnitureItem): THREE.Group {
  const spec = fitSpec(item.custom!, { w: item.w, d: item.d, h: item.h });
  const g = new THREE.Group();
  g.name = item.name;
  spec.parts.forEach((part, i) => {
    const { geo, piping } = partGeometry(part, [i * 0.37 % 3, i * 0.61 % 3]);
    // Own material per part: the shared ones carry photo maps that load later and cannot be written into the file.
    const src = materialFor(part.material, part.color);
    const mat = new THREE.MeshStandardMaterial({ color: src.color.clone(), roughness: src.roughness, metalness: src.metalness, name: part.name });
    if (src.transparent) { mat.transparent = true; mat.opacity = src.opacity; }
    const holder = new THREE.Group();
    holder.position.set(...part.pos);
    if (part.rot) holder.rotation.set(...part.rot);
    holder.name = part.name;
    holder.add(new THREE.Mesh(geo, mat));
    if (piping) holder.add(new THREE.Mesh(piping, mat));
    if (part.text?.value) {
      const tex = textTexture(part.text, part.size[0], part.size[1]);
      if (tex) {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(part.size[0], part.size[1]), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, name: `${part.name} text` }));
        plane.position.set(0, 0, part.size[2] / 2 + 0.0008);
        holder.add(plane);
      }
    }
    g.add(holder);
  });
  return g;
}

function placeCustom(item: FurnitureItem): THREE.Group {
  const g = customGroup(item);
  g.position.set(item.x, item.elevationM ?? 0, item.y);
  g.rotation.y = -item.rotation;
  return g;
}

/** The whole furnished room (floors, walls with openings, furniture) in metres. Generated objects keep their real shape. */
export function exportRoomUsdz(model: SpaceModel, furniture: FurnitureItem[] = model.furniture): Promise<Blob> {
  const scene = buildScene(model, furniture.filter((f) => !f.custom));
  for (const f of furniture) if (f.custom) scene.add(placeCustom(f));
  return toBlob(scene);
}

/** One item standing on the floor at its true size, so it can be placed in the real room. */
export function exportItemUsdz(item: FurnitureItem): Promise<Blob> {
  const scene = new THREE.Scene();
  scene.name = item.name;
  if (item.custom) { scene.add(customGroup(item)); return toBlob(scene); }
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

/** Opens the file in AR Quick Look on iOS (rel="ar" link with an image child); on other devices it is downloaded. */
export function openInAR(blob: Blob, name = 'SpaceLens.usdz'): void {
  const file = blob.type === MIME ? blob : new Blob([blob], { type: MIME });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  if (supportsQuickLook()) {
    a.rel = 'ar';
    a.appendChild(document.createElement('img'));
  } else {
    a.download = name.replace(/[\/:*?"<>|]+/g, '-');
  }
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60_000);
}
