// Room purposes that need water. Kept free of other imports so the planner can run in a worker.
export const WET_PURPOSES = new Set(['bathroom', 'wc', 'utility', 'kitchen', 'shower', 'laundry']);
export const isWet = (r: { purpose: string }) => WET_PURPOSES.has(r.purpose);
