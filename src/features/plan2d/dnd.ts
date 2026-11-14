/** Drag-and-drop payload for a saved custom object ("My objects"). Data = the ObjectSpec id. */
export const SPEC_DND = 'application/x-spacelens-spec';

/** Footprint of the spec being dragged (dataTransfer is unreadable during dragover), for the drop ghost. */
export const specDrag: { current: { id: string; name: string; w: number; d: number } | null } = { current: null };
if (typeof window !== 'undefined') window.addEventListener('dragend', () => { specDrag.current = null; });
