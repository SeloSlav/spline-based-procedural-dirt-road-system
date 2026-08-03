import * as THREE from 'three';
import type { FixedMap } from '../terrain/FixedMap.ts';
import { buildBridgeRailings, type BridgeRailingSection } from './BridgeRailings.ts';
import { buildBridgeSupports } from './BridgeSupports.ts';
import type { RoadEdge } from './RoadEdge.ts';
import type { RoadNetwork } from './RoadNetwork.ts';
import {
  applyBridgeHeightsToPath,
  bridgeBlendAtDistance,
  detectBridgeSpans,
  type BridgeSamplingContext,
  type BridgeSpan,
} from './RiverBridgeSpans.ts';

const ROAD_Y_OFFSET = 0.16;
const SAMPLE_SPACING = 1.15;

export class RoadRenderer {
  readonly group = new THREE.Group();
  readonly previewGroup = new THREE.Group();
  private readonly network: RoadNetwork;
  private readonly map: FixedMap;
  private readonly dirtMaterial: THREE.MeshStandardMaterial;
  private readonly shoulderMaterial: THREE.MeshStandardMaterial;
  private readonly timberMaterial: THREE.MeshStandardMaterial;
  private readonly timberStructureMaterial: THREE.MeshStandardMaterial;
  private readonly previewValidMaterial = new THREE.MeshBasicMaterial({
    color: 0xd4e693,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly previewInvalidMaterial = new THREE.MeshBasicMaterial({
    color: 0xd06b55,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private bridgeCount = 0;

  constructor(network: RoadNetwork, map: FixedMap) {
    this.network = network;
    this.map = map;
    this.group.name = 'Road network';
    this.previewGroup.name = 'Road preview';
    const textures = new THREE.TextureLoader();
    this.dirtMaterial = createPbrMaterial(textures, '/assets/textures/roads/medieval_dirt', 0xeee1bd, 2.2, 0.78);
    this.shoulderMaterial = createPbrMaterial(
      textures,
      '/assets/textures/terrain/mammoth_terrain_dirt',
      0x8d7750,
      2.8,
      0.98,
      false,
    );
    this.shoulderMaterial.polygonOffset = true;
    this.shoulderMaterial.polygonOffsetFactor = 1;
    this.shoulderMaterial.polygonOffsetUnits = 1;
    this.timberMaterial = createPbrMaterial(textures, '/assets/textures/roads/wood_logs', 0xb68a4f, 1.8, 0.82);
    this.timberStructureMaterial = this.timberMaterial.clone();
    this.timberStructureMaterial.color.multiplyScalar(0.72);
  }

  rebuild(): void {
    disposeGroupChildren(this.group);
    this.bridgeCount = 0;
    for (const edge of this.network.edges.values()) {
      const path = this.sampleEdge(edge);
      const spans = detectBridgeSpans(path, this.bridgeContext());
      const bridgeBlends = applyBridgeHeightsToPath(path, spans, this.bridgeContext(), ROAD_Y_OFFSET);
      edge.sampledPath = path.map((point) => point.clone());
      edge.surfacePath = path.map((point) => point.clone());
      edge.materialData = {
        surface: 'medieval_dirt',
        bridgeSpans: spans,
      };
      edge.length = pathLength(path);
      this.bridgeCount += spans.length;

      const edgeGroup = new THREE.Group();
      edgeGroup.name = `Road ${edge.id}`;
      const shoulderGeometry = buildStripGeometry(path, edge.width + 1.35, bridgeBlends, false);
      const shoulder = new THREE.Mesh(shoulderGeometry, this.shoulderMaterial);
      shoulder.name = 'Road worn shoulder';
      shoulder.receiveShadow = true;
      shoulder.renderOrder = 0.91;
      edgeGroup.add(shoulder);

      const coreGeometry = buildStripGeometry(path, edge.width, bridgeBlends, true);
      const core = new THREE.Mesh(coreGeometry, [this.dirtMaterial, this.timberMaterial]);
      core.name = 'Dirt road and timber deck';
      core.castShadow = true;
      core.receiveShadow = true;
      core.renderOrder = 1;
      edgeGroup.add(core);

      if (spans.length > 0) {
        const supports = buildBridgeSupports(
          path,
          edge.width,
          spans,
          this.bridgeContext(),
          this.timberStructureMaterial,
        );
        if (supports) edgeGroup.add(supports);
        const railings = buildBridgeRailings(
          buildRailingSections(path, edge.width, spans),
          this.timberStructureMaterial,
        );
        if (railings) edgeGroup.add(railings);
      }
      edge.mesh = edgeGroup;
      this.group.add(edgeGroup);
    }
  }

  updatePreview(path: THREE.Vector3[], valid: boolean): { bridgeCount: number; sampled: THREE.Vector3[] } {
    disposeGroupChildren(this.previewGroup);
    if (path.length < 2) return { bridgeCount: 0, sampled: path };
    const sampled = sampleSpline(path, this.map);
    const spans = detectBridgeSpans(sampled, this.bridgeContext());
    const blends = applyBridgeHeightsToPath(sampled, spans, this.bridgeContext(), ROAD_Y_OFFSET + 0.08);
    const material = valid ? this.previewValidMaterial : this.previewInvalidMaterial;
    const mesh = new THREE.Mesh(buildStripGeometry(sampled, 4.2, blends, false), material);
    mesh.name = 'Road placement preview';
    mesh.renderOrder = 3;
    this.previewGroup.add(mesh);
    return { bridgeCount: spans.length, sampled };
  }

  clearPreview(): void {
    disposeGroupChildren(this.previewGroup);
  }

  sampleTerrainPath(path: THREE.Vector3[]): THREE.Vector3[] {
    return sampleSpline(path, this.map);
  }

  getBridgeCount(): number {
    return this.bridgeCount;
  }

  private sampleEdge(edge: RoadEdge): THREE.Vector3[] {
    return sampleSpline(edge.controlPoints, this.map);
  }

  private bridgeContext(): BridgeSamplingContext {
    return {
      isWaterAt: (x, z) => this.map.riverLayout.isWaterAt(x, z),
      getTerrainY: (x, z) => this.map.getHeightAt(x, z),
      getWaterSurfaceY: (x, z) => this.map.getWaterSurfaceY(x, z),
    };
  }
}

function sampleSpline(controlPoints: THREE.Vector3[], map: FixedMap): THREE.Vector3[] {
  if (controlPoints.length < 2) return controlPoints.map((point) => point.clone());
  const controls = controlPoints.map((point) => new THREE.Vector3(point.x, 0, point.z));
  let planarLength = 0;
  for (let index = 1; index < controls.length; index++) {
    planarLength += controls[index].distanceTo(controls[index - 1]);
  }
  const divisions = THREE.MathUtils.clamp(Math.ceil(planarLength / SAMPLE_SPACING), 2, 720);
  const points = controls.length === 2
    ? Array.from({ length: divisions + 1 }, (_, index) => controls[0].clone().lerp(controls[1], index / divisions))
    : new THREE.CatmullRomCurve3(controls, false, 'centripetal', 0.5).getPoints(divisions);
  return points.map((point) => map.getPointAt(point.x, point.z, ROAD_Y_OFFSET));
}

function buildStripGeometry(
  path: THREE.Vector3[],
  width: number,
  bridgeBlends: Float32Array,
  materialGroups: boolean,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const distances = cumulativeDistances(path);
  for (let index = 0; index < path.length; index++) {
    const tangent = tangentAt(path, index);
    const nx = -tangent.z;
    const nz = tangent.x;
    const half = width * 0.5;
    const point = path[index];
    positions.push(
      point.x + nx * half, point.y, point.z + nz * half,
      point.x - nx * half, point.y, point.z - nz * half,
    );
    uvs.push(0, distances[index] / 5.5, 1, distances[index] / 5.5);
  }
  for (let index = 0; index < path.length - 1; index++) {
    const vertex = index * 2;
    const offset = indices.length;
    indices.push(vertex, vertex + 2, vertex + 1, vertex + 2, vertex + 3, vertex + 1);
    if (materialGroups) {
      const bridge = Math.max(bridgeBlends[index] ?? 0, bridgeBlends[index + 1] ?? 0) > 0.48;
      // Groups are contiguous because each segment contributes exactly six indices.
      // Dirt = material 0, timber = material 1.
      void offset;
      void bridge;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  if (materialGroups) {
    for (let index = 0; index < path.length - 1; index++) {
      const bridge = Math.max(bridgeBlends[index] ?? 0, bridgeBlends[index + 1] ?? 0) > 0.48;
      geometry.addGroup(index * 6, 6, bridge ? 1 : 0);
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

function buildRailingSections(
  path: THREE.Vector3[],
  width: number,
  spans: BridgeSpan[],
): BridgeRailingSection[] {
  const distances = cumulativeDistances(path);
  return path.map((center, index) => {
    const tangent = tangentAt(path, index);
    const nx = -tangent.z;
    const nz = tangent.x;
    const half = width * 0.5;
    return {
      center: center.clone(),
      leftDeck: new THREE.Vector3(center.x + nx * half, center.y + 0.035, center.z + nz * half),
      rightDeck: new THREE.Vector3(center.x - nx * half, center.y + 0.035, center.z - nz * half),
      bridgeBlend: bridgeBlendAtDistance(distances[index], spans),
    };
  });
}

function createPbrMaterial(
  loader: THREE.TextureLoader,
  base: string,
  color: THREE.ColorRepresentation,
  repeat: number,
  roughnessValue: number,
  hasAo = true,
): THREE.MeshStandardMaterial {
  const map = configureTexture(loader.load(`${base}/albedo.png`), repeat, true);
  const normalMap = configureTexture(loader.load(`${base}/normal.png`), repeat);
  const roughnessMap = configureTexture(loader.load(`${base}/roughness.png`), repeat);
  const aoMap = hasAo ? configureTexture(loader.load(`${base}/ao.png`), repeat) : null;
  return new THREE.MeshStandardMaterial({
    color,
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap,
    roughness: roughnessValue,
    aoMap,
    aoMapIntensity: 0.58,
    side: THREE.DoubleSide,
  });
}

function configureTexture(texture: THREE.Texture, repeat: number, srgb = false): THREE.Texture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function tangentAt(path: THREE.Vector3[], index: number): THREE.Vector3 {
  const previous = path[Math.max(0, index - 1)];
  const next = path[Math.min(path.length - 1, index + 1)];
  const tangent = new THREE.Vector3(next.x - previous.x, 0, next.z - previous.z);
  return tangent.lengthSq() < 1e-8 ? new THREE.Vector3(1, 0, 0) : tangent.normalize();
}

function cumulativeDistances(path: THREE.Vector3[]): number[] {
  const distances = [0];
  for (let index = 1; index < path.length; index++) {
    distances.push(distances[index - 1] + path[index].distanceTo(path[index - 1]));
  }
  return distances;
}

function pathLength(path: THREE.Vector3[]): number {
  return cumulativeDistances(path).at(-1) ?? 0;
}

function disposeGroupChildren(group: THREE.Group): void {
  for (const child of [...group.children]) {
    child.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    group.remove(child);
  }
}
