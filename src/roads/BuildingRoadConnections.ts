import * as THREE from 'three';
import type { FixedMap } from '../terrain/FixedMap.ts';

const MARKER_LIFT = 0.16;
const NEAREST_FULL_DISTANCE = 7;
const NEAREST_REVEAL_DISTANCE = 14;
const SIBLING_FULL_DISTANCE = 5;
const SIBLING_REVEAL_DISTANCE = 9;
const MIN_OPACITY = 0.015;

export type BuildingRoadConnectionSource = {
  id: string;
  x: number;
  z: number;
  yaw: number;
  halfWidth: number;
  halfDepth: number;
};

export type RoadNodeConnectionSource = {
  id: string;
  position: THREE.Vector3;
};

type RuntimeConnection = {
  id: string;
  point: THREE.Vector3;
  revealGroup: string;
  opacity: number;
  distance: number;
};

/**
 * Road connection anchors: residence footprint points and existing road nodes,
 * revealed as white rings as the road cursor approaches a valid snap target.
 */
export class BuildingRoadConnections {
  private readonly group = new THREE.Group();
  private readonly map: FixedMap;
  private readonly getBuildings: () => Iterable<BuildingRoadConnectionSource>;
  private readonly getRoadNodes: () => Iterable<RoadNodeConnectionSource>;
  private readonly ringGeometry = new THREE.RingGeometry(0.78, 1.14, 20);
  private readonly postGeometry = new THREE.CylinderGeometry(0.18, 0.28, 0.56, 8);
  private readonly ringMaterial = createMarkerMaterial(THREE.DoubleSide);
  private readonly postMaterial = createMarkerMaterial(THREE.FrontSide);
  private connections: RuntimeConnection[] = [];
  private signature = '';
  private cursor: THREE.Vector3 | null = null;
  private ringMarkers: THREE.InstancedMesh | null = null;
  private postMarkers: THREE.InstancedMesh | null = null;
  private ringOpacity: THREE.InstancedBufferAttribute | null = null;
  private postOpacity: THREE.InstancedBufferAttribute | null = null;
  private capacity = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly ringRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, 0));
  private readonly identityRotation = new THREE.Quaternion();

  constructor(options: {
    parent: THREE.Object3D;
    map: FixedMap;
    getBuildings: () => Iterable<BuildingRoadConnectionSource>;
    getRoadNodes?: () => Iterable<RoadNodeConnectionSource>;
  }) {
    this.map = options.map;
    this.getBuildings = options.getBuildings;
    this.getRoadNodes = options.getRoadNodes ?? (() => []);
    this.group.name = 'Road connection circles';
    this.group.visible = false;
    this.group.renderOrder = 29;
    options.parent.add(this.group);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (visible) this.refresh(true);
    else this.cursor = null;
  }

  setCursor(point: THREE.Vector3 | null): void {
    this.cursor = point ? point.clone() : null;
  }

  refresh(force = false): void {
    const buildings = [...this.getBuildings()];
    const roadNodes = [...this.getRoadNodes()];
    const buildingSignature = buildings
      .map((building) => `${building.id}:${building.x.toFixed(2)}:${building.z.toFixed(2)}:${building.yaw.toFixed(3)}:${building.halfWidth.toFixed(2)}:${building.halfDepth.toFixed(2)}`)
      .sort()
      .join('|');
    const roadNodeSignature = roadNodes
      .map((node) => `${node.id}:${node.position.x.toFixed(2)}:${node.position.z.toFixed(2)}`)
      .sort()
      .join('|');
    const signature = `${buildingSignature}#${roadNodeSignature}`;
    if (!force && signature === this.signature) return;
    this.signature = signature;
    const priorOpacity = new Map(this.connections.map((connection) => [connection.id, connection.opacity]));
    this.connections = [];
    buildings.forEach((building, buildingGroup) => {
      const cos = Math.cos(building.yaw);
      const sin = Math.sin(building.yaw);
      const offsets = [
        { x: 0, z: building.halfDepth },
        { x: building.halfWidth, z: 0 },
        { x: 0, z: -building.halfDepth },
        { x: -building.halfWidth, z: 0 },
      ];
      offsets.forEach((offset, index) => {
        const x = building.x + offset.x * cos + offset.z * sin;
        const z = building.z - offset.x * sin + offset.z * cos;
        const id = `${building.id}:${index}`;
        this.connections.push({
          id: `building:${id}`,
          point: this.map.getPointAt(x, z),
          revealGroup: `building:${buildingGroup}`,
          opacity: priorOpacity.get(`building:${id}`) ?? 0,
          distance: Infinity,
        });
      });
    });
    for (const node of roadNodes) {
      const id = `road-node:${node.id}`;
      this.connections.push({
        id,
        point: node.position.clone(),
        revealGroup: id,
        opacity: priorOpacity.get(id) ?? 0,
        distance: Infinity,
      });
    }
    this.updateInstances();
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.refresh();
    const nearest = new Map<string, RuntimeConnection>();
    if (this.cursor) {
      for (const connection of this.connections) {
        connection.distance = distanceXZ(connection.point, this.cursor);
        const current = nearest.get(connection.revealGroup);
        if (!current || connection.distance < current.distance) nearest.set(connection.revealGroup, connection);
      }
    }
    const frameDt = THREE.MathUtils.clamp(dt, 0, 0.1);
    let dirty = false;
    for (const connection of this.connections) {
      const isNearest = nearest.get(connection.revealGroup) === connection;
      const target = this.cursor ? markerRevealOpacity(connection.distance, isNearest) : 0;
      const rate = target > connection.opacity ? 13 : 9;
      let next = THREE.MathUtils.lerp(connection.opacity, target, 1 - Math.exp(-frameDt * rate));
      if (target === 0 && next < MIN_OPACITY) next = 0;
      if (Math.abs(next - connection.opacity) > 0.001) {
        connection.opacity = next;
        dirty = true;
      }
    }
    if (dirty) this.updateInstances();
  }

  findSnap(point: THREE.Vector3, maxDistance: number): { point: THREE.Vector3; distance: number } | null {
    this.refresh();
    let best: { point: THREE.Vector3; distance: number } | null = null;
    for (const connection of this.connections) {
      const distance = distanceXZ(point, connection.point);
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = { point: connection.point, distance };
      }
    }
    return best;
  }

  private updateInstances(): void {
    const active = this.connections.filter((connection) => connection.opacity >= MIN_OPACITY);
    if (active.length > 0) this.ensureCapacity(active.length);
    if (!this.ringMarkers || !this.postMarkers) return;

    active.forEach((connection, index) => {
      const markerScale = 0.86 + connection.opacity * 0.14;
      this.scale.setScalar(markerScale);
      this.matrix.compose(
        this.position.set(connection.point.x, connection.point.y + MARKER_LIFT, connection.point.z),
        this.ringRotation,
        this.scale,
      );
      this.ringMarkers!.setMatrixAt(index, this.matrix);
      this.matrix.compose(
        this.position.set(connection.point.x, connection.point.y + MARKER_LIFT + 0.28, connection.point.z),
        this.identityRotation,
        this.scale,
      );
      this.postMarkers!.setMatrixAt(index, this.matrix);
      this.ringOpacity?.setX(index, connection.opacity);
      this.postOpacity?.setX(index, connection.opacity);
    });
    this.ringMarkers.count = active.length;
    this.postMarkers.count = active.length;
    this.ringMarkers.instanceMatrix.needsUpdate = true;
    this.postMarkers.instanceMatrix.needsUpdate = true;
    if (this.ringOpacity) this.ringOpacity.needsUpdate = true;
    if (this.postOpacity) this.postOpacity.needsUpdate = true;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) return;
    this.capacity = Math.max(4, 2 ** Math.ceil(Math.log2(required)));
    this.ringMarkers?.removeFromParent();
    this.postMarkers?.removeFromParent();
    this.ringOpacity = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.postOpacity = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.ringGeometry.setAttribute('markerOpacity', this.ringOpacity);
    this.postGeometry.setAttribute('markerOpacity', this.postOpacity);
    this.ringMarkers = new THREE.InstancedMesh(this.ringGeometry, this.ringMaterial, this.capacity);
    this.postMarkers = new THREE.InstancedMesh(this.postGeometry, this.postMaterial, this.capacity);
    this.ringMarkers.name = 'White building snap rings';
    this.postMarkers.name = 'White building snap posts';
    for (const markers of [this.ringMarkers, this.postMarkers]) {
      markers.count = 0;
      markers.renderOrder = 29;
      markers.castShadow = false;
      markers.receiveShadow = false;
      markers.frustumCulled = false;
      this.group.add(markers);
    }
  }
}

export function markerRevealOpacity(distance: number, isNearest: boolean): number {
  const full = isNearest ? NEAREST_FULL_DISTANCE : SIBLING_FULL_DISTANCE;
  const reveal = isNearest ? NEAREST_REVEAL_DISTANCE : SIBLING_REVEAL_DISTANCE;
  return 1 - THREE.MathUtils.smoothstep(distance, full, reveal);
}

function createMarkerMaterial(side: THREE.Side): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
    side,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float markerOpacity;\nvarying float vMarkerOpacity;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMarkerOpacity = markerOpacity;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vMarkerOpacity;')
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vMarkerOpacity;\n#include <opaque_fragment>');
  };
  material.customProgramCacheKey = () => 'residence-road-marker-opacity-v1';
  return material;
}

function distanceXZ(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
