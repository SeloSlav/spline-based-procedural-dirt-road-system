import type * as THREE from 'three';

export type TerrainBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

/** Structural terrain surface consumed by the extracted source render systems. */
export type Terrain = {
  readonly playableSize: number;
  readonly size: number;
  readonly mesh: THREE.Mesh;
  getHeightAt(x: number, z: number): number;
  getPointAt(x: number, z: number, offset?: number): THREE.Vector3;
  getPointAtInto(x: number, z: number, target: THREE.Vector3, offset?: number): THREE.Vector3;
  setDirtZoomGate(value: number): void;
};
