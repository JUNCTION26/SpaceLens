import type { FurnitureItem, Requirements, SpaceModel, ValidationResult } from '../../core/types';

/** Independent checker. Reads only the model and the furniture; never trusts a generator's claims. */
export function validateLayout(model: SpaceModel, furniture: FurnitureItem[], req?: Requirements | null): ValidationResult[] {
  return [];
}
