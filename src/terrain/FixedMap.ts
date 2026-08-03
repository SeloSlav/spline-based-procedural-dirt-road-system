import * as THREE from 'three';
import { RiverLayout } from '../rivers/RiverLayout.ts';
import type { TerrainBounds } from './Terrain.ts';

export const WORLD_SEED = 0x071a2e0d;
export const PLAYABLE_SIZE = 620;
export const TERRAIN_SIZE = 817;
export const TERRAIN_HALF = TERRAIN_SIZE * 0.5;
export const MAP_BOUNDS: TerrainBounds = {
  minX: -TERRAIN_HALF,
  maxX: TERRAIN_HALF,
  minZ: -TERRAIN_HALF,
  maxZ: TERRAIN_HALF,
};

const PLAYABLE_HALF = PLAYABLE_SIZE * 0.5;
const KUPA_REGIONAL_RELIEF_METERS = 1_528 - 290;
const WATER_DEPTH = 1.08;

export class FixedMap {
  readonly bounds = MAP_BOUNDS;
  readonly riverLayout = RiverLayout.create({
    bounds: MAP_BOUNDS,
    seed: WORLD_SEED,
    riverCount: 1,
    tributaryCount: 0,
    terrainPreset: 'kupa_valley',
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
    return sampleKupaValleyHeight(x, z, 1, WORLD_SEED);
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

  createTerrainMesh(): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> {
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, 256, 256);
    geometry.rotateX(-Math.PI * 0.5);
    const position = geometry.getAttribute('position');
    const colors = new Float32Array(position.count * 3);
    const color = new THREE.Color();

    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index);
      const z = position.getZ(index);
      const height = this.getHeightAt(x, z);
      position.setY(index, height);

      const riverMask = this.riverLayout.sampleRiverMask(x, z);
      const upland = THREE.MathUtils.clamp((height - 5) / 95, 0, 1);
      if (riverMask > 0.18) color.setRGB(0.35, 0.34, 0.19);
      else color.setRGB(
        THREE.MathUtils.lerp(0.76, 0.49, upland),
        THREE.MathUtils.lerp(0.83, 0.65, upland),
        THREE.MathUtils.lerp(0.61, 0.44, upland),
      );
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
    }

    position.needsUpdate = true;
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('uv1', geometry.getAttribute('uv').clone());
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const textureLoader = new THREE.TextureLoader();
    const grass = configureTexture(
      textureLoader.load('/assets/textures/terrain/manor_grass_meadow/albedo.png'),
      62,
      true,
    );
    const normal = configureTexture(
      textureLoader.load('/assets/textures/terrain/manor_grass_meadow/normal.png'),
      62,
    );
    const roughness = configureTexture(
      textureLoader.load('/assets/textures/terrain/manor_grass_meadow/roughness.png'),
      62,
    );
    const ao = configureTexture(
      textureLoader.load('/assets/textures/terrain/manor_grass_meadow/ao.png'),
      62,
    );

    const material = new THREE.MeshStandardMaterial({
      map: grass,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughnessMap: roughness,
      roughness: 0.94,
      aoMap: ao,
      aoMapIntensity: 0.5,
      vertexColors: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'Kupa Valley terrain';
    mesh.receiveShadow = true;
    return mesh;
  }
}

function configureTexture(texture: THREE.Texture, repeat: number, srgb = false): THREE.Texture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function sampleKupaValleyHeight(x: number, z: number, relief: number, seed: number): number {
  const offset = presetNoiseOffset(seed);
  const normalizedX = x / PLAYABLE_HALF;
  const westSlope = smoothstep(0.31, 0.94, -normalizedX);
  const eastSlope = smoothstep(0.34, 0.94, normalizedX);
  const sideSlope = Math.max(westSlope, eastSlope);
  const ridge = ridgedFbm((x + offset.x) * 0.0048, (z + offset.z) * 0.0048, 4);
  const mountainRelief = sideSlope
    * KUPA_REGIONAL_RELIEF_METERS
    * (0.3 + ridge * 0.3)
    * relief;
  const valleyUndulation = fbm((x + offset.x) * 0.0065, (z + offset.z) * 0.0065, 4)
    * (1.3 + sideSlope * 4.2)
    * relief;
  const riverGrade = -z / Math.max(1, PLAYABLE_HALF) * 1.6;
  const forestShoulder = Math.pow(sideSlope, 2.2)
    * KUPA_REGIONAL_RELIEF_METERS
    * 0.055
    * relief;
  return mountainRelief
    + forestShoulder
    + valleyUndulation
    + riverGrade
    + getEdgeHillHeight(x, z) * relief * 0.46;
}

function getEdgeHillHeight(x: number, z: number): number {
  const edgeDistance = Math.max(Math.abs(x), Math.abs(z));
  const t = smoothstep(PLAYABLE_SIZE * 0.44, TERRAIN_HALF, edgeDistance);
  if (t <= 0) return 0;
  const ridge = fbm(x * 0.0085 + 37.5, z * 0.0085 - 22.4, 5) + 0.5;
  const detail = fbm(x * 0.026 - 6.2, z * 0.026 + 9.7, 3) + 0.5;
  return t * t * (14 + ridge * 26) + t ** 4 * (14 + detail * 18);
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

function ridgedFbm(x: number, z: number, octaves: number): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let index = 0; index < octaves; index++) {
    const n = fbm(x * frequency, z * frequency, 1) + 0.5;
    const ridge = 1 - Math.abs(n * 2 - 1);
    value += ridge * ridge * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return value / norm;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
