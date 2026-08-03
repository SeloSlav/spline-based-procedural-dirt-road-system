export const OVERVIEW_BILLBOARD_REMOVE_ZOOM_PERCENT = 100;
export const OVERVIEW_BILLBOARD_REVEAL_ZOOM_PERCENT = 96;
export const OVERVIEW_BILLBOARD_FULL_OPACITY_ZOOM_PERCENT = 70;
export const OVERVIEW_NEAR_REPLACEMENT_SHOW_ZOOM_PERCENT = 72;
export const OVERVIEW_NEAR_REPLACEMENT_HIDE_ZOOM_PERCENT = 68;

const OVERVIEW_BILLBOARD_FADE_IN_HALF_LIFE_SECONDS = 0.14;
const OVERVIEW_BILLBOARD_FADE_OUT_HALF_LIFE_SECONDS = 0.1;
const OVERVIEW_BILLBOARD_HIDDEN_OPACITY = 0.001;

export type SeedThreeOverviewBillboardFadeState = {
  enabled: boolean;
  opacity: number;
};

export type SeedThreeOverviewBillboardFadeResult = SeedThreeOverviewBillboardFadeState & {
  targetOpacity: number;
  visible: boolean;
};

/**
 * Bring the real LOD2 tree in before its overview card starts dissolving.
 * The wider return threshold prevents wheel easing around the start of the
 * crossfade from repeatedly repacking the two instance sets.
 */
export function shouldUseSeedThreeOverviewNearReplacement(
  currentlyActive: boolean,
  zoomPercent: number,
  firstPersonActive = false,
): boolean {
  if (firstPersonActive) return true;
  const safeZoomPercent = Number.isFinite(zoomPercent) ? Math.max(0, zoomPercent) : 100;
  return currentlyActive
    ? safeZoomPercent > OVERVIEW_NEAR_REPLACEMENT_HIDE_ZOOM_PERCENT
    : safeZoomPercent >= OVERVIEW_NEAR_REPLACEMENT_SHOW_ZOOM_PERCENT;
}

function smootherstep01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function dampWithHalfLife(
  current: number,
  target: number,
  deltaSeconds: number,
  halfLifeSeconds: number,
): number {
  if (deltaSeconds <= 0 || current === target) return current;
  const retained = Math.pow(0.5, deltaSeconds / halfLifeSeconds);
  return target + (current - target) * retained;
}

/**
 * Overview tree cards are a strategic-map aid. They disappear at 100% zoom,
 * and cannot re-enter until the camera retreats to 96%, which prevents wheel
 * and camera easing noise from chattering at the cutoff.
 */
export function updateSeedThreeOverviewBillboardFade(
  previous: SeedThreeOverviewBillboardFadeState,
  zoomPercent: number,
  deltaSeconds: number,
  firstPersonActive = false,
): SeedThreeOverviewBillboardFadeResult {
  const safeZoomPercent = Number.isFinite(zoomPercent)
    ? Math.max(0, zoomPercent)
    : OVERVIEW_BILLBOARD_REMOVE_ZOOM_PERCENT;
  let enabled = previous.enabled;
  if (firstPersonActive || safeZoomPercent >= OVERVIEW_BILLBOARD_REMOVE_ZOOM_PERCENT) {
    enabled = false;
  } else if (
    !enabled
    && safeZoomPercent <= OVERVIEW_BILLBOARD_REVEAL_ZOOM_PERCENT
  ) {
    enabled = true;
  }

  const fadeRange = OVERVIEW_BILLBOARD_REMOVE_ZOOM_PERCENT
    - OVERVIEW_BILLBOARD_FULL_OPACITY_ZOOM_PERCENT;
  const zoomFade = smootherstep01(
    (OVERVIEW_BILLBOARD_REMOVE_ZOOM_PERCENT - safeZoomPercent) / fadeRange,
  );
  const targetOpacity = enabled ? zoomFade : 0;
  const currentOpacity = Number.isFinite(previous.opacity)
    ? Math.max(0, Math.min(1, previous.opacity))
    : 0;
  const halfLife = targetOpacity > currentOpacity
    ? OVERVIEW_BILLBOARD_FADE_IN_HALF_LIFE_SECONDS
    : OVERVIEW_BILLBOARD_FADE_OUT_HALF_LIFE_SECONDS;
  let opacity = dampWithHalfLife(
    currentOpacity,
    targetOpacity,
    Math.max(0, Math.min(0.1, deltaSeconds)),
    halfLife,
  );
  if (targetOpacity === 0 && opacity <= OVERVIEW_BILLBOARD_HIDDEN_OPACITY) opacity = 0;
  if (targetOpacity === 1 && opacity >= 1 - OVERVIEW_BILLBOARD_HIDDEN_OPACITY) opacity = 1;

  return {
    enabled,
    opacity,
    targetOpacity,
    visible: enabled || opacity > OVERVIEW_BILLBOARD_HIDDEN_OPACITY,
  };
}
