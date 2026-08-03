import * as THREE from 'three';
import type { RoadEdge } from '../roads/RoadEdge.ts';
import { FixedMap, PLAYABLE_SIZE, TERRAIN_HALF, WORLD_SEED } from '../terrain/FixedMap.ts';

type Placement = {
  x: number;
  z: number;
  y: number;
  rotation: number;
  scale: number;
};

export class MapDecor {
  readonly group = new THREE.Group();
  private readonly map: FixedMap;
  private readonly grass: THREE.InstancedMesh;
  private readonly grassPlacements: Placement[];
  private readonly waterMaterial: THREE.MeshPhysicalMaterial;

  constructor(map: FixedMap) {
    this.map = map;
    this.group.name = 'Kupa Valley scenery';

    const river = createRiverMesh(map);
    this.waterMaterial = river.material;
    this.group.add(river.mesh);
    this.group.add(createRiverStones(map));
    this.group.add(createTrees(map));

    const grass = createGrass(map);
    this.grass = grass.mesh;
    this.grassPlacements = grass.placements;
    this.group.add(this.grass);
  }

  update(elapsed: number): void {
    this.waterMaterial.emissiveIntensity = 0.038 + Math.sin(elapsed * 0.8) * 0.008;
  }

  updateRoadClearance(edges: Iterable<RoadEdge>): void {
    const paths = [...edges].map((edge) => ({
      path: edge.surfacePath ?? edge.sampledPath,
      radius: edge.width * 0.5 + 1.25,
    }));
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();

    this.grassPlacements.forEach((placement, index) => {
      const hidden = paths.some(({ path, radius }) => (
        distanceToPolyline(placement.x, placement.z, path) < radius
      ));
      position.set(placement.x, placement.y, placement.z);
      quaternion.setFromAxisAngle(UP, placement.rotation);
      const visibleScale = hidden ? 0 : placement.scale;
      scale.set(visibleScale, visibleScale, visibleScale);
      matrix.compose(position, quaternion, scale);
      this.grass.setMatrixAt(index, matrix);
    });
    this.grass.instanceMatrix.needsUpdate = true;
  }
}

function createRiverMesh(map: FixedMap): {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  material: THREE.MeshPhysicalMaterial;
} {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const corridor of map.riverLayout.corridors) {
    const base = positions.length / 3;
    let distance = 0;
    corridor.points.forEach((point, index) => {
      const previous = corridor.points[Math.max(0, index - 1)];
      const next = corridor.points[Math.min(corridor.points.length - 1, index + 1)];
      if (index > 0) distance += Math.hypot(point.x - previous.x, point.z - previous.z);
      const dx = next.x - previous.x;
      const dz = next.z - previous.z;
      const length = Math.max(0.001, Math.hypot(dx, dz));
      const nx = -dz / length;
      const nz = dx / length;
      const halfWidth = point.halfWidth * 0.72;
      const y = map.getWaterSurfaceY(point.x, point.z) + 0.035;
      positions.push(
        point.x + nx * halfWidth, y, point.z + nz * halfWidth,
        point.x - nx * halfWidth, y, point.z - nz * halfWidth,
      );
      uvs.push(0, distance / 18, 1, distance / 18);
      if (index < corridor.points.length - 1) {
        const i = base + index * 2;
        indices.push(i, i + 2, i + 1, i + 2, i + 3, i + 1);
      }
    });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x486d67,
    emissive: 0x173d3b,
    emissiveIntensity: 0.04,
    roughness: 0.24,
    metalness: 0.02,
    clearcoat: 0.85,
    clearcoatRoughness: 0.18,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Kupa river';
  mesh.renderOrder = 0.5;
  mesh.receiveShadow = true;
  return { mesh, material };
}

