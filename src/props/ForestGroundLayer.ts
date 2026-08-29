import * as THREE from 'three';
import type { RendererBackendKind } from '../scene/RendererBackend.ts';
import type { Terrain } from '../terrain/Terrain.ts';
import { SpatialHash2D } from '../utils/SpatialHash2D.ts';
import type { ForestTreePlacement } from './forestPlacements.ts';
import {
  createForestCores,
  createForestSpawnConfig,
  forestDensityAt,
  mulberry32,
  type ForestCore,
  type ForestSpawnConfig,
} from './forestField.ts';
import {
  UNDERGROWTH_KINDS,
  buildUndergrowthInstances,
  createUndergrowthMaterials,
  createUndergrowthPlacements,
  disposeUndergrowthInstances,
  markUndergrowthMatricesUpdated,
  undergrowthBucketForPlacement,
  undergrowthPlacementClearanceRadius,
  type UndergrowthInstances,
  type UndergrowthPlacement,
} from './ForestUndergrowth.ts';
import {
  createForestFloorIvyInstances,
  type ForestFloorIvyInstances,
} from './ForestFloorIvy.ts';
import {
  FOREST_FLOOR_NETTLE_SEED,
  FOREST_FLOOR_NETTLE_UNDERGROWTH_CLEAR_RADIUS,
  createForestFloorNettleInstances,
  createForestFloorNettlePlacements,
  type ForestFloorNettleInstances,
} from './ForestFloorNettles.ts';
import {
  createForestFloorTwigInstances,
  type ForestFloorTwigInstances,
} from './ForestFloorTwigs.ts';
import { shouldShowForestGroundDetail } from './forestGroundLod.ts';

const IVY_SEED = 0x1f1c0a7;
const TWIG_SEED = 0x7a193f2d;

export type ForestGroundBlocker = (x: number, z: number) => boolean;

export type ForestGroundLayerStats = {
  forestMaskVertices: number;
  closeDetailVisible: boolean;
  cameraDistance: number;
  undergrowth: UndergrowthInstances['stats'];
  ivy: ForestFloorIvyInstances['stats'];
  nettles: ForestFloorNettleInstances['stats'];
  twigs: ForestFloorTwigInstances['stats'];
};

export type ForestGroundLayer = {
  group: THREE.Group;
  stats: ForestGroundLayerStats;
  updateCamera(
    cameraPosition: Pick<THREE.Vector3, 'x' | 'z'>,
    cameraDistance: number,
    firstPersonActive: boolean,
  ): boolean;
  setTreeActive(treeIndex: number, active: boolean): boolean;
  syncBlockedMask(blocker?: ForestGroundBlocker): number;
  commit(): void;
  dispose(): void;
};

export function installTerrainForestBlendAttribute(
  terrain: Terrain,
  forestCores: readonly ForestCore[],
  spawnConfig: Pick<ForestSpawnConfig, 'extent' | 'terrainExtent'>,
): THREE.BufferAttribute | THREE.InterleavedBufferAttribute {
  const geometry = terrain.mesh.geometry;
  const position = geometry.getAttribute('position');
  let attribute = geometry.getAttribute('forestBlend');
  if (!attribute || attribute.count !== position.count) {
    attribute = new THREE.BufferAttribute(new Float32Array(position.count), 1);
    attribute.setUsage(THREE.StaticDrawUsage);
    geometry.setAttribute('forestBlend', attribute);
  }
  for (let index = 0; index < position.count; index++) {
    attribute.setX(index, forestDensityAt(
      position.getX(index),
      position.getZ(index),
      forestCores as ForestCore[],
      spawnConfig.extent,
      spawnConfig.terrainExtent,
    ));
  }
  attribute.needsUpdate = true;
  geometry.userData.forestBlendSeeded = true;
  return attribute;
}

