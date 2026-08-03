import * as THREE from 'three';
import type { Terrain } from '../terrain/Terrain.ts';
import type { RoadEdge } from './RoadEdge.ts';
import type { RoadMaterialFactory } from './RoadMaterialFactory.ts';
import type { RoadNetwork } from './RoadNetwork.ts';
import type { RoadNode } from './RoadNode.ts';
import {
  BRIDGE_RAILING_EDGE_INSET,
  BRIDGE_RAILING_START_BLEND,
  buildTimberRailings,
} from './BridgeRailings.ts';
import { bridgeBlendAtDistance } from './RiverBridgeSpans.ts';
import {
  exteriorDirectionAtNode,
  getEdgePath,
  inwardDirectionAtNode,
  ROAD_END_TRIM,
  ROAD_JUNCTION_REACH,
  roadPerpendicular,
} from './roadEndpoint.ts';

// Lift the patches a hair above the individual ribbons. Independently built
// roads otherwise leave coplanar triangles at the shared node, which shows up
// as dark seams on some WebGPU drivers.
const CORE_Y_OFFSET = 0.132;
const BLEND_Y_OFFSET = 0.172;
const CAP_OVERLAP = 0.12;
const JUNCTION_SEGMENTS = 64;
const END_CAP_SEGMENTS = 28;
const JUNCTION_BLEND_WIDTH = 0.64;
const END_CAP_LONGITUDINAL_BLEND = 0.56;
const END_CAP_LATERAL_BLEND = 0.72;
const BRIDGE_JUNCTION_LIFT = 0.014;
const BRIDGE_MOUTH_TOLERANCE = 0.14;

const BLEND_LAYERS = [
  { expansion: 0, fadeU: 1 },
  { expansion: 0.42, fadeU: 0.58 },
  { expansion: 0.72, fadeU: 0.25 },
  { expansion: 1, fadeU: 0 },
] as const;

export class RoadJunctionBuilder {
  private readonly terrain: Terrain;
  private readonly materials: RoadMaterialFactory;

  constructor(terrain: Terrain, materials: RoadMaterialFactory) {
    this.terrain = terrain;
    this.materials = materials;
  }

  build(network: RoadNetwork): THREE.Group {
    const group = new THREE.Group();
    group.name = 'Road junction and cap patches';
    for (const node of network.nodes.values()) {
      const patch = this.buildNodePatch(node, network);
      if (patch) group.add(patch);
    }
    return group;
  }

  private buildNodePatch(node: RoadNode, network: RoadNetwork): THREE.Group | null {
    const edges = network.getConnectedEdges(node);
    if (edges.length === 0) return null;
    const width = averageWidth(edges);
    const group = new THREE.Group();
    group.name = `Road ${node.junctionType} ${node.id}`;
    group.userData.nodeId = node.id;

    if (edges.length === 1) {
      const frame = this.endpointFrame(node, edges[0], width);
      const blend = this.buildEndpointBlendCap(frame, width);
      const core = this.buildEndpointCoreCap(frame, width);
      this.configurePatch(blend, 10);
      this.configurePatch(core, 12);
      group.add(blend, core);
      return group;
    }

    const directions = uniqueDirections(edges.map((edge) => inwardDirectionAtNode(edge, node.id)));
    if (directions.length === 0) return null;
    const bridgeSurface = bridgeJunctionSurface(node, edges);
    if (bridgeSurface) {
      const core = this.buildBridgeJunctionCore(
        node.position,
        directions,
        width,
        bridgeSurface.y + BRIDGE_JUNCTION_LIFT,
        bridgeSurface.blend,
      );
      this.configurePatch(core, 15);
      group.userData.bridgeJunction = true;
      group.add(core);

      const railingPaths = bridgeJunctionRailingPaths(
        node.position,
        directions,
        width,
        bridgeSurface.y + BRIDGE_JUNCTION_LIFT,
      );
      const railings = buildTimberRailings(
        railingPaths,
        this.materials.bridgeSupport,
        `Bridge junction railings ${node.id}`,
      );
      if (railings) group.add(railings);
      return group;
    }

    const core = this.buildJunctionCore(node.position, directions, width);
    const blend = this.buildJunctionBlend(node.position, directions, width);
    this.configurePatch(blend, 10);
    this.configurePatch(core, 12);
    group.add(blend, core);
    return group;
  }

