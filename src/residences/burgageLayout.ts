import {
  distancePointToSegment2,
  isConvexQuad2,
  isPointInPolygon2,
  orientedRectCorners2,
  polygonArea2,
  type Point2,
} from '../utils/polygonGeometry.ts';

export type BurgageZoneCorners = {
  a: Point2;
  b: Point2;
  c: Point2;
  d: Point2;
};

export type BurgageFrontageEdge = 0 | 1 | 2 | 3;

export type BurgageParcelLayout = {
  index: number;
  polygon: Point2[];
  frontLeft: Point2;
  frontRight: Point2;
  rearRight: Point2;
  rearLeft: Point2;
  area: number;
};

export type ResidencePlacement = {
  parcelIndex: number;
  x: number;
  z: number;
  yaw: number;
};

export type BurgageLayoutResult = {
  frontageLength: number;
  maxPlotCount: number;
  plotCount: number;
  parcels: BurgageParcelLayout[];
  residences: ResidencePlacement[];
};

export const MIN_PLOT_FRONTAGE = 8;
export const HOUSE_SETBACK = 3.5;
export const MAIN_HOUSE_WIDTH = 6.6;
export const MAIN_HOUSE_DEPTH = 7.4;
/** Breathing room between the cottage wall and an independently placed rear boundary. */
export const HOUSE_REAR_CLEARANCE = 0.5;
export const MIN_ZONE_DEPTH = MAIN_HOUSE_DEPTH + HOUSE_SETBACK + HOUSE_REAR_CLEARANCE;
// The source system supports productive gardens in this strip. This client-only
// showcase deliberately keeps it as an empty rear yard.
export const MAX_ZONE_DEPTH = MAIN_HOUSE_DEPTH + HOUSE_SETBACK + 12;
export const MAX_ROAD_FRONTAGE_DISTANCE = 16;

const EDGE_PAIRS: ReadonlyArray<readonly [keyof BurgageZoneCorners, keyof BurgageZoneCorners]> = [
  ['a', 'b'],
  ['b', 'c'],
  ['c', 'd'],
  ['d', 'a'],
];

export function cornersToArray(corners: BurgageZoneCorners): Point2[] {
  return [corners.a, corners.b, corners.c, corners.d];
}

export function cornersFromPoints(points: readonly Point2[]): BurgageZoneCorners | null {
  if (points.length !== 4) return null;
  return { a: points[0], b: points[1], c: points[2], d: points[3] };
}

export function getZoneEdge(
  corners: BurgageZoneCorners,
  edge: BurgageFrontageEdge,
): [Point2, Point2] {
  const [startKey, endKey] = EDGE_PAIRS[edge];
  return [corners[startKey], corners[endKey]];
}

export function oppositeFrontageEdge(edge: BurgageFrontageEdge): BurgageFrontageEdge {
  return ((edge + 2) % 4) as BurgageFrontageEdge;
}

export function suggestPlotCount(frontageLength: number): number {
  return Math.max(1, Math.floor(frontageLength / MIN_PLOT_FRONTAGE));
}

/** Y rotation so the cottage's local +Z/front door faces back toward the road. */
export function residenceDoorYaw(inward: Point2): number {
  return Math.atan2(-inward.x, -inward.z);
}

export function computeBurgageLayout(
  corners: BurgageZoneCorners,
  frontageEdge: BurgageFrontageEdge,
  requestedPlotCount: number,
): BurgageLayoutResult | null {
  const zone = cornersToArray(corners);
  if (!isConvexQuad2(zone[0], zone[1], zone[2], zone[3])) return null;
  if (polygonArea2(zone) < MIN_PLOT_FRONTAGE * MIN_ZONE_DEPTH) return null;

  const [frontStart, frontEnd] = getZoneEdge(corners, frontageEdge);
  const frontageLength = distance(frontStart, frontEnd);
  if (frontageLength < MIN_PLOT_FRONTAGE) return null;

  const maxPlotCount = suggestPlotCount(frontageLength);
  const plotCount = Math.max(1, Math.min(maxPlotCount, Math.round(requestedPlotCount)));
  const [rearEnd, rearStart] = getZoneEdge(corners, oppositeFrontageEdge(frontageEdge));
  const frontSplits = splitEdge(frontStart, frontEnd, plotCount);
  const rearSplits = splitEdge(rearStart, rearEnd, plotCount);
  const parcels: BurgageParcelLayout[] = [];
  const residences: ResidencePlacement[] = [];

  for (let index = 0; index < plotCount; index += 1) {
    const frontLeft = frontSplits[index];
    const frontRight = frontSplits[index + 1];
    const rearRight = rearSplits[index + 1];
    const rearLeft = rearSplits[index];
    const polygon = [frontLeft, frontRight, rearRight, rearLeft];
    if (distance(frontLeft, frontRight) < MIN_PLOT_FRONTAGE * 0.92) continue;
    const parcelDepth = Math.min(
      distancePointToSegment2(frontLeft, rearLeft, rearRight),
      distancePointToSegment2(frontRight, rearLeft, rearRight),
    );
    if (parcelDepth < MIN_ZONE_DEPTH) continue;

    const frontMid = midpoint(frontLeft, frontRight);
    const frontDirection = normalize({
      x: frontRight.x - frontLeft.x,
      z: frontRight.z - frontLeft.z,
    });
    const inward = pickInwardNormal(frontMid, frontDirection, polygon);
    const center = {
      x: frontMid.x + inward.x * (HOUSE_SETBACK + MAIN_HOUSE_DEPTH * 0.5),
      z: frontMid.z + inward.z * (HOUSE_SETBACK + MAIN_HOUSE_DEPTH * 0.5),
    };
    const yaw = residenceDoorYaw(inward);
    const footprint = orientedRectCorners2(
      center,
      yaw,
      MAIN_HOUSE_WIDTH * 0.5,
      MAIN_HOUSE_DEPTH * 0.5,
    );
    if (!footprint.every((point) => isPointInPolygon2(point, polygon))) continue;

    parcels.push({
      index,
      polygon,
      frontLeft,
      frontRight,
      rearRight,
      rearLeft,
      area: polygonArea2(polygon),
    });
    residences.push({ parcelIndex: index, x: center.x, z: center.z, yaw });
  }

  if (residences.length === 0) return null;
  return {
    frontageLength,
    maxPlotCount,
    plotCount: residences.length,
    parcels,
    residences,
  };
}

