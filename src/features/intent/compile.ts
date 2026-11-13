import type { Requirements, SpaceModel } from '../../core/types';

export async function compileIntent(text: string, model: SpaceModel): Promise<Requirements> {
  return { purpose: text, people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.9, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' };
}
