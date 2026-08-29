import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOSE_GROUND_FADE_START_DISTANCE,
  CLOSE_GROUND_FULL_DISTANCE,
  DIRT_FADE_START_ZOOM_PERCENT,
  FOREST_GRASS_PLACEMENT_CHANCE,
  FOREST_GRASS_RENDER_DENSITY_MULTIPLIER,
  FOREST_WILDFLOWER_PLACEMENT_CHANCE,
  GRASS_TUFTS_PER_CHUNK,
  closeGroundVegetationGate,
  grassBladeLodOpacity,
  grassBladeRevealOpacity,
  grassMicroTuftTargetForForestBlend,
  grassPlacementChanceForForestBlend,
  grassTuftTargetForForestBlend,
  reedRevealOpacity,
  wildflowerPlacementChanceForForestBlend,
} from '../src/grass/grassLodMath.ts';
import { resolveGrassStreamSlotIndex } from '../src/grass/grassStreamLifecycle.ts';
import {
  WILDFLOWER_DETAIL_LOD_ENTER_DISTANCE_METERS,
  WILDFLOWER_DETAIL_LOD_EXIT_DISTANCE_METERS,
  WILDFLOWER_SLOT_CAPACITIES,
  WILDFLOWER_TOTAL_SLOT_CAPACITY,
  resolveWildflowerGeometryLod,
} from '../src/grass/wildflowerStreamBudget.ts';
import {
  REED_MAX_WATERLINE_FRACTION,
  ensureCattailEmergenceHeightMeters,
} from '../src/rivers/RiverReedHeight.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readProjectFile = (path: string): string => readFileSync(resolve(root, path), 'utf8');

assert.equal(DIRT_FADE_START_ZOOM_PERCENT, 200);
assert.equal(CLOSE_GROUND_FADE_START_DISTANCE, 44);
assert.equal(CLOSE_GROUND_FULL_DISTANCE, 22);
assert.equal(closeGroundVegetationGate(CLOSE_GROUND_FADE_START_DISTANCE), 0);
assert.equal(closeGroundVegetationGate(CLOSE_GROUND_FULL_DISTANCE), 1);

for (const distance of [13, 22, 29, 36, 44, 52]) {
  assert.equal(
    reedRevealOpacity(distance),
    grassBladeLodOpacity(grassBladeRevealOpacity(distance)),
    `Cattails and meadow grass must share the same reveal curve at ${distance}m.`,
  );
}

assert.equal(GRASS_TUFTS_PER_CHUNK, 192);
assert.equal(FOREST_GRASS_RENDER_DENSITY_MULTIPLIER, 0);
assert.equal(FOREST_GRASS_PLACEMENT_CHANCE, 0);
assert.equal(FOREST_WILDFLOWER_PLACEMENT_CHANCE, 0);
assert.equal(grassTuftTargetForForestBlend(GRASS_TUFTS_PER_CHUNK, 0), 192);
assert.equal(grassTuftTargetForForestBlend(GRASS_TUFTS_PER_CHUNK, 1), 0);
assert.equal(grassMicroTuftTargetForForestBlend(GRASS_TUFTS_PER_CHUNK, 0), 134);
assert.equal(grassMicroTuftTargetForForestBlend(GRASS_TUFTS_PER_CHUNK, 1), 0);
assert.equal(grassPlacementChanceForForestBlend(0), 1);
assert.equal(grassPlacementChanceForForestBlend(1), 0);
assert.equal(wildflowerPlacementChanceForForestBlend(0), 0.86);
assert.equal(wildflowerPlacementChanceForForestBlend(1), 0);

assert.deepEqual(WILDFLOWER_SLOT_CAPACITIES, [48, 32, 48, 8, 8]);
assert.equal(WILDFLOWER_TOTAL_SLOT_CAPACITY, 144);
assert.equal(WILDFLOWER_DETAIL_LOD_ENTER_DISTANCE_METERS, 10);
assert.equal(WILDFLOWER_DETAIL_LOD_EXIT_DISTANCE_METERS, 14);
assert.equal(resolveWildflowerGeometryLod('footprint', 9.9), 'detail');
assert.equal(resolveWildflowerGeometryLod('footprint', 10.1), 'footprint');
assert.equal(resolveWildflowerGeometryLod('detail', 13.9), 'detail');
assert.equal(resolveWildflowerGeometryLod('detail', 14.1), 'footprint');

const gridSide = 19;
assert.equal(resolveGrassStreamSlotIndex(0, 0, gridSide), 0);
assert.equal(resolveGrassStreamSlotIndex(-1, -1, gridSide), gridSide * gridSide - 1);
assert.equal(
  resolveGrassStreamSlotIndex(5, -7, gridSide),
  resolveGrassStreamSlotIndex(5 + gridSide, -7 - gridSide, gridSide),
);

assert.equal(REED_MAX_WATERLINE_FRACTION, 0.58);
assert.equal(ensureCattailEmergenceHeightMeters(2, 0.8), 2);
assert.ok(ensureCattailEmergenceHeightMeters(0.8, 1.1) >= 1.1 / 0.58);

const grassSource = readProjectFile('src/vegetation/seedthree/seedThreeGrass.ts');
const flowerSource = readProjectFile('src/vegetation/seedthree/seedThreeWildflowers.ts');
assert.match(grassSource, /close-meadow-tuft-greener\.png/);
assert.match(flowerSource, /gorski-kotar-wildflower-atlas-v2\.png/);
assert.match(flowerSource, /id: 'queen-annes-lace'/);
assert.doesNotMatch(flowerSource, /wildflowers\/leaves\//);

for (const asset of [
  'public/assets/textures/vegetation/grass/close-meadow-tuft-greener.png',
  'public/assets/textures/vegetation/wildflowers/gorski-kotar-wildflower-atlas-v2.png',
  'public/assets/textures/vegetation/wildflowers/queen-annes-lace-head.png',
]) {
  assert.equal(existsSync(resolve(root, asset)), true, `${asset} must exist.`);
}

console.log('Grass, flower, and cattail parity regressions passed.');