function createRiverStones(map: FixedMap): THREE.Group {
  const group = new THREE.Group();
  group.name = 'River stones';
  const textureLoader = new THREE.TextureLoader();
  const albedo = configureTexture(textureLoader.load('/assets/textures/props/mossy_rock/albedo.png'), true);
  const normal = configureTexture(textureLoader.load('/assets/textures/props/mossy_rock/normal.png'));
  const roughness = configureTexture(textureLoader.load('/assets/textures/props/mossy_rock/roughness.png'));
  const material = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: normal,
    roughnessMap: roughness,
    roughness: 0.95,
    color: 0x9b9b86,
  });
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const placements: Placement[] = [];
  const rng = mulberry32(WORLD_SEED ^ 0x526f636b);

  for (const corridor of map.riverLayout.corridors) {
    for (let index = 2; index < corridor.points.length - 2; index += 2) {
      const point = corridor.points[index];
      const previous = corridor.points[index - 1];
      const next = corridor.points[index + 1];
      const dx = next.x - previous.x;
      const dz = next.z - previous.z;
      const length = Math.max(0.001, Math.hypot(dx, dz));
      const nx = -dz / length;
      const nz = dx / length;
      for (const side of [-1, 1]) {
        if (rng() < 0.22) continue;
        const offset = point.halfWidth * (0.75 + rng() * 0.36) * side;
        const x = point.x + nx * offset + (rng() - 0.5) * 2.4;
        const z = point.z + nz * offset + (rng() - 0.5) * 2.4;
        const scale = 0.3 + rng() * 1.05;
        placements.push({ x, z, y: map.getHeightAt(x, z) + scale * 0.28, rotation: rng() * Math.PI, scale });
      }
    }
  }

  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  mesh.name = 'Mossy river stones';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  placements.forEach((placement, index) => {
    quaternion.setFromEuler(new THREE.Euler(rng() * 0.45, placement.rotation, rng() * 0.4));
    matrix.compose(
      new THREE.Vector3(placement.x, placement.y, placement.z),
      quaternion,
      new THREE.Vector3(placement.scale * 1.35, placement.scale * 0.65, placement.scale),
    );
    mesh.setMatrixAt(index, matrix);
  });
  group.add(mesh);
  return group;
}

function createTrees(map: FixedMap): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Gorski Kotar woodland';
  const rng = mulberry32(WORLD_SEED ^ 0x54726565);
  const broadleaf: Placement[] = [];
  const conifer: Placement[] = [];

  for (let attempt = 0; attempt < 2_600 && broadleaf.length + conifer.length < 720; attempt++) {
    const x = (rng() * 2 - 1) * (TERRAIN_HALF - 14);
    const z = (rng() * 2 - 1) * (TERRAIN_HALF - 14);
    const playableEdge = Math.max(Math.abs(x), Math.abs(z)) / (PLAYABLE_SIZE * 0.5);
    const cluster = valueNoise(x * 0.008 + 18.2, z * 0.008 - 4.8);
    const density = THREE.MathUtils.clamp((cluster - 0.37) * 1.8 + Math.max(0, playableEdge - 0.64), 0, 1);
    if (rng() > density) continue;
    if (Math.hypot(x, z) < 58 || map.riverLayout.sampleRiverMask(x, z) > 0.04) continue;
    const scale = 0.75 + rng() * 0.75;
    const placement = { x, z, y: map.getHeightAt(x, z), rotation: rng() * Math.PI * 2, scale };
    if (rng() < 0.54 + Math.max(0, playableEdge - 0.7) * 0.28) conifer.push(placement);
    else broadleaf.push(placement);
  }

  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x5b4230, roughness: 1 });
  const broadleafMaterial = new THREE.MeshStandardMaterial({ color: 0x52713d, roughness: 0.96 });
  const coniferMaterial = new THREE.MeshStandardMaterial({ color: 0x36543b, roughness: 0.98 });
  const all = [...broadleaf, ...conifer];
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.42, 0.58, 7.2, 6), trunkMaterial, all.length);
  const broadCrowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(3.8, 1), broadleafMaterial, broadleaf.length);
  const coniferCrowns = new THREE.InstancedMesh(new THREE.ConeGeometry(3.5, 10.5, 7), coniferMaterial, conifer.length);
  trunks.name = 'Tree trunks';
  broadCrowns.name = 'Broadleaf crowns';
  coniferCrowns.name = 'Conifer crowns';
  trunks.castShadow = broadCrowns.castShadow = coniferCrowns.castShadow = true;
  trunks.receiveShadow = broadCrowns.receiveShadow = coniferCrowns.receiveShadow = true;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  all.forEach((placement, index) => {
    quaternion.setFromAxisAngle(UP, placement.rotation);
    position.set(placement.x, placement.y + 3.4 * placement.scale, placement.z);
    scale.set(placement.scale, placement.scale, placement.scale);
    matrix.compose(position, quaternion, scale);
    trunks.setMatrixAt(index, matrix);
  });
  broadleaf.forEach((placement, index) => {
    quaternion.setFromAxisAngle(UP, placement.rotation);
    position.set(placement.x, placement.y + 8.4 * placement.scale, placement.z);
    scale.set(placement.scale * 1.2, placement.scale, placement.scale * 1.1);
    matrix.compose(position, quaternion, scale);
    broadCrowns.setMatrixAt(index, matrix);
  });
  conifer.forEach((placement, index) => {
    quaternion.setFromAxisAngle(UP, placement.rotation);
    position.set(placement.x, placement.y + 8.6 * placement.scale, placement.z);
    scale.set(placement.scale, placement.scale, placement.scale);
    matrix.compose(position, quaternion, scale);
    coniferCrowns.setMatrixAt(index, matrix);
  });
  group.add(trunks, broadCrowns, coniferCrowns);
  return group;
}

