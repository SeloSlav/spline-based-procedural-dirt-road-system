import * as THREE from 'three';
import type { Point2 } from '../utils/polygonGeometry.ts';
import { getParcelDividerSegments, type BurgageLayoutResult } from './burgageLayout.ts';

const VALID_COLOR = 0xfffdf5;
const INVALID_COLOR = 0xff5d50;

export type ResidencePreviewState = {
  corners: THREE.Vector3[];
  outline: THREE.Vector3[];
  frontagePointCount: number;
  placedPoints: THREE.Vector3[];
  hoverPoint: THREE.Vector3 | null;
  layout: BurgageLayoutResult | null;
  stage: number;
  valid: boolean;
  getHeightAt: (x: number, z: number) => number;
};

export class ResidencePreview {
  readonly group = new THREE.Group();
  private readonly fillMaterial = overlayMaterial(0.1);
  private readonly borderMaterial = overlayMaterial(0.9);
  private readonly frontageMaterial = overlayMaterial(0.98);
  private readonly dividerMaterial = overlayMaterial(0.7);
  private readonly markerMaterial = overlayMaterial(0.98);
  private readonly fill = new THREE.Mesh(new THREE.BufferGeometry(), this.fillMaterial);
  private readonly border = new THREE.Mesh(new THREE.BufferGeometry(), this.borderMaterial);
  private readonly frontage = new THREE.Mesh(new THREE.BufferGeometry(), this.frontageMaterial);
  private readonly dividers = new THREE.Mesh(new THREE.BufferGeometry(), this.dividerMaterial);
  private readonly footprintOutlines = new THREE.Mesh(new THREE.BufferGeometry(), this.dividerMaterial);
  private readonly markers = new THREE.InstancedMesh(
    new THREE.RingGeometry(0.25, 0.48, 20).rotateX(-Math.PI * 0.5),
    this.markerMaterial,
    5,
  );
  private readonly markerMatrix = new THREE.Matrix4();

  constructor(parent: THREE.Object3D) {
    this.group.name = 'Residence frontage placement preview';
    this.group.visible = false;
    parent.add(this.group);
    for (const [index, mesh] of [this.fill, this.border, this.frontage, this.dividers, this.footprintOutlines].entries()) {
      mesh.renderOrder = 12 + index;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
    }
    this.markers.name = 'Residence frontage anchors';
    this.markers.renderOrder = 18;
    this.markers.frustumCulled = false;
    this.markers.count = 0;
    this.group.add(this.markers);
  }

  update(state: ResidencePreviewState): void {
    const { corners, outline, frontagePointCount, layout, getHeightAt } = state;
    this.group.visible = corners.length > 0 || outline.length > 0 || Boolean(state.hoverPoint);
    this.setValidity(state.valid || corners.length !== 4);

    if (corners.length === 4) {
      replaceGeometry(this.fill, createQuadFill(corners, getHeightAt, 0.105));
      this.fill.visible = true;
    } else {
      this.fill.visible = false;
    }

    const outlinePoints = outline.length >= 2 ? outline : corners;
    const frontageEnd = Math.max(0, Math.min(outlinePoints.length - 1, frontagePointCount - 1));
    const frontageSegments: Array<[Point2, Point2]> = [];
    for (let index = 0; index < frontageEnd; index += 1) {
      frontageSegments.push([toPoint(outlinePoints[index]), toPoint(outlinePoints[index + 1])]);
    }
    replaceGeometry(
      this.frontage,
      createRibbonGeometry(frontageSegments, getHeightAt, 0.24, 0.21, true),
    );
    this.frontage.visible = frontageSegments.length > 0;

    const borderSegments: Array<[Point2, Point2]> = [];
    if (outlinePoints.length >= 2) {
      for (let index = frontageEnd; index < outlinePoints.length - 1; index += 1) {
        borderSegments.push([toPoint(outlinePoints[index]), toPoint(outlinePoints[index + 1])]);
      }
      if (outlinePoints.length >= 4) {
        borderSegments.push([toPoint(outlinePoints.at(-1)!), toPoint(outlinePoints[0])]);
      }
    }
    replaceGeometry(
      this.border,
      createRibbonGeometry(borderSegments, getHeightAt, 0.16, 0.17, true),
    );
    this.border.visible = borderSegments.length > 0;

    const dividerSegments = layout ? getParcelDividerSegments(layout) : [];
    replaceGeometry(
      this.dividers,
      createRibbonGeometry(dividerSegments, getHeightAt, 0.1, 0.16, false),
    );
    this.dividers.visible = dividerSegments.length > 0;

    const footprintSegments: Array<[Point2, Point2]> = [];
    if (layout) {
      for (const residence of layout.residences) {
        const corners2 = residenceFootprint(residence.x, residence.z, residence.yaw, 3.3, 3.7);
        for (let index = 0; index < corners2.length; index += 1) {
          footprintSegments.push([corners2[index], corners2[(index + 1) % corners2.length]]);
        }
      }
    }
    replaceGeometry(
      this.footprintOutlines,
      createRibbonGeometry(footprintSegments, getHeightAt, 0.09, 0.19, false),
    );
    this.footprintOutlines.visible = footprintSegments.length > 0;

    const markers = [...state.placedPoints];
    if (state.hoverPoint && state.stage < 4) markers.push(state.hoverPoint);
    this.markers.count = Math.min(markers.length, 5);
    markers.slice(0, 5).forEach((point, index) => {
      const scale = index === markers.length - 1 && state.hoverPoint ? 1.16 : 1;
      this.markerMatrix.compose(
        new THREE.Vector3(point.x, getHeightAt(point.x, point.z) + 0.22, point.z),
        new THREE.Quaternion(),
        new THREE.Vector3(scale, scale, scale),
      );
      this.markers.setMatrixAt(index, this.markerMatrix);
    });
    this.markers.instanceMatrix.needsUpdate = markers.length > 0;
  }