export function resolveBurgageLayout(
  corners: BurgageZoneCorners,
  frontageEdge: BurgageFrontageEdge,
  requestedPlotCount: number,
): BurgageLayoutResult | null {
  const [frontStart, frontEnd] = getZoneEdge(corners, frontageEdge);
  const startCount = Math.min(
    suggestPlotCount(distance(frontStart, frontEnd)),
    Math.max(1, Math.round(requestedPlotCount)),
  );
  for (let plotCount = startCount; plotCount >= 1; plotCount -= 1) {
    const layout = computeBurgageLayout(corners, frontageEdge, plotCount);
    if (layout) return layout;
  }
  return null;
}

export function getParcelDividerSegments(layout: BurgageLayoutResult): Array<[Point2, Point2]> {
  const segments: Array<[Point2, Point2]> = [];
  for (let index = 0; index < layout.parcels.length - 1; index += 1) {
    const parcel = layout.parcels[index];
    segments.push([parcel.frontRight, parcel.rearRight]);
  }
  return segments;
}

/** Minimum usable depth between the authored frontage and rear boundary. */
export function measureZoneDepth(
  corners: BurgageZoneCorners,
  frontageEdge: BurgageFrontageEdge,
): number {
  const [frontStart, frontEnd] = getZoneEdge(corners, frontageEdge);
  const [rearStart, rearEnd] = getZoneEdge(corners, oppositeFrontageEdge(frontageEdge));
  return Math.min(
    distancePointToSegment2(frontStart, rearStart, rearEnd),
    distancePointToSegment2(frontEnd, rearStart, rearEnd),
  );
}

/** Perpendicular depth at each authored rear corner, preserving an angled rear boundary. */
export function measureZoneSideDepths(
  corners: BurgageZoneCorners,
  frontageEdge: BurgageFrontageEdge,
): [number, number] {
  const [frontStart, frontEnd] = getZoneEdge(corners, frontageEdge);
  const [rearEnd, rearStart] = getZoneEdge(corners, oppositeFrontageEdge(frontageEdge));
  const frontDx = frontEnd.x - frontStart.x;
  const frontDz = frontEnd.z - frontStart.z;
  const frontLength = Math.hypot(frontDx, frontDz);
  if (frontLength <= 1e-6) return [0, 0];

  let normal = { x: -frontDz / frontLength, z: frontDx / frontLength };
  const frontMid = midpoint(frontStart, frontEnd);
  const rearMid = midpoint(rearStart, rearEnd);
  if ((rearMid.x - frontMid.x) * normal.x + (rearMid.z - frontMid.z) * normal.z < 0) {
    normal = { x: -normal.x, z: -normal.z };
  }

  return [
    (rearStart.x - frontStart.x) * normal.x + (rearStart.z - frontStart.z) * normal.z,
    (rearEnd.x - frontEnd.x) * normal.x + (rearEnd.z - frontEnd.z) * normal.z,
  ];
}

export function zoneDepth(corners: BurgageZoneCorners): number {
  const frontMid = midpoint(corners.a, corners.b);
  const rearMid = midpoint(corners.d, corners.c);
  return distance(frontMid, rearMid);
}

function splitEdge(start: Point2, end: Point2, count: number): Point2[] {
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count;
    return {
      x: start.x + (end.x - start.x) * t,
      z: start.z + (end.z - start.z) * t,
    };
  });
}

function midpoint(a: Point2, b: Point2): Point2 {
  return { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
}

function normalize(point: Point2): Point2 {
  const length = Math.hypot(point.x, point.z);
  return length <= 1e-6 ? { x: 0, z: 1 } : { x: point.x / length, z: point.z / length };
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function pickInwardNormal(frontMid: Point2, direction: Point2, polygon: Point2[]): Point2 {
  const left = { x: -direction.z, z: direction.x };
  const probe = { x: frontMid.x + left.x, z: frontMid.z + left.z };
  return isPointInPolygon2(probe, polygon) ? left : { x: direction.z, z: -direction.x };
}
