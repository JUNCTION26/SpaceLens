import * as THREE from 'three';
import { bounds } from '../../core/geometry';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { buildScene } from '../export/glb';
import { isBlankFrame } from './prompt';

export interface Frame { dataUrl: string; width: number; height: number; source: 'live' | 'model' }

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function blank(canvas: HTMLCanvasElement): boolean {
  const w = Math.min(64, canvas.width), h = Math.min(64, canvas.height);
  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const ctx = probe.getContext('2d');
  if (!ctx) return true;
  ctx.drawImage(canvas, 0, 0, w, h);
  return isBlankFrame(ctx.getImageData(0, 0, w, h).data);
}

/** The live canvas rarely keeps its buffer, so read it in the frame right after a forced redraw. */
async function fromLive(): Promise<Frame | null> {
  const canvas = document.querySelector<HTMLCanvasElement>('.pane-3d canvas');
  if (!canvas || !canvas.width || !canvas.height) return null;
  window.dispatchEvent(new Event('resize'));
  await nextFrame();
  await nextFrame();
  try {
    const dataUrl = canvas.toDataURL('image/png');
    if (blank(canvas)) return null;
    return { dataUrl, width: canvas.width, height: canvas.height, source: 'live' };
  } catch { return null; }
}

/** Own offscreen render of the model from a three-quarter view, used when the live canvas cannot be read. */
export function fromModel(model: SpaceModel, furniture: FurnitureItem[], width = 1024, height = 640): Frame {
  const scene = buildScene(model, furniture);
  scene.background = new THREE.Color('#f4f1ec');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x887766, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(4, 8, 3);
  scene.add(sun);
  const pts = model.spaces.flatMap((s) => s.polygon);
  const b = bounds(pts.length ? pts : [{ x: 0, y: 0 }]);
  const cx = b.minX + b.w / 2, cz = b.minY + b.h / 2;
  const span = Math.max(b.w, b.h, 2);
  const cam = new THREE.PerspectiveCamera(50, width / height, 0.05, 200);
  cam.position.set(cx + span * 0.9, model.ceilingM + span * 0.6, cz + span * 1.0);
  cam.lookAt(cx, 0.6, cz);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  gl.setSize(width, height, false);
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.render(scene, cam);
  const dataUrl = canvas.toDataURL('image/png');
  const bad = blank(canvas);
  gl.dispose();
  if (bad) throw new Error('The 3D frame came out empty. Open the 3D view and try again.');
  return { dataUrl, width, height, source: 'model' };
}

export async function captureFrame(model: SpaceModel, furniture: FurnitureItem[]): Promise<Frame> {
  return (await fromLive()) ?? fromModel(model, furniture);
}
