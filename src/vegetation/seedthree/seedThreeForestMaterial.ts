import type * as THREE from 'three';
import { float, uniform } from 'three/tsl';

/** Forest foliage is diffuse/transmissive; a sun-driven glossy lobe reads as shimmer. */
export const SEEDTHREE_FOREST_CARD_SPECULAR_INTENSITY = 0;

export type SeedThreeForestCardMotion = 'full' | 'sway' | 'static';

/**
 * Overview cards are a screen-space representation, not readable branch motion.
 * Keeping them fixed removes temporal alpha shimmer while the detailed near
 * cards continue to move normally.
 */
export const SEEDTHREE_OVERVIEW_CARD_MOTION: SeedThreeForestCardMotion = 'static';

export function resolveSeedThreeForestCardMotion(
  overview: boolean,
  crownUnderlay: boolean,
): SeedThreeForestCardMotion {
  if (overview) return SEEDTHREE_OVERVIEW_CARD_MOTION;
  // A crown underlay is a crossed pair. Per-plane flutter separates the pair
  // at its shared seam, so it may sway only as one rigid crown.
  if (crownUnderlay) return 'sway';
  return 'full';
}

type SeedThreePositionNodeMaterial = THREE.Material & {
  positionNode?: unknown;
};

type TslNode = {
  mul(value: unknown): TslNode;
};

type SeedThreeOpacityNodeMaterial = THREE.Material & {
  opacityNode?: TslNode | null;
};

const overviewBillboardFadeOpacity = uniform(0) as { value: number } & TslNode;

/**
 * Dissolve overview cards through their authored alpha cutout. Alpha hashing
 * changes its sub-pixel pattern as the camera moves and reads as whole-tree
 * flicker; alpha-to-coverage keeps the transition stable under the renderer's
 * MSAA while preserving depth writes for crossed foliage planes.
 */
export function applySeedThreeOverviewBillboardFade(
  material: THREE.Material,
): THREE.Material {
  if (material.userData.seedThreeOverviewBillboardFade === true) return material;
  const target = material as SeedThreeOpacityNodeMaterial;
  const baseOpacity = target.opacityNode ?? (float(1) as TslNode);
  target.opacityNode = baseOpacity.mul(overviewBillboardFadeOpacity);
  material.alphaHash = false;
  material.alphaToCoverage = material.alphaTest > 0;
  // Bark has no alpha cutout to dissolve through, so it needs conventional
  // opacity. Foliage stays opaque/A2C to avoid crossed-plane sorting halos.
  material.transparent = material.alphaTest <= 0;
  material.depthWrite = true;
  material.userData.seedThreeOverviewBillboardFade = true;
  material.needsUpdate = true;
  return material;
}

/** Clone the cached forest bark material so fading overview branches cannot fade near trees. */
export function createSeedThreeOverviewBarkFadeMaterial(
  source: THREE.Material,
): THREE.Material {
  const material = source.clone();
  // NodeMaterial.clone() omits these standard texture/node properties in the
  // current Three WebGPU path, so restore the complete forest-bark recipe.
  for (const property of [
    'map',
    'normalMap',
    'roughnessMap',
    'colorNode',
    'normalNode',
    'roughnessNode',
    'metalnessNode',
    'positionNode',
  ]) {
    const value = Reflect.get(source, property);
    if (value !== undefined) Reflect.set(material, property, value);
  }
  material.userData.seedThreeOwnedOverviewFadeMaterial = true;
  return applySeedThreeOverviewBillboardFade(material);
}

export function setSeedThreeOverviewBillboardFadeOpacity(opacity: number): void {
  overviewBillboardFadeOpacity.value = Math.max(
    0,
    Math.min(1, Number.isFinite(opacity) ? opacity : 0),
  );
}

/**
 * Override only the card-position node after SeedThree has built its forest
 * material. Near detail keeps the normal forest node, crown underlays reuse
 * their bake-authored rigid-sway node, and overview cards stay fixed.
 */
export function applySeedThreeForestCardMotion(
  material: THREE.Material,
  motion: SeedThreeForestCardMotion,
  sourceMaterial?: THREE.Material,
): THREE.Material {
  if (motion === 'full') return material;
  const target = material as SeedThreePositionNodeMaterial;
  const nextPositionNode = motion === 'static'
    ? null
    : (sourceMaterial as SeedThreePositionNodeMaterial | undefined)?.positionNode ?? null;
  if (target.positionNode !== nextPositionNode) {
    target.positionNode = nextPositionNode;
    material.needsUpdate = true;
  }
  material.userData.seedThreeForestCardMotion = motion;
  return material;
}

/**
 * Stabilize animated forest cards against alpha-edge and sun-specular shimmer.
 *
 * Without this, sub-pixel leaves switch between fully drawn and fully discarded
 * as a walking camera moves. Physical foliage also inherits a glossy specular
 * lobe which flashes under the daytime directional light as wind changes its
 * normals, even at maximum roughness.
 */
export function stabilizeSeedThreeForestCardMaterial(
  material: THREE.Material,
): THREE.Material {
  const physicalMaterial = material as THREE.Material & { specularIntensity?: number };
  let changed = false;
  if (!material.alphaToCoverage) {
    material.alphaToCoverage = true;
    changed = true;
  }
  if (
    typeof physicalMaterial.specularIntensity === 'number'
    && physicalMaterial.specularIntensity !== SEEDTHREE_FOREST_CARD_SPECULAR_INTENSITY
  ) {
    // Preserve diffuse light, shadows, and SSS while removing moving sun glints.
    physicalMaterial.specularIntensity = SEEDTHREE_FOREST_CARD_SPECULAR_INTENSITY;
    changed = true;
  }
  // Shared prototype materials may already have a compiled pipeline.
  if (changed) material.needsUpdate = true;
  return material;
}
