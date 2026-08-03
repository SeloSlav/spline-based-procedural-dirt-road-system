import * as THREE from 'three';
import type { FixedMap } from '../terrain/FixedMap.ts';
import {
  convexPolygonsOverlap2,
  orientedRectCorners2,
  type Point2,
} from '../utils/polygonGeometry.ts';
import type { BuildingRoadConnectionSource } from '../roads/BuildingRoadConnections.ts';
import {
  MAIN_HOUSE_DEPTH,
  MAIN_HOUSE_WIDTH,
  cornersToArray,
  getParcelDividerSegments,
  type BurgageLayoutResult,
  type BurgageZoneCorners,
} from './burgageLayout.ts';
import { createResidenceMesh } from './ResidenceMesh.ts';

const fenceMaterial = new THREE.MeshStandardMaterial({ color: 0x69503b, roughness: 0.97 });
const fenceDarkMaterial = new THREE.MeshStandardMaterial({ color: 0x49382c, roughness: 0.98 });
const FENCE_BAY_LENGTH = 2.35;
const GATE_WIDTH = 1.8;

export type ResidenceZoneState = {
  id: string;
  corners: BurgageZoneCorners;
  layout: BurgageLayoutResult;
  residenceIds: string[];
};

type RuntimeZone = ResidenceZoneState & { group: THREE.Group };

export class ResidenceSystem {
  readonly group = new THREE.Group();
  private readonly map: FixedMap;
  private readonly zones = new Map<string, RuntimeZone>();
  private readonly roadSources = new Map<string, BuildingRoadConnectionSource>();
  private nextZoneId = 1;
  private nextResidenceId = 1;
  private revision = 0;

  constructor(map: FixedMap) {
    this.map = map;
    this.group.name = 'Instant client-side residences';
  }

  getRevision(): number {
    return this.revision;
  }

  getZoneCount(): number {
    return this.zones.size;
  }

  getResidenceCount(): number {
    return this.roadSources.size;
  }

  getZones(): Iterable<ResidenceZoneState> {
    return this.zones.values();
  }

  getRoadConnectionSources(): Iterable<BuildingRoadConnectionSource> {
    return this.roadSources.values();
  }

  getClearancePolygons(): Point2[][] {
    return [...this.zones.values()].map((zone) => cornersToArray(zone.corners));
  }

  validatePlacement(corners: BurgageZoneCorners, layout: BurgageLayoutResult): string | null {
    const polygon = cornersToArray(corners);
    const inset = 6;
    if (polygon.some((point) => (
      point.x < this.map.bounds.minX + inset
      || point.x > this.map.bounds.maxX - inset
      || point.z < this.map.bounds.minZ + inset
      || point.z > this.map.bounds.maxZ - inset
    ))) return 'Residence plots must stay inside the playable map';

    for (const existing of this.zones.values()) {
      if (convexPolygonsOverlap2(polygon, cornersToArray(existing.corners), 0.2)) {
        return 'Residence plots overlap an existing frontage';
      }
    }

    for (const point of samplePolygonGrid(polygon, 2.4)) {
      if (this.map.riverLayout.isWaterAt(point.x, point.z)) {
        return 'Residence plots cannot cross the river';
      }
    }

    for (const residence of layout.residences) {
      const footprint = orientedRectCorners2(
        residence,
        residence.yaw,
        MAIN_HOUSE_WIDTH * 0.5,
        MAIN_HOUSE_DEPTH * 0.5,
      );
      const heights = footprint.map((point) => this.map.getHeightAt(point.x, point.z));
      heights.push(this.map.getHeightAt(residence.x, residence.z));
      if (Math.max(...heights) - Math.min(...heights) > 2.25) {
        return 'Ground is too steep for a residence';
      }
    }
    return null;
  }