  private configurePatch(mesh: THREE.Mesh, renderOrder: number): void {
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = renderOrder;
  }

  private endpointFrame(node: RoadNode, edge: RoadEdge, width: number): EndpointFrame {
    const inward = inwardDirectionAtNode(edge, node.id);
    const exterior = exteriorDirectionAtNode(edge, node.id);
    const perp = roadPerpendicular(inward);
    const trim = width * ROAD_END_TRIM;
    const overlap = width * CAP_OVERLAP;
    const capLength = trim + overlap;
    // The cap mouth must sit *inside* the trimmed ribbon. Subtracting overlap
    // here leaves a literal terrain gap between the ribbon and its cap.
    const mouthCenter = node.position.clone().addScaledVector(inward, capLength);
    const roadLength = pathLength(getEdgePath(edge));
    const textureBaseV = edge.startNodeId === node.id
      ? 0
      : Math.max(0, roadLength - trim) / 5.8;
    return { inward, exterior, perp, mouthCenter, capLength, textureBaseV };
  }

  private buildEndpointCoreCap(frame: EndpointFrame, width: number): THREE.Mesh {
    const halfWidth = width * 0.5;
    const arc = endpointArcPoints(frame, frame.capLength, halfWidth, END_CAP_SEGMENTS);
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    this.pushSurfaceVertex(
      positions,
      uvs,
      frame.mouthCenter,
      CORE_Y_OFFSET,
      0.5,
      frame.textureBaseV,
    );

    for (const point of arc) {
      const delta = point.clone().sub(frame.mouthCenter);
      const lateral = delta.dot(frame.perp);
      const exterior = Math.max(0, delta.dot(frame.exterior));
      this.pushSurfaceVertex(
        positions,
        uvs,
        point,
        CORE_Y_OFFSET,
        0.5 + lateral / width,
        frame.textureBaseV + exterior / 5.8,
      );
    }

    for (let index = 1; index < arc.length; index++) {
      indices.push(0, index, index + 1);
    }
    return this.createMesh(positions, uvs, indices, this.materials.road);
  }

  private buildBridgeJunctionCore(
    center: THREE.Vector3,
    directions: THREE.Vector3[],
    width: number,
    surfaceY: number,
    bridgeBlend: number,
  ): THREE.Mesh {
    const halfWidth = width * 0.5;
    const reach = width * ROAD_JUNCTION_REACH;
    const contour = junctionContour(directions, halfWidth, reach, JUNCTION_SEGMENTS);
    const textureDirection = junctionTextureDirection(directions);
    const texturePerp = roadPerpendicular(textureDirection);
    const positions: number[] = [center.x, surfaceY, center.z];
    const uvs: number[] = [0.5, 0.5];
    const indices: number[] = [];

    for (const local of contour) {
      const along = local.x * textureDirection.x + local.y * textureDirection.z;
      const lateral = local.x * texturePerp.x + local.y * texturePerp.z;
      positions.push(center.x + local.x, surfaceY, center.z + local.y);
      uvs.push(0.5 + lateral / width, 0.5 + along / 5.8);
    }
    for (let index = 0; index < contour.length; index++) {
      const current = index + 1;
      const next = (index + 1) % contour.length + 1;
      indices.push(0, next, current);
    }
    return this.createMesh(positions, uvs, indices, this.materials.road, bridgeBlend);
  }

