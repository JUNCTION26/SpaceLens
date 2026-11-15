import { Icon } from '../../ui/icons';
import { modelToIfc } from './ifcWrite';
import type { SpaceModel } from '../../core/types';

export function IfcButton({ model, className }: { model: SpaceModel; className?: string }) {
  const download = () => {
    const blob = new Blob([modelToIfc(model)], { type: 'application/x-step' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${model.name.replace(/[^\w .-]/g, '_') || 'space'}.ifc`;
    a.click();
    // Revoked a moment later: some browsers read the blob after click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  return <button type="button" className={className} onClick={download} title="IFC"><Icon name="cube" size={18} /><span>IFC</span></button>;
}
