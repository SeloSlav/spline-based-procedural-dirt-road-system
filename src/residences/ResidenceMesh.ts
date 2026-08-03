import * as THREE from 'three';
import { mulberry32, pick } from '../utils/random.ts';

const materials = {
  stone: new THREE.MeshStandardMaterial({ color: 0xc8c0ae, roughness: 0.96 }),
  stoneDark: new THREE.MeshStandardMaterial({ color: 0x837e73, roughness: 0.98 }),
  plasterIvory: new THREE.MeshStandardMaterial({ color: 0xddd5c3, roughness: 0.94 }),
  plasterOchre: new THREE.MeshStandardMaterial({ color: 0xc6ad72, roughness: 0.94 }),
  plasterClay: new THREE.MeshStandardMaterial({ color: 0xb9815d, roughness: 0.95 }),
  timber: new THREE.MeshStandardMaterial({ color: 0x725239, roughness: 0.92 }),
  timberDark: new THREE.MeshStandardMaterial({ color: 0x493326, roughness: 0.96 }),
  timberWeathered: new THREE.MeshStandardMaterial({ color: 0x92765d, roughness: 0.97 }),
  shingle: new THREE.MeshStandardMaterial({ color: 0x51473d, roughness: 0.99 }),
  shingleLight: new THREE.MeshStandardMaterial({ color: 0x67594b, roughness: 0.98 }),
  tile: new THREE.MeshStandardMaterial({ color: 0x8c4534, roughness: 0.9 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x53666a, roughness: 0.34, metalness: 0.05 }),
  iron: new THREE.MeshStandardMaterial({ color: 0x2c2c29, roughness: 0.72, metalness: 0.38 }),
};

const facadeMaterials = [materials.plasterIvory, materials.plasterOchre, materials.plasterClay] as const;

export type ResidenceVisual = {
  group: THREE.Group;
  width: number;
  depth: number;
};

/**
 * Daylit, completed tier-one cottage adapted from the source residence art.
 * There are no construction states, emissive night windows, smoke simulation,
 * or backyard-improvement meshes in this client-only showcase.
 */
export function createResidenceMesh(seed: number): ResidenceVisual {
  const rng = mulberry32(seed);
  const width = 6.35 + rng() * 0.45;
  const depth = 7.1 + rng() * 0.45;
  const foundationHeight = 0.48;
  const wallHeight = 3.45 + rng() * 0.25;
  const ridgeHeight = 2.25 + rng() * 0.22;
  const halfWidth = width * 0.5;
  const halfDepth = depth * 0.5;
  const wallTop = foundationHeight + wallHeight;
  const roofOverhang = 0.62;
  const roofDepthOverhang = 0.72;
  const roofHalfSpan = halfWidth + roofOverhang;
  const pitch = Math.atan2(ridgeHeight, roofHalfSpan);
  const slopeLength = roofHalfSpan / Math.cos(pitch);
  const facade = pick(facadeMaterials, rng);
  const roof = rng() < 0.28 ? materials.tile : materials.shingle;
  const entrySide: -1 | 1 = rng() < 0.5 ? -1 : 1;

  const group = new THREE.Group();
  group.name = 'Completed residence';
  group.userData.residenceSeed = seed;
  group.userData.residenceWidth = width;
  group.userData.residenceDepth = depth;

  addBox(group, width + 0.42, foundationHeight, depth + 0.42, materials.stone, 0, foundationHeight * 0.5, 0, 'Limestone plinth');
  addBox(group, width + 0.5, 0.13, depth + 0.5, materials.stoneDark, 0, foundationHeight - 0.045, 0, 'Foundation cap');
  addBox(group, width - 0.14, wallHeight, depth - 0.14, facade, 0, foundationHeight + wallHeight * 0.5, 0, 'Limewashed wall core');

  addTimberFrame(group, width, depth, foundationHeight, wallHeight);
  addGable(group, halfWidth, halfDepth - 0.07, wallTop, ridgeHeight, facade);
  addGable(group, halfWidth, -halfDepth + 0.07, wallTop, ridgeHeight, facade);

  for (const side of [-1, 1] as const) {
    const plane = addBox(
      group,
      slopeLength,
      roof === materials.tile ? 0.16 : 0.19,
      depth + roofDepthOverhang * 2,
      roof,
      side * roofHalfSpan * 0.5,
      wallTop + ridgeHeight * 0.5,
      0,
      side < 0 ? 'Left roof plane' : 'Right roof plane',
    );
    plane.rotation.z = side * -pitch;
  }
  addRoofCourses(group, roof, roofHalfSpan, depth, roofDepthOverhang, wallTop, ridgeHeight, pitch, rng);

  const frontZ = halfDepth + 0.03;
  const doorX = entrySide * 1.03;
  addDoor(group, doorX, foundationHeight + 0.05, frontZ);
  addWindow(group, -entrySide * 1.18, foundationHeight + 1.78, frontZ + 0.015, 0, rng);
  addWindow(group, entrySide * (halfWidth + 0.03), foundationHeight + 1.76, -0.62, entrySide * Math.PI * 0.5, rng);
  addWindow(group, -entrySide * (halfWidth + 0.03), foundationHeight + 1.76, 0.48, -entrySide * Math.PI * 0.5, rng);

  addBox(group, 1.55, 0.17, 0.62, materials.stoneDark, doorX, 0.085, halfDepth + 0.38, 'Front step');
  addBox(group, 1.3, 0.16, 0.48, materials.stone, doorX, 0.245, halfDepth + 0.27, 'Upper step');
  addEntryCanopy(group, doorX, halfDepth, foundationHeight, roof, materials.timberDark);

  const chimneySide = (entrySide * -1) as -1 | 1;
  const chimneyX = chimneySide * (halfWidth - 0.8);
  const chimneyZ = -halfDepth + 1.18;
  addBox(group, 0.7, 2.1, 0.7, materials.stoneDark, chimneyX, wallTop + 1.28, chimneyZ, 'Stone chimney');
  addBox(group, 0.82, 0.17, 0.82, materials.stone, chimneyX, wallTop + 2.36, chimneyZ, 'Chimney cap');

  addYardCraft(group, entrySide, halfWidth, halfDepth, rng);
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  return { group, width, depth };
}

