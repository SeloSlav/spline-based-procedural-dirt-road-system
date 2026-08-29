import { GRASS_BLADE_REVEAL } from '../grass/grassLodMath.ts';

/** Forest-floor dressing shares the reference grass-detail boundary. */
export const FOREST_GROUND_SHOW_DISTANCE = GRASS_BLADE_REVEAL.far;
export const FOREST_GROUND_HIDE_DISTANCE = GRASS_BLADE_REVEAL.far + 8;

export function shouldShowForestGroundDetail(
  currentlyVisible: boolean,
  cameraDistance: number,
  firstPersonActive: boolean,
): boolean {
  if (firstPersonActive) return true;
  const threshold = currentlyVisible
    ? FOREST_GROUND_HIDE_DISTANCE
    : FOREST_GROUND_SHOW_DISTANCE;
  return Number.isFinite(cameraDistance) && cameraDistance <= threshold;
}
