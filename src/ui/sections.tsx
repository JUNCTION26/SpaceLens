import { lazy, type ComponentType } from 'react';

type Loader = () => Promise<Record<string, unknown>>;

/**
 * Optional sections and canvas pieces that live in their own feature folders.
 * import.meta.glob resolves to an empty map when a file is absent, so a section shows up
 * in the sidebar only once its panel exists.
 */
const files = import.meta.glob([
  '../features/forge/ForgePanel.tsx',
  '../features/stores/StorePanel.tsx',
  '../features/building/BuildingPanel.tsx',
  '../features/safety/SafetyPanel.tsx',
  '../features/agent/AgentDock.tsx',
]) as Record<string, Loader>;

function optional(path: string, name: string): ComponentType | null {
  const load = files[path];
  if (!load) return null;
  return lazy(() => load().then((m) => ({ default: (m[name] ?? m.default) as ComponentType })));
}

export const OPTIONAL_PANELS: Record<string, ComponentType | null> = {
  create: optional('../features/forge/ForgePanel.tsx', 'ForgePanel'),
  shop: optional('../features/stores/StorePanel.tsx', 'StorePanel'),
  building: optional('../features/building/BuildingPanel.tsx', 'BuildingPanel'),
  safety: optional('../features/safety/SafetyPanel.tsx', 'SafetyPanel'),
};

export const AgentDock = optional('../features/agent/AgentDock.tsx', 'AgentDock') as ComponentType<{ overlay?: boolean }> | null;