  addZone(corners: BurgageZoneCorners, layout: BurgageLayoutResult): ResidenceZoneState {
    const id = `frontage-${this.nextZoneId++}`;
    const group = new THREE.Group();
    group.name = `Residence frontage ${id}`;
    const residenceIds: string[] = [];

    for (const placement of layout.residences) {
      const residenceId = `residence-${this.nextResidenceId++}`;
      const seed = hashSeed(`${id}:${placement.parcelIndex}`);
      const residence = createResidenceMesh(seed);
      const rootY = residenceBaseHeight(this.map, placement.x, placement.z, placement.yaw);
      residence.group.position.set(placement.x, rootY - 0.08, placement.z);
      residence.group.rotation.y = placement.yaw;
      residence.group.userData.residenceId = residenceId;
      group.add(residence.group);
      residenceIds.push(residenceId);
      this.roadSources.set(residenceId, {
        id: residenceId,
        x: placement.x,
        z: placement.z,
        yaw: placement.yaw,
        halfWidth: residence.width * 0.5,
        halfDepth: residence.depth * 0.5,
      });
    }

    addZoneFences(group, this.map, layout);
    this.group.add(group);
    const runtime: RuntimeZone = { id, corners, layout, residenceIds, group };
    this.zones.set(id, runtime);
    this.revision += 1;
    return runtime;
  }

  removeZone(id: string): ResidenceZoneState | null {
    const zone = this.zones.get(id);
    if (!zone) return null;
    this.zones.delete(id);
    for (const residenceId of zone.residenceIds) this.roadSources.delete(residenceId);
    zone.group.removeFromParent();
    disposeGeometries(zone.group);
    this.revision += 1;
    return zone;
  }

  restoreZone(zone: ResidenceZoneState): ResidenceZoneState {
    // Rebuilding from the authoritative corners/layout keeps the renderer free
    // of serialized Three.js objects and is immediate at this showcase scale.
    return this.addZone(zone.corners, zone.layout);
  }

  clear(): void {
    for (const zone of [...this.zones.values()]) this.removeZone(zone.id);
  }
}

function residenceBaseHeight(
  map: FixedMap,
  x: number,
  z: number,
  yaw: number,
): number {
  const footprint = orientedRectCorners2(
    { x, z },
    yaw,
    MAIN_HOUSE_WIDTH * 0.42,
    MAIN_HOUSE_DEPTH * 0.42,
  );
  const heights = footprint.map((point) => map.getHeightAt(point.x, point.z));
  heights.push(map.getHeightAt(x, z));
  return heights.reduce((sum, value) => sum + value, 0) / heights.length;
}

function addZoneFences(group: THREE.Group, map: FixedMap, layout: BurgageLayoutResult): void {
  const fence = new THREE.Group();
  fence.name = 'Burgage frontage and parcel fencing';
  group.add(fence);

  const segments: Array<[Point2, Point2]> = [];
  for (const parcel of layout.parcels) {
    const frontMid = midpoint(parcel.frontLeft, parcel.frontRight);
    segments.push(...splitAroundGate(parcel.frontLeft, parcel.frontRight, frontMid, GATE_WIDTH));
  }
  const first = layout.parcels[0];
  const last = layout.parcels.at(-1);
  if (first && last) {
    segments.push([first.rearLeft, last.rearRight]);
    segments.push([first.frontLeft, first.rearLeft]);
    segments.push([last.frontRight, last.rearRight]);
  }
  segments.push(...getParcelDividerSegments(layout));

  const seen = new Set<string>();
  for (const [start, end] of segments) {
    const key = segmentKey(start, end);
    if (seen.has(key)) continue;
    seen.add(key);
    addFenceRun(fence, map, start, end);
  }

  for (const parcel of layout.parcels) {
    const center = midpoint(parcel.frontLeft, parcel.frontRight);
    const direction = normalize({
      x: parcel.frontRight.x - parcel.frontLeft.x,
      z: parcel.frontRight.z - parcel.frontLeft.z,
    });
    const yaw = Math.atan2(direction.x, direction.z);
    for (const side of [-1, 1]) {
      const x = center.x + direction.x * side * GATE_WIDTH * 0.5;
      const z = center.z + direction.z * side * GATE_WIDTH * 0.5;
      addFencePost(fence, map, x, z, 1.38, 0.14);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(GATE_WIDTH + 0.45, 0.13, 0.15), fenceDarkMaterial);
    lintel.position.set(center.x, map.getHeightAt(center.x, center.z) + 1.28, center.z);
    lintel.rotation.y = yaw;
    lintel.castShadow = true;
    fence.add(lintel);
  }
}