  private buildEndpointBlendCap(frame: EndpointFrame, width: number): THREE.Mesh {
    const halfWidth = width * 0.5;
    const longitudinalBlend = width * END_CAP_LONGITUDINAL_BLEND;
    const lateralBlend = width * END_CAP_LATERAL_BLEND;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const rings = BLEND_LAYERS.map(({ expansion, fadeU }) => {
      const arc = endpointArcPoints(
        frame,
        frame.capLength + longitudinalBlend * expansion,
        halfWidth + lateralBlend * expansion,
        END_CAP_SEGMENTS,
      );
      const startIndex = positions.length / 3;
      for (const point of arc) {
        const exterior = Math.max(0, point.clone().sub(frame.mouthCenter).dot(frame.exterior));
        this.pushSurfaceVertex(
          positions,
          uvs,
          point,
          BLEND_Y_OFFSET,
          fadeU,
          frame.textureBaseV + exterior / 5.8,
        );
      }
      return { startIndex, count: arc.length };
    });

    for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex++) {
      const inner = rings[ringIndex];
      const outer = rings[ringIndex + 1];
      for (let index = 0; index < inner.count - 1; index++) {
        const innerCurrent = inner.startIndex + index;
        const innerNext = innerCurrent + 1;
        const outerCurrent = outer.startIndex + index;
        const outerNext = outerCurrent + 1;
        indices.push(innerCurrent, outerCurrent, innerNext);
        indices.push(innerNext, outerCurrent, outerNext);
      }
    }
    return this.createMesh(positions, uvs, indices, this.materials.roadEdge);
  }

  private buildJunctionCore(
    center: THREE.Vector3,
    directions: THREE.Vector3[],
    width: number,
  ): THREE.Mesh {
    const halfWidth = width * 0.5;
    const reach = width * ROAD_JUNCTION_REACH;
    const contour = junctionContour(directions, halfWidth, reach, JUNCTION_SEGMENTS);
    const textureDirection = junctionTextureDirection(directions);
    const texturePerp = roadPerpendicular(textureDirection);
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    this.pushJunctionVertex(positions, uvs, center, center, textureDirection, texturePerp, CORE_Y_OFFSET, 0.5);

    for (const local of contour) {
      const point = new THREE.Vector3(center.x + local.x, center.y, center.z + local.y);
      const lateral = local.x * texturePerp.x + local.y * texturePerp.z;
      this.pushJunctionVertex(
        positions,
        uvs,
        point,
        center,
        textureDirection,
        texturePerp,
        CORE_Y_OFFSET,
        0.5 + lateral / width,
      );
    }
    for (let index = 0; index < contour.length; index++) {
      const current = index + 1;
      const next = (index + 1) % contour.length + 1;
      // Clockwise in XZ is upward-facing in Three's right-handed coordinates.
      indices.push(0, next, current);
    }
    return this.createMesh(positions, uvs, indices, this.materials.road);
  }

  private buildJunctionBlend(
    center: THREE.Vector3,
    directions: THREE.Vector3[],
    width: number,
  ): THREE.Mesh {
    const halfWidth = width * 0.5;
    const reach = width * ROAD_JUNCTION_REACH;
    const blendWidth = width * JUNCTION_BLEND_WIDTH;
    const textureDirection = junctionTextureDirection(directions);
    const texturePerp = roadPerpendicular(textureDirection);
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const rings = BLEND_LAYERS.map(({ expansion, fadeU }) => {
      const contour = junctionContour(
        directions,
        halfWidth + blendWidth * expansion,
        reach + blendWidth * expansion,
        JUNCTION_SEGMENTS,
      );
      const startIndex = positions.length / 3;
      for (const local of contour) {
        const point = new THREE.Vector3(center.x + local.x, center.y, center.z + local.y);
        this.pushJunctionVertex(
          positions,
          uvs,
          point,
          center,
          textureDirection,
          texturePerp,
          BLEND_Y_OFFSET,
          fadeU,
        );
      }
      return { startIndex, count: contour.length };
    });

    for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex++) {
      const inner = rings[ringIndex];
      const outer = rings[ringIndex + 1];
      for (let index = 0; index < inner.count; index++) {
        const next = (index + 1) % inner.count;
        const innerCurrent = inner.startIndex + index;
        const innerNext = inner.startIndex + next;
        const outerCurrent = outer.startIndex + index;
        const outerNext = outer.startIndex + next;
        indices.push(innerCurrent, innerNext, outerCurrent);
        indices.push(innerNext, outerNext, outerCurrent);
      }
    }
    return this.createMesh(positions, uvs, indices, this.materials.roadEdge);
  }

  private pushJunctionVertex(
    positions: number[],
    uvs: number[],
    point: THREE.Vector3,
    center: THREE.Vector3,
    textureDirection: THREE.Vector3,
    texturePerp: THREE.Vector3,
    yOffset: number,
    textureU: number,
  ): void {
    const dx = point.x - center.x;
    const dz = point.z - center.z;
    const along = dx * textureDirection.x + dz * textureDirection.z;
    const lateral = dx * texturePerp.x + dz * texturePerp.z;
    this.pushSurfaceVertex(
      positions,
      uvs,
      point,
      yOffset,
      textureU,
      0.5 + along / 5.8 + lateral * 0.025,
    );
  }

  private pushSurfaceVertex(
    positions: number[],
    uvs: number[],
    point: THREE.Vector3,
    yOffset: number,
    textureU: number,
    textureV: number,
  ): void {
    positions.push(point.x, this.terrain.getHeightAt(point.x, point.z) + yOffset, point.z);
    uvs.push(textureU, textureV);
  }

  private createMesh(
    positions: number[],
    uvs: number[],
    indices: number[],
    material: THREE.Material,
    bridgeBlend = 0,
  ): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(indices);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('uv2', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute(
      'bridgeBlend',
      new THREE.BufferAttribute(new Float32Array(positions.length / 3).fill(bridgeBlend), 1),
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return new THREE.Mesh(geometry, material);
  }
}