function createGrass(map: FixedMap): { mesh: THREE.InstancedMesh; placements: Placement[] } {
  const rng = mulberry32(WORLD_SEED ^ 0x47726173);
  const placements: Placement[] = [];
  for (let attempt = 0; attempt < 18_000 && placements.length < 9_000; attempt++) {
    const x = (rng() * 2 - 1) * (TERRAIN_HALF - 8);
    const z = (rng() * 2 - 1) * (TERRAIN_HALF - 8);
    if (map.riverLayout.sampleRiverMask(x, z) > 0.06) continue;
    if (map.getHeightAt(x, z) > 170 && rng() < 0.62) continue;
    placements.push({
      x,
      z,
      y: map.getHeightAt(x, z) + 0.52,
      rotation: rng() * Math.PI,
      scale: 0.55 + rng() * 0.85,
    });
  }

  const geometry = createGrassTuftGeometry();
  const material = new THREE.MeshStandardMaterial({
    color: 0x6d873e,
    roughness: 1,
    side: THREE.DoubleSide,
    alphaTest: 0.35,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  mesh.name = 'Meadow grass';
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  placements.forEach((placement, index) => {
    quaternion.setFromAxisAngle(UP, placement.rotation);
    matrix.compose(
      new THREE.Vector3(placement.x, placement.y, placement.z),
      quaternion,
      new THREE.Vector3(placement.scale, placement.scale, placement.scale),
    );
    mesh.setMatrixAt(index, matrix);
  });
  return { mesh, placements };
}

function createGrassTuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const width = 0.26;
  const height = 1.15;
  for (let plane = 0; plane < 3; plane++) {
    const angle = plane * Math.PI / 3;
    const dx = Math.cos(angle) * width;
    const dz = Math.sin(angle) * width;
    positions.push(
      -dx, -height * 0.5, -dz, dx, -height * 0.5, dz, dx * 0.18, height * 0.5, dz * 0.18,
      -dx, -height * 0.5, -dz, dx * 0.18, height * 0.5, dz * 0.18, -dx * 0.18, height * 0.5, -dz * 0.18,
    );
    for (let vertex = 0; vertex < 6; vertex++) normals.push(0, 0.4, 0.6);
    uvs.push(0, 0, 1, 0, 0.6, 1, 0, 0, 0.6, 1, 0.4, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

function configureTexture(texture: THREE.Texture, srgb = false): THREE.Texture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.6, 1.6);
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const sample = (px: number, pz: number) => {
    const value = Math.sin(px * 127.1 + pz * 311.7) * 43758.5453123;
    return value - Math.floor(value);
  };
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(sample(ix, iz), sample(ix + 1, iz), sx),
    THREE.MathUtils.lerp(sample(ix, iz + 1), sample(ix + 1, iz + 1), sx),
    sz,
  );
}

function distanceToPolyline(x: number, z: number, path: THREE.Vector3[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < path.length - 1; index++) {
    const a = path[index];
    const b = path[index + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const lengthSq = abx * abx + abz * abz;
    const t = lengthSq < 1e-6
      ? 0
      : THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / lengthSq, 0, 1);
    best = Math.min(best, Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t)));
  }
  return best;
}

const UP = new THREE.Vector3(0, 1, 0);