export function createResidencePreviewMesh(seed: number, valid: boolean): THREE.Group {
  const preview = createResidenceMesh(seed).group;
  const color = new THREE.Color(valid ? 0xece5d2 : 0xff5d50);
  preview.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: valid ? 0.42 : 0.3,
      depthWrite: false,
    });
    object.castShadow = false;
    object.receiveShadow = false;
    object.renderOrder = 18;
  });
  return preview;
}

function addTimberFrame(
  group: THREE.Group,
  width: number,
  depth: number,
  baseY: number,
  height: number,
): void {
  const halfWidth = width * 0.5;
  const halfDepth = depth * 0.5;
  const postHeight = height - 0.1;
  for (const x of [-halfWidth, 0, halfWidth]) {
    for (const z of [-halfDepth, halfDepth]) {
      addBox(group, 0.2, postHeight, 0.2, materials.timberDark, x, baseY + postHeight * 0.5, z, 'Hewn frame post');
    }
  }
  for (const z of [-halfDepth, halfDepth]) {
    addBox(group, width + 0.22, 0.2, 0.2, materials.timberDark, 0, baseY + 0.12, z, 'Sill beam');
    addBox(group, width + 0.25, 0.22, 0.22, materials.timberDark, 0, baseY + height - 0.11, z, 'Wall plate');
    for (const sign of [-1, 1]) {
      const brace = addBox(group, width * 0.34, 0.14, 0.14, materials.timber, sign * width * 0.25, baseY + height * 0.54, z + (z > 0 ? 0.03 : -0.03), 'Diagonal brace');
      brace.rotation.z = sign * 0.68;
    }
  }
  for (const x of [-halfWidth, halfWidth]) {
    addBox(group, 0.2, postHeight, 0.2, materials.timberDark, x, baseY + postHeight * 0.5, 0, 'Side frame post');
    addBox(group, 0.2, 0.2, depth + 0.2, materials.timberDark, x, baseY + height - 0.11, 0, 'Side wall plate');
  }
}

function addGable(
  group: THREE.Group,
  halfWidth: number,
  z: number,
  wallTop: number,
  ridgeHeight: number,
  material: THREE.Material,
): void {
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + 0.08, 0);
  shape.lineTo(halfWidth - 0.08, 0);
  shape.lineTo(0, ridgeHeight);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false });
  geometry.translate(0, wallTop, z > 0 ? z - 0.07 : z - 0.07);
  addMesh(group, geometry, material, 'Plastered gable');
  const left = addBox(group, halfWidth * 1.16, 0.15, 0.18, materials.timberDark, -halfWidth * 0.25, wallTop + ridgeHeight * 0.46, z, 'Gable rake timber');
  left.rotation.z = Math.atan2(ridgeHeight, halfWidth);
  const right = addBox(group, halfWidth * 1.16, 0.15, 0.18, materials.timberDark, halfWidth * 0.25, wallTop + ridgeHeight * 0.46, z, 'Gable rake timber');
  right.rotation.z = -Math.atan2(ridgeHeight, halfWidth);
}

function addRoofCourses(
  group: THREE.Group,
  roof: THREE.Material,
  halfSpan: number,
  depth: number,
  depthOverhang: number,
  wallTop: number,
  ridgeHeight: number,
  pitch: number,
  rng: () => number,
): void {
  const rows = 9;
  for (const side of [-1, 1] as const) {
    for (let row = 0; row < rows; row += 1) {
      const t = (row + 0.25) / rows;
      const x = side * halfSpan * (1 - t);
      const y = wallTop + ridgeHeight * t + 0.08;
      const course = addBox(
        group,
        halfSpan / rows * 1.28,
        0.07,
        depth + depthOverhang * 2 + (rng() - 0.5) * 0.08,
        roof === materials.tile ? materials.tile : row % 2 === 0 ? materials.shingleLight : materials.shingle,
        x,
        y,
        0,
        'Hand-laid roof course',
      );
      course.rotation.z = side * -pitch;
    }
  }
  addBox(group, 0.25, 0.24, depth + depthOverhang * 2 + 0.12, roof, 0, wallTop + ridgeHeight + 0.09, 0, 'Roof ridge cap');
}