type EndpointFrame = {
  inward: THREE.Vector3;
  exterior: THREE.Vector3;
  perp: THREE.Vector3;
  mouthCenter: THREE.Vector3;
  capLength: number;
  textureBaseV: number;
};

function endpointArcPoints(
  frame: EndpointFrame,
  longitudinalRadius: number,
  lateralRadius: number,
  segments: number,
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index <= segments; index++) {
    const angle = -Math.PI * 0.5 + index / segments * Math.PI;
    points.push(
      frame.mouthCenter
        .clone()
        .addScaledVector(frame.exterior, Math.cos(angle) * longitudinalRadius)
        .addScaledVector(frame.perp, Math.sin(angle) * lateralRadius),
    );
  }
  return points;
}

function bridgeJunctionSurface(
  node: RoadNode,
  edges: readonly RoadEdge[],
): { y: number; blend: number } | null {
  let highestY = -Infinity;
  let strongestBlend = 0;

  for (const edge of edges) {
    const spans = edge.materialData?.bridgeSpans;
    if (!spans || spans.length === 0) continue;
    const atStart = edge.startNodeId === node.id;
    const distance = atStart ? 0 : edge.length;
    const blend = bridgeBlendAtDistance(distance, spans);
    if (blend <= BRIDGE_RAILING_START_BLEND) continue;

    const path = edge.surfacePath;
    const endpoint = path?.[atStart ? 0 : path.length - 1];
    if (!endpoint) continue;
    highestY = Math.max(highestY, endpoint.y);
    strongestBlend = Math.max(strongestBlend, blend);
  }

  return Number.isFinite(highestY)
    ? { y: highestY, blend: strongestBlend }
    : null;
}

/**
 * Follow the shared deck perimeter between road arms. Segments across the end
 * of each arm are omitted, producing a clean opening for every connected edge
 * while retaining guarded outer corners for bends, T's, crosses, and hubs.
 */
