import type { FurnitureItem } from '../../core/types';

export function FurnitureMesh({ item, selected, ghost }: { item: FurnitureItem; selected?: boolean; ghost?: boolean }) {
  return (
    <mesh position={[item.x, item.h / 2, item.y]} rotation={[0, -item.rotation, 0]}>
      <boxGeometry args={[item.w, item.h, item.d]} />
      <meshStandardMaterial color={selected ? '#7cc4ff' : item.color} transparent={ghost} opacity={ghost ? 0.4 : 1} />
    </mesh>
  );
}
