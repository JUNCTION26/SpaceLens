import { Icon } from '../../ui/icons';
import { modelToDxf } from './dxfWrite';
import type { SpaceModel } from '../../core/types';

export function DxfButton({ model, className }: { model: SpaceModel; className?: string }) {
  const download = () => {
    const blob = new Blob([modelToDxf(model)], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${model.name.replace(/[^\w .-]/g, '_') || 'space'}.dxf`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return <button type="button" className={className} onClick={download} title="DXF"><Icon name="ruler" size={18} /><span>DXF</span></button>;
}