function addDoor(group: THREE.Group, x: number, baseY: number, z: number): void {
  addBox(group, 1.08, 2.0, 0.13, materials.timberWeathered, x, baseY + 1, z, 'Plank front door');
  for (let plank = -2; plank <= 2; plank += 1) {
    addBox(group, 0.035, 1.88, 0.035, materials.timberDark, x + plank * 0.205, baseY + 1, z + 0.085, 'Door plank seam');
  }
  addBox(group, 1.2, 0.16, 0.17, materials.timberDark, x, baseY + 2.03, z, 'Door lintel');
  addBox(group, 0.08, 0.08, 0.07, materials.iron, x + 0.34, baseY + 0.96, z + 0.11, 'Door latch');
}

function addWindow(
  group: THREE.Group,
  x: number,
  y: number,
  z: number,
  yaw: number,
  rng: () => number,
): void {
  const root = new THREE.Group();
  root.position.set(x, y, z);
  root.rotation.y = yaw;
  group.add(root);
  addBox(root, 0.8, 0.82, 0.075, materials.glass, 0, 0, 0, 'Daylight window');
  addBox(root, 0.94, 0.1, 0.12, materials.timberDark, 0, 0.46, 0, 'Window lintel');
  addBox(root, 0.94, 0.1, 0.12, materials.timberDark, 0, -0.46, 0, 'Window sill');
  addBox(root, 0.1, 0.84, 0.12, materials.timberDark, -0.45, 0, 0, 'Window jamb');
  addBox(root, 0.1, 0.84, 0.12, materials.timberDark, 0.45, 0, 0, 'Window jamb');
  addBox(root, 0.06, 0.8, 0.11, materials.timber, 0, 0, 0.035, 'Window mullion');
  addBox(root, 0.78, 0.06, 0.11, materials.timber, 0, 0, 0.035, 'Window crossbar');
  const shutterMaterial = rng() < 0.5 ? materials.timberWeathered : materials.timber;
  const left = addBox(root, 0.34, 0.82, 0.08, shutterMaterial, -0.64, 0, -0.01, 'Open shutter');
  left.rotation.y = -0.24;
  const right = addBox(root, 0.34, 0.82, 0.08, shutterMaterial, 0.64, 0, -0.01, 'Open shutter');
  right.rotation.y = 0.24;
}

function addEntryCanopy(
  group: THREE.Group,
  doorX: number,
  halfDepth: number,
  baseY: number,
  roof: THREE.Material,
  timber: THREE.Material,
): void {
  addBox(group, 0.16, 2.05, 0.16, timber, doorX - 0.7, baseY + 1.02, halfDepth + 0.82, 'Canopy post');
  addBox(group, 0.16, 2.05, 0.16, timber, doorX + 0.7, baseY + 1.02, halfDepth + 0.82, 'Canopy post');
  const canopy = addBox(group, 1.78, 0.14, 1.42, roof, doorX, baseY + 2.19, halfDepth + 0.55, 'Shingled entry canopy');
  canopy.rotation.x = -0.13;
}

function addYardCraft(
  group: THREE.Group,
  entrySide: -1 | 1,
  halfWidth: number,
  halfDepth: number,
  rng: () => number,
): void {
  const side = -entrySide;
  addBox(group, 0.64, 0.38, 0.58, materials.timberDark, side * (halfWidth - 0.42), 0.19, halfDepth + 0.86, 'Chopping block');
  const handle = addBox(group, 0.08, 0.9, 0.08, materials.timber, side * (halfWidth - 0.4), 0.73, halfDepth + 0.84, 'Axe handle');
  handle.rotation.z = side * (0.17 + rng() * 0.08);
  addBox(group, 0.34, 0.28, 0.08, materials.iron, side * (halfWidth - 0.32), 1.12, halfDepth + 0.84, 'Axe head');
  for (let index = 0; index < 5; index += 1) {
    const log = addBox(group, 1.65, 0.2, 0.2, index % 2 ? materials.timber : materials.timberWeathered, -side * (halfWidth - 0.65), 0.13 + Math.floor(index / 3) * 0.19, -halfDepth - 0.46 + (index % 3) * 0.23, 'Stacked firewood');
    log.rotation.z = Math.PI * 0.5;
  }
}

function addBox(
  parent: THREE.Object3D,
  width: number,
  height: number,
  depth: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  name: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  parent.add(mesh);
  return mesh;
}
