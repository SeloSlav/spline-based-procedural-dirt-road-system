import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createDryStoneWallPlan,
  DRY_STONE_WALL_SHOULDER_CLEARANCE,
} from '../src/decorations/DryStoneWall.ts';
import { createDryStoneWallMaterials } from '../src/decorations/DryStoneWallMaterial.ts';
import { createChippedStoneGeometry } from '../src/decorations/DryStoneWallRenderer.ts';
import {
  alignSecondWallAnchorParallel,
  findDryStoneWallRoadSnap,
  isDryStoneWallStoneClearOfRoads,
} from '../src/decorations/DryStoneWallRoadSnap.ts';
import { RoadNetwork } from '../src/roads/RoadNetwork.ts';
import { ROAD_WIDTH, roadVisualWidth } from '../src/roads/roadDimensions.ts';

const terrain = {
  getHeightAt: (x: number, z: number) => Math.sin(x * 0.025) * 0.12 + Math.cos(z * 0.03) * 0.08,
};
const network = new RoadNetwork();
network.addRoadPath([
  new THREE.Vector3(-30, terrain.getHeightAt(-30, 0), 0),
  new THREE.Vector3(30, terrain.getHeightAt(30, 0), 0),
], ROAD_WIDTH);

const roadside = findDryStoneWallRoadSnap(
  network,
  terrain,
  new THREE.Vector3(0, 0, 5),
);
assert(roadside);
const expectedShoulder = roadVisualWidth(ROAD_WIDTH) * 0.5 + DRY_STONE_WALL_SHOULDER_CLEARANCE;
assert(Math.abs(Math.abs(roadside.point.z) - expectedShoulder) < 0.001);
assert(Math.abs(roadside.tangent.dot(new THREE.Vector3(1, 0, 0))) > 0.999);

const aligned = alignSecondWallAnchorParallel(
  roadside.point,
  roadside.tangent,
  new THREE.Vector3(18, 0, 11),
  terrain,
);
assert(Math.abs(aligned.z - roadside.point.z) < 0.001);
assert(aligned.x > roadside.point.x);

const wallId = network.addDryStoneWallPath([
  new THREE.Vector3(-20, terrain.getHeightAt(-20, expectedShoulder), expectedShoulder),
  new THREE.Vector3(0, terrain.getHeightAt(0, expectedShoulder), expectedShoulder),
  new THREE.Vector3(20, terrain.getHeightAt(20, expectedShoulder), expectedShoulder),
]);
assert(wallId);
const wall = network.dryStoneWalls.get(wallId);
assert(wall);
const planA = createDryStoneWallPlan(
  wall,
  terrain,
  'final',
  (stone) => isDryStoneWallStoneClearOfRoads(network, stone),
);
const planB = createDryStoneWallPlan(
  wall,
  terrain,
  'final',
  (stone) => isDryStoneWallStoneClearOfRoads(network, stone),
);
assert.deepEqual(planA, planB, 'wall plan must be deterministic for a saved seed and path');
assert(planA.stones.length > 35);
assert(planA.diagnostics.courseCounts[0] > 0 && planA.diagnostics.courseCounts[1] > 0);
assert(planA.diagnostics.variantCounts.filter((count) => count > 0).length >= 8);
assert.equal(planA.diagnostics.omittedStoneCount, 0);
assert.equal(planA.diagnostics.approximateHeight, 1.18);

const crossingWall = {
  ...wall,
  id: 'overlap-regression',
  sampledPath: [[-10, 0, 0], [10, 0, 0]] as Array<[number, number, number]>,
  controlPoints: [[-10, 0, 0], [10, 0, 0]] as Array<[number, number, number]>,
  length: 20,
};
const overlapPlan = createDryStoneWallPlan(
  crossingWall,
  terrain,
  'final',
  (stone) => isDryStoneWallStoneClearOfRoads(network, stone),
);
assert.equal(overlapPlan.stones.length, 0);
assert(overlapPlan.diagnostics.omittedStoneCount > 0);

for (const variant of [0, 5, 11]) {
  const geometry = createChippedStoneGeometry(variant);
  assert(geometry.getAttribute('position').count > 40);
  assert(geometry.getAttribute('normal'));
  assert.equal(geometry.userData.dryStoneVariant, variant);
  assert.equal(geometry.userData.triangleCount, geometry.getAttribute('position').count / 3);
  geometry.dispose();
}

const materialSet = createDryStoneWallMaterials();
assert.equal(materialSet.stone.userData.dryStoneWallSurface.textureOwnership, 'dedicated-generated-pbr');
assert.equal(materialSet.stone.roughness, 0.95);
materialSet.dispose();

const snapshot = network.snapshot();
assert.equal(snapshot.dryStoneWalls?.length, 1);
assert(network.deleteDryStoneWall(wallId));
assert.equal(network.dryStoneWalls.size, 0);
network.restore(snapshot);
assert.equal(network.dryStoneWalls.size, 1);
assert.deepEqual(network.snapshot().dryStoneWalls, snapshot.dryStoneWalls);
const nextWallId = network.addDryStoneWallPath([
  new THREE.Vector3(-12, 0, -expectedShoulder),
  new THREE.Vector3(12, 0, -expectedShoulder),
]);
assert(nextWallId && nextWallId !== wallId, 'restored wall IDs must continue monotonically');

console.log('Dry-stone wall regressions passed.');