function addFenceRun(group: THREE.Group, map: FixedMap, start: Point2, end: Point2): void {
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  if (length < 0.35) return;
  const bays = Math.max(1, Math.ceil(length / FENCE_BAY_LENGTH));
  for (let index = 0; index < bays; index += 1) {
    const a = lerp(start, end, index / bays);
    const b = lerp(start, end, (index + 1) / bays);
    if (index === 0) addFencePost(group, map, a.x, a.z);
    addFencePost(group, map, b.x, b.z);
    const mid = midpoint(a, b);
    const bayLength = Math.hypot(b.x - a.x, b.z - a.z);
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    for (const railY of [0.54, 0.98]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, bayLength + 0.08), fenceMaterial);
      rail.position.set(mid.x, map.getHeightAt(mid.x, mid.z) + railY, mid.z);
      rail.rotation.y = yaw;
      rail.castShadow = true;
      rail.receiveShadow = true;
      group.add(rail);
    }
  }
}

function addFencePost(
  group: THREE.Group,
  map: FixedMap,
  x: number,
  z: number,
  height = 1.18,
  radius = 0.105,
): void {
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.82, radius, height, 6),
    fenceDarkMaterial,
  );
  post.position.set(x, map.getHeightAt(x, z) + height * 0.5, z);
  post.rotation.y = hashSeed(`${x.toFixed(2)}:${z.toFixed(2)}`) * 0.00001;
  post.castShadow = true;
  group.add(post);
}

function splitAroundGate(
  start: Point2,
  end: Point2,
  center: Point2,
  width: number,
): Array<[Point2, Point2]> {
  const direction = normalize({ x: end.x - start.x, z: end.z - start.z });
  const gapStart = { x: center.x - direction.x * width * 0.5, z: center.z - direction.z * width * 0.5 };
  const gapEnd = { x: center.x + direction.x * width * 0.5, z: center.z + direction.z * width * 0.5 };
  return [[start, gapStart], [gapEnd, end]];
}

function samplePolygonGrid(polygon: Point2[], spacing: number): Point2[] {
  const minX = Math.min(...polygon.map((point) => point.x));
  const maxX = Math.max(...polygon.map((point) => point.x));
  const minZ = Math.min(...polygon.map((point) => point.z));
  const maxZ = Math.max(...polygon.map((point) => point.z));
  const samples = [...polygon];
  for (let x = minX; x <= maxX; x += spacing) {
    for (let z = minZ; z <= maxZ; z += spacing) {
      if (pointInPolygon({ x, z }, polygon)) samples.push({ x, z });
    }
  }
  return samples;
}

function pointInPolygon(point: Point2, polygon: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = (a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z + 1e-9) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function disposeGeometries(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
}

function normalize(point: Point2): Point2 {
  const length = Math.hypot(point.x, point.z);
  return length <= 1e-6 ? { x: 1, z: 0 } : { x: point.x / length, z: point.z / length };
}

function midpoint(a: Point2, b: Point2): Point2 {
  return { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
}

function lerp(a: Point2, b: Point2, t: number): Point2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

function segmentKey(a: Point2, b: Point2): string {
  const left = `${a.x.toFixed(2)},${a.z.toFixed(2)}`;
  const right = `${b.x.toFixed(2)},${b.z.toFixed(2)}`;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function hashSeed(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