export async function createForestGroundLayer(
  trees: readonly ForestTreePlacement[],
  terrain: Terrain,
  maxAnisotropy: number,
  rendererBackend: RendererBackendKind,
  seed: number,
  initialBlocker?: ForestGroundBlocker,
): Promise<ForestGroundLayer> {
  const spawnConfig = createForestSpawnConfig(terrain.generationSize, terrain.size, 1);
  const placementRng = mulberry32(seed);
  const forestCores = createForestCores(placementRng, spawnConfig);
  const forestMask = installTerrainForestBlendAttribute(terrain, forestCores, spawnConfig);

  const nettleSeed = seed ^ FOREST_FLOOR_NETTLE_SEED;
  const nettlePlacements = createForestFloorNettlePlacements(
    trees,
    nettleSeed,
    initialBlocker,
  );
  const colonyCenters = new Map<number, { x: number; z: number }>();
  for (const placement of nettlePlacements) {
    if (!colonyCenters.has(placement.colonyIndex)) {
      colonyCenters.set(placement.colonyIndex, {
        x: placement.colonyX,
        z: placement.colonyZ,
      });
    }
  }
  const nettleColonyIndex = new SpatialHash2D(
    FOREST_FLOOR_NETTLE_UNDERGROWTH_CLEAR_RADIUS,
    [...colonyCenters.values()],
  );
  const undergrowthBlocker = (x: number, z: number): boolean => (
    (initialBlocker?.(x, z) ?? false)
    || nettleColonyIndex.hasPointWithin(
      x,
      z,
      FOREST_FLOOR_NETTLE_UNDERGROWTH_CLEAR_RADIUS,
    )
  );
  const undergrowthPlacements = createUndergrowthPlacements(
    placementRng,
    forestCores,
    spawnConfig,
    undergrowthBlocker,
    trees,
  );

  const [
    undergrowthMaterials,
    ivy,
    nettles,
    twigs,
  ] = await Promise.all([
    createUndergrowthMaterials(maxAnisotropy, rendererBackend, []),
    createForestFloorIvyInstances(
      trees,
      terrain,
      maxAnisotropy,
      rendererBackend,
      seed ^ IVY_SEED,
      initialBlocker,
    ),
    createForestFloorNettleInstances(
      trees,
      terrain,
      maxAnisotropy,
      rendererBackend,
      nettleSeed,
      initialBlocker,
      nettlePlacements,
    ),
    createForestFloorTwigInstances(
      trees,
      terrain,
      maxAnisotropy,
      {
        seed: seed ^ TWIG_SEED,
        densityScale: 1,
        isBlockedAt: initialBlocker,
        sharedSeedThreeTextures: rendererBackend === 'webgpu',
      },
    ),
  ]);
  const undergrowth = buildUndergrowthInstances(
    undergrowthPlacements,
    terrain,
    undergrowthMaterials,
    placementRng,
  );

  const group = new THREE.Group();
  group.name = 'Medieval Roads shrub and forest-floor parity layer';
  group.add(undergrowth.group, ivy.group, nettles.group, twigs.group);
  undergrowth.group.visible = false;
  twigs.group.visible = false;
  let closeDetailVisible = false;
  let removedUndergrowth = new Set<number>();
  const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  const commit = (): void => {
    ivy.commit();
    nettles.commit();
    twigs.commit();
  };
  const stats: ForestGroundLayerStats = {
    forestMaskVertices: forestMask.count,
    closeDetailVisible: false,
    cameraDistance: Number.POSITIVE_INFINITY,
    undergrowth: undergrowth.stats,
    ivy: ivy.stats,
    nettles: nettles.stats,
    twigs: twigs.stats,
  };

  return {
    group,
    stats,
    updateCamera(cameraPosition, cameraDistance, firstPersonActive): boolean {
      const visible = shouldShowForestGroundDetail(
        closeDetailVisible,
        cameraDistance,
        firstPersonActive,
      );
      stats.cameraDistance = cameraDistance;
      stats.closeDetailVisible = visible;
      let changed = ivy.updateCamera(cameraPosition, visible);
      changed = nettles.updateCamera(cameraPosition, visible) || changed;
      if (visible !== closeDetailVisible) {
        closeDetailVisible = visible;
        undergrowth.group.visible = visible;
        changed = twigs.setCloseDetailVisible(visible) || changed;
      }
      return changed;
    },
    setTreeActive(treeIndex, active): boolean {
      const ivyChanged = ivy.setTreeActive(treeIndex, active);
      const twigsChanged = twigs.setTreeActive(treeIndex, active);
      return ivyChanged || twigsChanged;
    },
    syncBlockedMask(blocker): number {
      const nextRemoved = new Set<number>();
      for (let index = 0; index < undergrowthPlacements.length; index++) {
        const placement = undergrowthPlacements[index]!;
        if (undergrowthIntersectsBlocker(placement, blocker)) nextRemoved.add(index);
      }
      let changes = 0;
      for (let index = 0; index < undergrowthPlacements.length; index++) {
        const removed = nextRemoved.has(index);
        if (removed === removedUndergrowth.has(index)) continue;
        const placement = undergrowthPlacements[index]!;
        const bucket = undergrowthBucketForPlacement(undergrowth, placement);
        const matrix = removed ? hiddenMatrix : bucket.matrices[placement.meshIndex]!;
        bucket.mesh.setMatrixAt(placement.meshIndex, matrix);
        bucket.shadowMesh.setMatrixAt(placement.meshIndex, matrix);
        changes++;
      }
      if (changes > 0) markUndergrowthMatricesUpdated(undergrowth);
      removedUndergrowth = nextRemoved;
      changes += ivy.refreshBlockedMask(blocker);
      changes += nettles.refreshBlockedMask(blocker);
      changes += twigs.refreshBlockedMask(blocker);
      if (changes > 0) commit();
      return changes;
    },
    commit,
    dispose(): void {
      ivy.dispose();
      nettles.dispose();
      twigs.dispose();
      disposeUndergrowthInstances(undergrowth, undergrowthMaterials);
      group.removeFromParent();
      group.clear();
    },
  };
}

function undergrowthIntersectsBlocker(
  placement: UndergrowthPlacement,
  blocker?: ForestGroundBlocker,
): boolean {
  if (!blocker) return false;
  if (blocker(placement.x, placement.z)) return true;
  const radius = undergrowthPlacementClearanceRadius(placement);
  for (let sampleIndex = 0; sampleIndex < 10; sampleIndex++) {
    const angle = sampleIndex / 10 * Math.PI * 2;
    if (blocker(
      placement.x + Math.cos(angle) * radius,
      placement.z + Math.sin(angle) * radius,
    )) return true;
  }
  return false;
}

export function forestGroundKindCounts(
  placements: readonly UndergrowthPlacement[],
): Record<(typeof UNDERGROWTH_KINDS)[number], number> {
  return Object.fromEntries(
    UNDERGROWTH_KINDS.map((kind) => [
      kind,
      placements.filter((placement) => placement.kind === kind).length,
    ]),
  ) as Record<(typeof UNDERGROWTH_KINDS)[number], number>;
}
