import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BuildingAccessSpurs, planBuildingAccessSpurs } from '../src/roads/BuildingAccessSpurs.ts';
import { RoadJunctionBuilder } from '../src/roads/RoadJunctionBuilder.ts';
import { RoadMeshBuilder } from '../src/roads/RoadMeshBuilder.ts';
import { RoadNetwork } from '../src/roads/RoadNetwork.ts';
import {
  BUILDING_ACCESS_SPUR_WIDTH,
  ROAD_VISUAL_WIDTH_SCALE,
  ROAD_WIDTH,
  roadCoreMaximumHalfWidth,
  roadVisualWidth,
} from '../src/roads/roadDimensions.ts';

const terrain = {
  playableSize: 400,
  size: 400,
  mesh: new THREE.Mesh(),
  getHeightAt: () => 0,
  getPointAt: (x: number, z: number, offset = 0) => new THREE.Vector3(x, offset, z),
  getPointAtInto: (x: number, z: number, target: THREE.Vector3, offset = 0) => (
    target.set(x, offset, z)
  ),
  setDirtZoomGate: () => undefined,
};
const materials = {
  road: new THREE.MeshBasicMaterial(),
  roadEdge: new THREE.MeshBasicMaterial({ transparent: true }),
  bridgeSupport: new THREE.MeshBasicMaterial(),
  previewValid: new THREE.MeshBasicMaterial(),
  previewInvalid: new THREE.MeshBasicMaterial(),
  previewBlendValid: new THREE.MeshBasicMaterial({ transparent: true }),
  previewBlendInvalid: new THREE.MeshBasicMaterial({ transparent: true }),
  selection: new THREE.MeshBasicMaterial(),
};

assert.equal(roadVisualWidth(ROAD_WIDTH), ROAD_WIDTH * ROAD_VISUAL_WIDTH_SCALE);
assert(BUILDING_ACCESS_SPUR_WIDTH < roadVisualWidth(ROAD_WIDTH) * 0.5);

const rotatedCorner = new RoadNetwork();
const directions = [17, 137].map((degrees) => {
  const radians = THREE.MathUtils.degToRad(degrees);
  return new THREE.Vector3(Math.cos(radians), 0, Math.sin(radians));
});
for (const direction of directions) {
  rotatedCorner.addRoadPath([
    terrain.getPointAt(0, 0),
    terrain.getPointAt(direction.x * 18, direction.z * 18),
  ]);
}
const bendNode = [...rotatedCorner.nodes.values()].find((node) => (
  rotatedCorner.getNodeDegree(node) === 2
));
assert(bendNode);
assert.equal(rotatedCorner.getIncidents(bendNode).length, 2);
const patch = new RoadJunctionBuilder(terrain as never, materials as never)
  .build(rotatedCorner)
  .getObjectByName(`Road bend ${bendNode.id}`) as THREE.Group | undefined;
assert(patch);
const boundary = (patch.children[1] as THREE.Mesh).userData.junctionBoundary as [number, number][];
assert(boundary.length >= 72);
const visualWidth = roadVisualWidth(ROAD_WIDTH);
const maximumHalfWidth = roadCoreMaximumHalfWidth(visualWidth);
const reach = visualWidth * 0.78;
for (const direction of directions) {
  const perpendicular = new THREE.Vector2(-direction.z, direction.x);
  for (const side of [-1, 1]) {
    for (const along of [0, reach * 0.33, reach * 0.66, reach * 0.98]) {
      const sample = new THREE.Vector2(direction.x, direction.z)
        .multiplyScalar(along)
        .addScaledVector(perpendicular, maximumHalfWidth * side);
      assert(pointInsidePolygon(sample, boundary), 'rotated junction left a road-mouth wedge');
    }
  }
}

const tightCurveNetwork = new RoadNetwork();
const [tightEdgeId] = tightCurveNetwork.addRoadPath([
  terrain.getPointAt(-14, 0),
  terrain.getPointAt(0, 11),
  terrain.getPointAt(14, 0),
]);
assert(tightEdgeId);
const tightEdge = tightCurveNetwork.edges.get(tightEdgeId);
assert(tightEdge);
const meshBuilder = new RoadMeshBuilder(terrain as never, materials as never);
const tightRoad = meshBuilder.buildEdge(tightEdge, tightCurveNetwork);
assert.equal(tightRoad.userData.logicalWidth, ROAD_WIDTH);
assert.equal(tightRoad.userData.visualWidth, visualWidth);
const tightCore = tightRoad.getObjectByName(`Road core ${tightEdge.id}`) as THREE.Mesh;
assert(tightCore);
assertUpwardTriangles(tightCore.geometry);
const tightBlend = tightRoad.getObjectByName(`Road edge blend ${tightEdge.id}`) as THREE.Mesh;
assert(tightBlend.geometry.getAttribute('edgeFade'));
assertUpwardTriangles(tightBlend.geometry);

const accessNetwork = new RoadNetwork();
accessNetwork.addRoadPath([terrain.getPointAt(-30, 0), terrain.getPointAt(30, 0)]);
const residence = {
  id: 'residence-test',
  x: 0,
  z: 11,
  yaw: 0,
  halfWidth: 3.3,
  halfDepth: 3.7,
};
const [spurPlan] = planBuildingAccessSpurs([residence], terrain, accessNetwork);
assert(spurPlan);
assert.equal(spurPlan.visualWidth, BUILDING_ACCESS_SPUR_WIDTH);
assert(spurPlan.connection.point.z < residence.z);
assert.equal(spurPlan.roadPoint.z, 0);
const spurParent = new THREE.Group();
const accessSpurs = new BuildingAccessSpurs({
  parent: spurParent,
  terrain: terrain as never,
  meshBuilder,
});
accessSpurs.sync([residence], accessNetwork);
assert.equal(accessSpurs.group.children.length, 1);
assert.equal(accessSpurs.group.children[0].userData.buildingId, residence.id);

console.log('Road migration regressions passed.');

function pointInsidePolygon(point: THREE.Vector2, polygon: readonly [number, number][]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [x, y] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    if (
      (y > point.y) !== (previousY > point.y)
      && point.x < (previousX - x) * (point.y - y) / (previousY - y) + x
    ) inside = !inside;
  }
  return inside;
}

function assertUpwardTriangles(geometry: THREE.BufferGeometry): void {
  const positions = geometry.getAttribute('position');
  const indices = geometry.getIndex();
  assert(indices);
  for (let offset = 0; offset < indices.count; offset += 3) {
    const a = indices.getX(offset);
    const b = indices.getX(offset + 1);
    const c = indices.getX(offset + 2);
    const areaY = (positions.getZ(b) - positions.getZ(a)) * (positions.getX(c) - positions.getX(a))
      - (positions.getX(b) - positions.getX(a)) * (positions.getZ(c) - positions.getZ(a));
    assert(areaY >= -1e-5, 'road triangle turned downward in XZ');
  }
}
