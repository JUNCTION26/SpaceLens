import { modelToIfc } from './ifcWrite';
import type { SpaceModel } from '../../core/types';

export function IfcButton({ model }: { model: SpaceModel }) {
  const download = () => {
    const blob = new Blob([modelToIfc(model)], { type: 'application/x-step' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${model.name.replace(/[^\w .-]/g, '_') || 'space'}.ifc`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return <button type="button" onClick={download}>Download IFC</button>;
}
