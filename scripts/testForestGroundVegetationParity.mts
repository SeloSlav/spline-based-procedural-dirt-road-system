import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FOREST_GROUND_HIDE_DISTANCE,
  FOREST_GROUND_SHOW_DISTANCE,
  shouldShowForestGroundDetail,
} from '../src/props/forestGroundLod.ts';
import { createForestFloorPlacementMask } from '../src/props/ForestFloorPlacementMask.ts';
import {
  createForestCores,
  createForestSpawnConfig,
  forestDensityAt,
  mulberry32,
} from '../src/props/forestField.ts';
import {
  COMMON_DOGWOOD_VARIANTS,
  createCommonDogwoodVariantPreset,
} from '../src/vegetation/seedthree/commonDogwoodPreset.ts';
import {
  GORSKI_SHRUB_TERMINAL_TAPER_START,
  GORSKI_SHRUB_TERMINAL_TIP_RADIUS_SCALE,
  createGorskiShrubPrototype,
  type GorskiShrubKind,
} from '../src/vegetation/seedthree/gorskiShrubPrototypes.ts';
import { stingingNettle } from '../src/vegetation/seedthree/stingingNettlePreset.ts';

const TREE_SEED = 0x5eedf0a5;
const TERRAIN_SIZE = 408.5;
const EXPECTED_ASSET_FINGERPRINT =
  'd11d807d2833de2fb40268ed6283baed72ac6bdeeb48e824ba18d0b00018578d';

assert.equal(FOREST_GROUND_SHOW_DISTANCE, 44);
assert.equal(FOREST_GROUND_HIDE_DISTANCE, 52);
assert.equal(shouldShowForestGroundDetail(false, 44, false), true);
assert.equal(shouldShowForestGroundDetail(false, 44.01, false), false);
assert.equal(shouldShowForestGroundDetail(true, 51.99, false), true);
assert.equal(shouldShowForestGroundDetail(true, 52.01, false), false);
assert.equal(shouldShowForestGroundDetail(false, 500, true), true);

const spawn = createForestSpawnConfig(TERRAIN_SIZE, TERRAIN_SIZE, 1);
assert.equal(spawn.undergrowthTargetCount, 597);
const coresA = createForestCores(mulberry32(TREE_SEED), spawn);
const coresB = createForestCores(mulberry32(TREE_SEED), spawn);
assert.deepEqual(coresA, coresB, 'forest density cores must be deterministic');
for (const [x, z] of [[0, 0], [72, -94], [-133, 116], [191, -35]] as const) {
  const a = forestDensityAt(x, z, coresA, spawn.extent, spawn.terrainExtent);
  const b = forestDensityAt(x, z, coresB, spawn.extent, spawn.terrainExtent);
  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 1);
}

const maskEvents: Array<[number, boolean]> = [];
const mask = createForestFloorPlacementMask(
  [
    { sourceTreeIndex: 0 },
    { sourceTreeIndex: 0 },
    { sourceTreeIndex: 1 },
  ],
  2,
  (index, visible) => maskEvents.push([index, visible]),
);
assert.equal(mask.setTreeActive(0, false), true);
assert.deepEqual(maskEvents.splice(0), [[0, false], [1, false]]);
assert.equal(mask.setPlacementActive(0, false), true);
assert.deepEqual(maskEvents.splice(0), [], 'already-hidden placement must not emit twice');
assert.equal(mask.setTreeActive(0, true), true);
assert.deepEqual(maskEvents.splice(0), [[1, true]]);
assert.equal(mask.setPlacementActive(0, true), true);
assert.deepEqual(maskEvents.splice(0), [[0, true]]);

assert.deepEqual(COMMON_DOGWOOD_VARIANTS.map((variant) => variant.stemCount), [12, 19, 27]);
assert.equal(createCommonDogwoodVariantPreset(4).variantIndex, 1);
assert.equal(stingingNettle.foliage.whorlSize, 2);
assert.equal(stingingNettle.params.trunks, 1);
assert.equal(GORSKI_SHRUB_TERMINAL_TAPER_START, 0.68);
assert.equal(GORSKI_SHRUB_TERMINAL_TIP_RADIUS_SCALE, 0.04);

for (const kind of ['bush', 'fern', 'juniper', 'dogwood', 'nettle'] as const satisfies readonly GorskiShrubKind[]) {
  const prototype = createGorskiShrubPrototype(kind, 0);
  assert.ok(prototype.triangleCount > 0, `${kind} prototype must have triangles`);
  assert.ok(prototype.geometry.getAttribute('aRootWeight'), `${kind} must use rooted wind`);
  if (kind === 'dogwood') {
    assert.ok(prototype.geometry.getAttribute('aLeafPhase'), 'dogwood leaves need local flutter phase');
    assert.equal(prototype.geometry.userData.dogwoodGroundOriginStemCount, 12);
  }
  prototype.geometry.dispose();
}

const ivySource = readFileSync('src/props/ForestFloorIvy.ts', 'utf8');
assert.match(ivySource, /FOREST_FLOOR_IVY_STREAM_RADIUS = 104/);
assert.match(ivySource, /FOREST_FLOOR_IVY_STREAM_REBUILD_DISTANCE = 10/);
assert.match(ivySource, /FOREST_FLOOR_IVY_MAX_RESIDENT_PATCHES = 1_024/);
assert.match(ivySource, /forest-floor-ivy-leaf-atlas-v2\.png/);
const nettleSource = readFileSync('src/props/ForestFloorNettles.ts', 'utf8');
assert.match(nettleSource, /FOREST_FLOOR_NETTLE_STREAM_RADIUS = 104/);
assert.match(nettleSource, /FOREST_FLOOR_NETTLE_COLONY_MIN_STEMS = 5/);
assert.match(nettleSource, /FOREST_FLOOR_NETTLE_COLONY_MAX_STEMS = 9/);
const twigSource = readFileSync('src/props/ForestFloorTwigs.ts', 'utf8');
assert.match(twigSource, /FOREST_FLOOR_TWIG_VARIANT_COUNT/);
assert.match(twigSource, /FOREST_FLOOR_TWIG_TARGETS_PER_TREE = 0\.46/);
const generatorSource = readFileSync(
  'src/vegetation/seedthree/referenceDichotomous.js',
  'utf8',
);
assert.match(generatorSource, /terminalTaperStart/);
assert.match(generatorSource, /terminalTipRadiusScale/);

const assetRoots = [
  'src/assets/vegetation/common-dogwood',
  'src/assets/vegetation/stinging-nettle',
  'src/assets/vegetation/shrubs',
];
const assetFiles: string[] = [];
const collectFiles = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(file);
    else assetFiles.push(file);
  }
};
assetRoots.forEach(collectFiles);
assetFiles.push('public/assets/textures/vegetation/forest-floor-ivy-leaf-atlas-v2.png');
assetFiles.sort();
assert.equal(assetFiles.length, 40);
const assetEntries = assetFiles.map((file) => {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  return `${file.replaceAll('\\', '/')}:${hash}`;
});
const assetFingerprint = createHash('sha256')
  .update(assetEntries.join('\n'))
  .digest('hex');
assert.equal(assetFingerprint, EXPECTED_ASSET_FINGERPRINT);

console.log('Forest-ground vegetation parity checks passed.');