function bridgeJunctionRailingPaths(
  center: THREE.Vector3,
  directions: readonly THREE.Vector3[],
  width: number,
  surfaceY: number,
): THREE.Vector3[][] {
  const radius = Math.max(width * 0.22, width * 0.5 - BRIDGE_RAILING_EDGE_INSET);
  const reach = width * ROAD_JUNCTION_REACH;
  const contour = junctionContour([...directions], radius, reach, JUNCTION_SEGMENTS);
  if (contour.length < 2) return [];

  const railSegment = contour.map((point, index) => {
    const next = contour[(index + 1) % contour.length];
    return !isBridgeMouthSegment(point, next, directions, reach);
  });
  const firstOpening = railSegment.findIndex((active) => !active);
  if (firstOpening < 0) return [];

  const paths: THREE.Vector3[][] = [];
  let current: THREE.Vector3[] = [];
  for (let step = 1; step <= contour.length; step++) {
    const index = (firstOpening + step) % contour.length;
    if (railSegment[index]) {
      if (current.length === 0) current.push(toJunctionWorldPoint(contour[index], center, surfaceY));
      current.push(toJunctionWorldPoint(contour[(index + 1) % contour.length], center, surfaceY));
      continue;
    }
    if (current.length >= 2) paths.push(current);
    current = [];
  }
  if (current.length >= 2) paths.push(current);
  return paths;
}

function isBridgeMouthSegment(
  start: THREE.Vector2,
  end: THREE.Vector2,
  directions: readonly THREE.Vector3[],
  reach: number,
): boolean {
  const midX = (start.x + end.x) * 0.5;
  const midZ = (start.y + end.y) * 0.5;
  return directions.some((direction) => (
    midX * direction.x + midZ * direction.z >= reach - BRIDGE_MOUTH_TOLERANCE
  ));
}

function toJunctionWorldPoint(
  local: THREE.Vector2,
  center: THREE.Vector3,
  surfaceY: number,
): THREE.Vector3 {
  return new THREE.Vector3(center.x + local.x, surfaceY, center.z + local.y);
}

/**
 * Star-shaped outline of a small round hub plus short road-strip stubs. The
 * old outline emitted four points per road direction and connected the angular
 * gaps with long chords; two separately placed roads therefore produced a
 * square slab in the empty quadrant of an L bend.
 */
export function junctionContour(
  directions: THREE.Vector3[],
  radius: number,
  reach: number,
  segments = JUNCTION_SEGMENTS,
): THREE.Vector2[] {
  const contour: THREE.Vector2[] = [];
  for (let index = 0; index < segments; index++) {
    const angle = index / segments * Math.PI * 2;
    const ux = Math.cos(angle);
    const uz = Math.sin(angle);
    let radialExtent = radius;
    for (const direction of directions) {
      const along = ux * direction.x + uz * direction.z;
      if (along <= 1e-4) continue;
      const lateral = Math.abs(ux * direction.z - uz * direction.x);
      const widthExtent = lateral <= 1e-4 ? Infinity : radius / lateral;
      const reachExtent = reach / along;
      radialExtent = Math.max(radialExtent, Math.min(widthExtent, reachExtent));
    }
    contour.push(new THREE.Vector2(ux * radialExtent, uz * radialExtent));
  }
  return contour;
}

function uniqueDirections(directions: THREE.Vector3[]): THREE.Vector3[] {
  const unique: THREE.Vector3[] = [];
  for (const direction of directions) {
    if (direction.lengthSq() < 1e-6) continue;
    direction.y = 0;
    direction.normalize();
    if (unique.some((candidate) => candidate.dot(direction) > 0.9995)) continue;
    unique.push(direction);
  }
  return unique;
}

function junctionTextureDirection(directions: THREE.Vector3[]): THREE.Vector3 {
  const sum = directions.reduce((result, direction) => result.add(direction), new THREE.Vector3());
  if (sum.lengthSq() > 0.05) return sum.setY(0).normalize();
  return directions[0]?.clone().setY(0).normalize() ?? new THREE.Vector3(1, 0, 0);
}

function averageWidth(edges: RoadEdge[]): number {
  return edges.reduce((sum, edge) => sum + edge.width, 0) / Math.max(1, edges.length);
}

function pathLength(path: THREE.Vector3[]): number {
  let length = 0;
  for (let index = 1; index < path.length; index++) {
    length += Math.hypot(path[index].x - path[index - 1].x, path[index].z - path[index - 1].z);
  }
  return length;
}