  clear(): void {
    this.group.visible = false;
    this.markers.count = 0;
  }

  private setValidity(valid: boolean): void {
    const color = valid ? VALID_COLOR : INVALID_COLOR;
    for (const material of [
      this.fillMaterial,
      this.borderMaterial,
      this.frontageMaterial,
      this.dividerMaterial,
      this.markerMaterial,
    ]) material.color.setHex(color);
    this.fillMaterial.opacity = valid ? 0.1 : 0.08;
  }
}

function createQuadFill(
  corners: THREE.Vector3[],
  getHeightAt: (x: number, z: number) => number,
  lift: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const index of [0, 1, 2, 0, 2, 3]) {
    const point = corners[index];
    positions.push(point.x, getHeightAt(point.x, point.z) + lift, point.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function createRibbonGeometry(
  segments: Array<[Point2, Point2]>,
  getHeightAt: (x: number, z: number) => number,
  width: number,
  lift: number,
  dashed: boolean,
): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const [start, end] of segments) {
    const length = Math.hypot(end.x - start.x, end.z - start.z);
    if (length <= 0.05) continue;
    const dashLength = dashed ? 1.35 : length;
    const gapLength = dashed ? 0.78 : 0;
    const stride = dashLength + gapLength;
    const dashCount = dashed ? Math.ceil(length / stride) : 1;
    for (let dash = 0; dash < dashCount; dash += 1) {
      const fromDistance = dash * stride;
      const toDistance = Math.min(length, fromDistance + dashLength);
      if (toDistance <= fromDistance) continue;
      const a = lerp(start, end, fromDistance / length);
      const b = lerp(start, end, toDistance / length);
      pushRibbonQuad(positions, a, b, getHeightAt, width, lift);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function pushRibbonQuad(
  positions: number[],
  a: Point2,
  b: Point2,
  getHeightAt: (x: number, z: number) => number,
  width: number,
  lift: number,
): void {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length <= 1e-6) return;
  const nx = -dz / length * width * 0.5;
  const nz = dx / length * width * 0.5;
  const points = [
    { x: a.x + nx, z: a.z + nz },
    { x: a.x - nx, z: a.z - nz },
    { x: b.x - nx, z: b.z - nz },
    { x: b.x + nx, z: b.z + nz },
  ];
  for (const index of [0, 1, 2, 0, 2, 3]) {
    const point = points[index];
    positions.push(point.x, getHeightAt(point.x, point.z) + lift, point.z);
  }
}

function residenceFootprint(
  x: number,
  z: number,
  yaw: number,
  halfWidth: number,
  halfDepth: number,
): Point2[] {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [
    { x: -halfWidth, z: -halfDepth },
    { x: halfWidth, z: -halfDepth },
    { x: halfWidth, z: halfDepth },
    { x: -halfWidth, z: halfDepth },
  ].map((point) => ({
    x: x + point.x * cos + point.z * sin,
    z: z - point.x * sin + point.z * cos,
  }));
}

function overlayMaterial(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: VALID_COLOR,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

function replaceGeometry(mesh: THREE.Mesh, geometry: THREE.BufferGeometry): void {
  mesh.geometry.dispose();
  mesh.geometry = geometry;
}

function toPoint(point: THREE.Vector3): Point2 {
  return { x: point.x, z: point.z };
}

function lerp(a: Point2, b: Point2, t: number): Point2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}
