import * as THREE from 'three';
import type { RiverField } from '../rivers/RiverField.ts';
import { RiverLayout } from '../rivers/RiverLayout.ts';
import { sampleTerrainBlendWeights, sampleTerrainUv } from './TerrainBlendWeights.ts';
import type { TerrainBounds } from './Terrain.ts';

export const WORLD_SEED = 0x4a11ce5d;
export const TERRAIN_SIZE = 408.5;
/** Every rendered part of the terrain is playable; there is no decorative-only edge ring. */
export const PLAYABLE_SIZE = TERRAIN_SIZE;
export const TERRAIN_HALF = TERRAIN_SIZE * 0.5;
export const MAP_BOUNDS: TerrainBounds = {
  minX: -TERRAIN_HALF,
  maxX: TERRAIN_HALF,
  minZ: -TERRAIN_HALF,
  maxZ: TERRAIN_HALF,
};

const PLAYABLE_HALF = PLAYABLE_SIZE * 0.5;
const WATER_DEPTH = 1.08;

export class FixedMap {
  readonly bounds = MAP_BOUNDS;
  readonly riverLayout = RiverLayout.create({
    bounds: MAP_BOUNDS,
    seed: WORLD_SEED,
    riverCount: 3,
    tributaryCount: 3,
    drain: { x: 34, z: -32 },
    terrainPreset: 'custom',
  });

  clampXZ(x: number, z: number): { x: number; z: number } {
    return {
      x: THREE.MathUtils.clamp(x, this.bounds.minX, this.bounds.maxX),
      z: THREE.MathUtils.clamp(z, this.bounds.minZ, this.bounds.maxZ),
    };
  }

  getHeightAt(x: number, z: number): number {
    const clamped = this.clampXZ(x, z);
    return this.getRawHeightAt(clamped.x, clamped.z)
      - this.riverLayout.getValleyDepression(clamped.x, clamped.z);
  }

  getRawHeightAt(x: number, z: number): number {
    return sampleConfluenceLowlandHeight(x, z, WORLD_SEED);
  }

  getWaterSurfaceY(x: number, z: number): number {
    return this.getHeightAt(x, z) + WATER_DEPTH;
  }

  getPointAt(x: number, z: number, yOffset = 0): THREE.Vector3 {
    const clamped = this.clampXZ(x, z);
    return new THREE.Vector3(
      clamped.x,
      this.getHeightAt(clamped.x, clamped.z) + yOffset,
      clamped.z,
    );
  }

  createTerrainMesh(
    material?: THREE.Material,
    riverField?: RiverField,
  ): THREE.Mesh<THREE.PlaneGeometry, THREE.Material> {
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, 256, 256);
    geometry.rotateX(-Math.PI * 0.5);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const colors = new Float32Array(position.count * 3);
    const shoreBlends = new Float32Array(position.count);
    const roadWearBlends = new Float32Array(position.count);
    const quarryPadBlends = new Float32Array(position.count);
    const dirtZoomGates = new Float32Array(position.count);

    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index);
      const z = position.getZ(index);
      const height = this.getHeightAt(x, z);
      position.setY(index, height);

      const weights = sampleTerrainBlendWeights(x, z);
      colors[index * 3] = weights[0];
      colors[index * 3 + 1] = weights[1];
      colors[index * 3 + 2] = weights[2];
      const terrainUv = sampleTerrainUv(x, z);
      uv.setXY(index, terrainUv[0], terrainUv[1]);
      shoreBlends[index] = riverField?.sampleMudBlendAt(x, z) ?? 0;
    }

    position.needsUpdate = true;
    uv.needsUpdate = true;
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('uv1', uv.clone());
    geometry.setAttribute('shoreBlend', new THREE.BufferAttribute(shoreBlends, 1));
    geometry.setAttribute('roadWearBlend', new THREE.BufferAttribute(roadWearBlends, 1));
    geometry.setAttribute('quarryPadBlend', new THREE.BufferAttribute(quarryPadBlends, 1));
    geometry.setAttribute('dirtZoomGate', new THREE.BufferAttribute(dirtZoomGates, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(
      geometry,
      material ?? new THREE.MeshStandardMaterial({ color: 0x93a570, roughness: 0.94, vertexColors: true }),
    );
    mesh.name = 'Confluence Lowlands terrain';
    mesh.receiveShadow = true;
    return mesh;
  }
}

function sampleConfluenceLowlandHeight(x: number, z: number, seed: number): number {
  const offset = presetNoiseOffset(seed);
  const broadUndulation = fbm((x + offset.x) * 0.0038, (z + offset.z) * 0.0038, 4) * 5.2;
  const meadowDetail = fbm((x - offset.z) * 0.012, (z + offset.x) * 0.012, 3) * 1.15;
  const riverGrade = -z / Math.max(1, PLAYABLE_HALF) * 0.72;
  const distanceFromCenter = Math.hypot(x, z) / TERRAIN_HALF;
  const perimeterRise = smoothstep(0.72, 1, distanceFromCenter) * 2.4;
  return broadUndulation + meadowDetail + riverGrade + perimeterRise;
}

function presetNoiseOffset(seed: number): { x: number; z: number } {
  return {
    x: ((seed >>> 4) & 0xfff) * 0.017,
    z: ((seed >>> 16) & 0xfff) * 0.019,
  };
}

function hash(x: number, z: number): number {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise(x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash(x0, z0);
  const b = hash(x0 + 1, z0);
  const c = hash(x0, z0 + 1);
  const d = hash(x0 + 1, z0 + 1);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(a, b, sx),
    THREE.MathUtils.lerp(c, d, sx),
    sz,
  );
}

function fbm(x: number, z: number, octaves: number): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let index = 0; index < octaves; index++) {
    value += valueNoise(x * frequency, z * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / norm - 0.5;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
