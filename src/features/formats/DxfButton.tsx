import { modelToDxf } from './dxfWrite';
import type { SpaceModel } from '../../core/types';

export function DxfButton({ model }: { model: SpaceModel }) {
  const download = () => {
    const blob = new Blob([modelToDxf(model)], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${model.name.replace(/[^\w .-]/g, '_') || 'space'}.dxf`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return <button type="button" onClick={download}>Download DXF</button>;
}
