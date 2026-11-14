import { ContactShadows, Html, Line, OrbitControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ObjectSpec } from '../../core/types';
import { GeneratedMesh } from './GeneratedMesh';

const cm = (m: number) => `${Math.round(m * 100)}`;

/** Keeps the whole object in view as it grows. */
function Frame({ size }: { size: ObjectSpec['size'] }) {
  const { camera } = useThree();
  const r = Math.max(size.w, size.d, size.h, 0.3);
  useEffect(() => {
    const dist = r * 2.1 + 0.4;
    camera.position.set(dist * 0.75, size.h * 0.6 + dist * 0.45, dist * 0.95);
    camera.lookAt(0, size.h / 2, 0);
    camera.updateProjectionMatrix();
  }, [camera, r, size.h]);
  return null;
}

/** W, D and H measured along the object's edges. */
function Callouts({ size }: { size: ObjectSpec['size'] }) {
  const { w, d, h } = size;
  const o = Math.max(0.04, Math.max(w, d, h) * 0.06);
  const col = '#8b8b93';
  const label = (text: string) => <div className="forge-callout">{text}</div>;
  return (
    <group>
      <Line points={[[-w / 2, 0, d / 2 + o], [w / 2, 0, d / 2 + o]]} color={col} lineWidth={1} />
      <Html position={[0, 0, d / 2 + o * 2]} center>{label(`W ${cm(w)}`)}</Html>
      <Line points={[[w / 2 + o, 0, -d / 2], [w / 2 + o, 0, d / 2]]} color={col} lineWidth={1} />
      <Html position={[w / 2 + o * 2, 0, 0]} center>{label(`D ${cm(d)}`)}</Html>
      <Line points={[[-w / 2 - o, 0, d / 2], [-w / 2 - o, h, d / 2]]} color={col} lineWidth={1} />
      <Html position={[-w / 2 - o * 2, h / 2, d / 2]} center>{label(`H ${cm(h)}`)}</Html>
    </group>
  );
}

/** Small turntable view of an object, assembling while it streams. */
export function ForgePreview({ spec, assembling, open }: { spec: ObjectSpec | null; assembling: boolean; open?: boolean }) {
  // Animate the open state 0..1 over about half a second.
  const [openT, setOpenT] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    const target = open ? 1 : 0;
    const t0 = performance.now(), from = openT;
    cancelAnimationFrame(raf.current);
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / 600), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      setOpenT(from + (target - from) * e);
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const size = spec?.size ?? { w: 1, d: 0.6, h: 0.75 };
  const shadow = useMemo(() => Math.max(size.w, size.d) * 2 + 0.6, [size.w, size.d]);
  return (
    <div className="forge-preview" aria-label={spec ? `3D preview of ${spec.name}` : 'Preview'}>
      <Canvas dpr={[1, 2]} camera={{ fov: 32, near: 0.05, far: 60 }} gl={{ antialias: true, preserveDrawingBuffer: false }}>
        <Frame size={size} />
        <hemisphereLight args={['#ffffff', '#8a8580', 0.9]} />
        <directionalLight position={[3, 5, 4]} intensity={1.6} />
        <directionalLight position={[-4, 3, -2]} intensity={0.45} />
        {spec && <GeneratedMesh spec={spec} assembling={assembling} open={openT} />}
        {spec && !assembling && <Callouts size={spec.size} />}
        <ContactShadows position={[0, 0.001, 0]} scale={shadow} blur={2.4} opacity={0.45} far={Math.max(1, size.h)} resolution={512} />
        <OrbitControls target={[0, size.h / 2, 0]} autoRotate autoRotateSpeed={assembling ? 2.2 : 0.9} enablePan={false} enableDamping makeDefault minDistance={0.3} maxDistance={20} />
      </Canvas>
    </div>
  );
}
