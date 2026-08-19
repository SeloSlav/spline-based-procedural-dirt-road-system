import * as THREE from 'three';
import type { RoadEdge } from '../roads/RoadEdge.ts';
import type { RoadNetwork } from '../roads/RoadNetwork.ts';
import { getEdgePath, roadPerpendicular } from '../roads/roadEndpoint.ts';
import type { FixedMap } from '../terrain/FixedMap.ts';
import type { Point2 } from '../utils/polygonGeometry.ts';
import {
  MAX_ZONE_DEPTH,
  MIN_PLOT_FRONTAGE,
  MIN_ZONE_DEPTH,
  cornersFromPoints,
  measureZoneDepth,
  measureZoneSideDepths,
  resolveBurgageLayout,
  suggestPlotCount,
  type BurgageLayoutResult,
  type BurgageZoneCorners,
} from './burgageLayout.ts';
import { ResidencePreview } from './ResidencePreview.ts';
import { ResidenceSystem } from './ResidenceSystem.ts';

const ROAD_SNAP_DISTANCE = 7.5;
const ROAD_SETBACK = 0.35;
const MIN_POINT_DISTANCE = 1.2;

type FrontageSnap = {
  point: THREE.Vector3;
  center: THREE.Vector3;
  tangent: THREE.Vector3;
  side: 1 | -1;
};

type PlacementSpec = {
  corners: BurgageZoneCorners;
  plotCount: number;
};

export type ResidenceToolState = {
  enabled: boolean;
  hasDraft: boolean;
  canBuild: boolean;
  stage: number;
  plotCount: number;
  residenceCount: number;
  message: string;
};

export class ResidenceTool {
  private readonly domElement: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly terrainMesh: THREE.Mesh;
  private readonly map: FixedMap;
  private readonly network: RoadNetwork;
  private readonly system: ResidenceSystem;
  private readonly preview: ResidencePreview;
  private readonly onStateChanged: (state: ResidenceToolState) => void;
  private readonly onPlaced: () => void;
  private readonly onToggleRequested?: () => void;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private enabled = false;
  private stage = 0;
  private frontagePoints: THREE.Vector3[] = [];
  private frontageCenters: THREE.Vector3[] = [];
  private rearPoints: THREE.Vector3[] = [];
  private lockedSide: 1 | -1 | null = null;
  private hoverPoint: THREE.Vector3 | null = null;
  private hoverSnap: FrontageSnap | null = null;
  private corners: THREE.Vector3[] = [];
  private outline: THREE.Vector3[] = [];
  private frontagePointCount = 0;
  private layout: BurgageLayoutResult | null = null;
  private plotCount = 1;
  private plotCountTouched = false;
  private validationMessage: string | null = null;
  private statusMessage = 'Click beside a road to start the residence frontage';
  private readonly undoStack: Array<{ zoneId: string; spec: PlacementSpec }> = [];
  private readonly redoStack: PlacementSpec[] = [];

  constructor(options: {
    domElement: HTMLElement;
    camera: THREE.Camera;
    terrainMesh: THREE.Mesh;
    map: FixedMap;
    network: RoadNetwork;
    system: ResidenceSystem;
    previewParent: THREE.Object3D;
    onStateChanged: (state: ResidenceToolState) => void;
    onPlaced: () => void;
    onToggleRequested?: () => void;
  }) {
    this.domElement = options.domElement;
    this.camera = options.camera;
    this.terrainMesh = options.terrainMesh;
    this.map = options.map;
    this.network = options.network;
    this.system = options.system;
    this.preview = new ResidencePreview(options.previewParent);
    this.onStateChanged = options.onStateChanged;
    this.onPlaced = options.onPlaced;
    this.onToggleRequested = options.onToggleRequested;
    this.domElement.addEventListener('mousedown', this.onPointerDown, { capture: true });
    this.domElement.addEventListener('mousemove', this.onPointerMove);
    this.domElement.addEventListener('mouseleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKeyDown);
    this.emitState();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  hasDraft(): boolean {
    return this.stage > 0;
  }

  isDraftBuildable(): boolean {
    return this.stage >= 4 && Boolean(this.layout) && !this.validationMessage;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.cancelDraft(false);
    else this.statusMessage = this.network.edges.size > 0
      ? 'Click beside a road to start the residence frontage'
      : 'Build a road first, then place residences along its frontage';
    this.emitState();
  }

  activateOrCommit(): void {
    if (this.isDraftBuildable()) this.commit();
    else if (!this.enabled) this.onToggleRequested?.();
  }

  getCursor(): string | null {
    return this.enabled ? 'crosshair' : null;
  }

  shouldIgnoreCameraInput(event: MouseEvent | WheelEvent): boolean {
    if (!this.enabled) return false;
    return event instanceof MouseEvent && (event.button === 0 || event.button === 2);
  }

  getBuildButtonPosition(): { clientX: number; clientY: number } | null {
    if (!this.isDraftBuildable() || this.corners.length !== 4) return null;
    const anchor = this.corners[1].clone();
    anchor.y += 2.2;
    anchor.project(this.camera);
    if (anchor.z < -1 || anchor.z > 1) return null;
    const rect = this.domElement.getBoundingClientRect();
    return {
      clientX: rect.left + (anchor.x * 0.5 + 0.5) * rect.width,
      clientY: rect.top + (-anchor.y * 0.5 + 0.5) * rect.height,
    };
  }

  adjustPlotCount(delta: number): void {
    if (this.stage < 4 || !this.layout || delta === 0) return;
    const next = THREE.MathUtils.clamp(this.plotCount + delta, 1, this.layout.maxPlotCount);
    if (next === this.plotCount) return;
    this.plotCount = next;
    this.plotCountTouched = true;
    this.refreshFinalLayout();
  }

  commit(): void {
    if (!this.isDraftBuildable() || this.corners.length !== 4 || !this.layout) return;
    const corners = cornersFromPoints(this.corners.map(toPoint));
    if (!corners) return;
    const zone = this.system.addZone(corners, this.layout);
    this.undoStack.push({ zoneId: zone.id, spec: { corners, plotCount: this.plotCount } });
    this.redoStack.length = 0;
    const count = this.layout.residences.length;
    this.cancelDraft(false);
    this.statusMessage = `${count} ${count === 1 ? 'residence' : 'residences'} constructed instantly`;
    this.onPlaced();
    this.emitState();
  }

  undo(): void {
    if (this.hasDraft()) {
      this.undoDraftStep();
      return;
    }
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.system.removeZone(entry.zoneId);
    this.redoStack.push(entry.spec);
    this.statusMessage = 'Last residence frontage removed';
    this.onPlaced();
    this.emitState();
  }

  redo(): void {
    const spec = this.redoStack.pop();
    if (!spec) return;
    const layout = resolveBurgageLayout(spec.corners, 0, spec.plotCount);
    if (!layout) return;
    const zone = this.system.addZone(spec.corners, layout);
    this.undoStack.push({ zoneId: zone.id, spec });
    this.statusMessage = 'Residence frontage restored instantly';
    this.onPlaced();
    this.emitState();
  }

  clearAll(): void {
    this.cancelDraft(false);
    this.system.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.statusMessage = 'All residences cleared';
    this.onPlaced();
    this.emitState();
  }

  private readonly onPointerDown = (event: MouseEvent): void => {
    if (!this.enabled) return;
    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
      if (this.hasDraft()) this.undoDraftStep();
      else this.setEnabled(false);
      return;
    }
    if (event.button !== 0 || event.altKey) return;
    const hit = this.pick(event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();

    if (this.stage >= 4) {
      this.commit();
      return;
    }

    if (this.stage < 2) {
      const snap = this.snapBesideRoad(hit, this.lockedSide);
      if (!snap) {
        this.statusMessage = 'Frontage points must sit beside a road';
        this.emitState();
        return;
      }
      const previous = this.frontagePoints.at(-1);
      if (previous && distanceXZ(previous, snap.point) < MIN_POINT_DISTANCE) {
        this.statusMessage = 'Move farther along the road for the second frontage point';
        this.emitState();
        return;
      }
      this.lockedSide = snap.side;
      this.frontagePoints.push(snap.point);
      this.frontageCenters.push(snap.center);
      this.stage = this.frontagePoints.length;
      this.statusMessage = this.stage === 1
        ? 'Click farther along the same road to set frontage width'
        : `Click the first back corner (${Math.round(MIN_ZONE_DEPTH)}–${Math.round(MAX_ZONE_DEPTH)} m from the road)`;
      this.refreshPreview();
      return;
    }

    const previous = this.rearPoints.at(-1) ?? this.frontagePoints.at(-1);
    if (previous && distanceXZ(previous, hit) < MIN_POINT_DISTANCE) {
      this.statusMessage = 'Move farther away before setting the next plot corner';
      this.emitState();
      return;
    }

    if (this.stage === 2) {
      this.rearPoints = [hit.clone()];
      this.stage = 3;
      this.hoverPoint = null;
      this.statusMessage = 'Click the other back corner to shape the angled rear boundary';
      this.refreshPreview();
      return;
    }

    const zone = this.buildZone(this.rearPoints[0], hit);
    if (!zone) {
      this.statusMessage = `Frontage must be at least ${MIN_PLOT_FRONTAGE} m long`;
      this.emitState();
      return;
    }
    this.rearPoints.push(hit.clone());
    this.corners = zone.corners;
    this.outline = zone.outline;
    this.frontagePointCount = zone.frontagePointCount;
    this.stage = 4;
    this.plotCount = suggestPlotCount(distanceXZ(this.corners[0], this.corners[1]));
    this.plotCountTouched = false;
    this.refreshFinalLayout();
  };

  private readonly onPointerMove = (event: MouseEvent): void => {
    if (!this.enabled) return;
    const hit = this.pick(event.clientX, event.clientY);
    this.hoverPoint = hit;
    this.hoverSnap = hit && this.stage < 2 ? this.snapBesideRoad(hit, this.lockedSide) : null;
    if (hit && (this.stage === 2 || this.stage === 3)) this.updateBackCornerStatus(hit);
    this.refreshPreview();
  };

  private readonly onPointerLeave = (): void => {
    this.hoverPoint = null;
    this.hoverSnap = null;
    this.refreshPreview();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'b') {
      event.preventDefault();
      this.onToggleRequested?.();
      return;
    }
    if (!this.enabled) return;
    if (key === 'escape') {
      event.preventDefault();
      if (this.hasDraft()) this.cancelDraft();
      else this.setEnabled(false);
      return;
    }
    if (key === 'backspace' && this.hasDraft()) {
      event.preventDefault();
      this.undoDraftStep();
      return;
    }
    if (key === 'enter') {
      event.preventDefault();
      this.commit();
      return;
    }
    if (key === '+' || key === '=') {
      event.preventDefault();
      this.adjustPlotCount(1);
      return;
    }
    if (key === '-' || key === '_') {
      event.preventDefault();
      this.adjustPlotCount(-1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      this.undo();
    } else if ((event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault();
      this.redo();
    }
  };

  private refreshPreview(): void {
    if (!this.enabled) return;
    if (this.stage >= 4) {
      this.renderPreview();
      return;
    }

    if (this.stage === 0) {
      const snap = this.hoverSnap;
      if (!snap) {
        this.preview.clear();
        this.emitState();
        return;
      }
      const half = 5;
      const points = [
        this.map.getPointAt(snap.point.x - snap.tangent.x * half, snap.point.z - snap.tangent.z * half),
        this.map.getPointAt(snap.point.x + snap.tangent.x * half, snap.point.z + snap.tangent.z * half),
      ];
      this.preview.update({
        corners: [],
        outline: points,
        frontagePointCount: 2,
        placedPoints: [],
        hoverPoint: snap.point,
        layout: null,
        stage: 0,
        valid: true,
        getHeightAt: this.map.getHeightAt.bind(this.map),
      });
      this.emitState();
      return;
    }

    if (this.stage === 1) {
      const second = this.hoverSnap;
      const front = second
        ? this.resolveFrontagePath(this.frontageCenters[0], second.center, this.lockedSide ?? 1)
        : [this.frontagePoints[0]];
      this.preview.update({
        corners: front,
        outline: front,
        frontagePointCount: front.length,
        placedPoints: this.frontagePoints,
        hoverPoint: second?.point ?? this.hoverPoint,
        layout: null,
        stage: 1,
        valid: front.length >= 2,
        getHeightAt: this.map.getHeightAt.bind(this.map),
      });
      this.emitState();
      return;
    }

    if ((this.stage === 2 || this.stage === 3) && this.hoverPoint) {
      const zone = this.stage === 2
        ? this.buildZone(this.hoverPoint)
        : this.buildZone(this.rearPoints[0], this.hoverPoint);
      if (zone) {
        const corners = cornersFromPoints(zone.corners.map(toPoint));
        const plotCount = corners ? suggestPlotCount(distanceXZ(zone.corners[0], zone.corners[1])) : 1;
        const layout = corners ? resolveBurgageLayout(corners, 0, plotCount) : null;
        const depthMessage = corners ? this.validateDepth(corners) : null;
        this.preview.update({
          corners: zone.corners,
          outline: zone.outline,
          frontagePointCount: zone.frontagePointCount,
          placedPoints: [...this.frontagePoints, ...this.rearPoints],
          hoverPoint: this.hoverPoint,
          layout,
          stage: this.stage,
          valid: Boolean(layout) && !depthMessage,
          getHeightAt: this.map.getHeightAt.bind(this.map),
        });
      }
    } else if (this.stage === 3) {
      const frontEdge = this.resolveFrontagePath(
        this.frontageCenters[0],
        this.frontageCenters[1],
        this.lockedSide ?? 1,
      );
      const partialCorners = [frontEdge[0], frontEdge.at(-1)!, ...this.rearPoints];
      this.preview.update({
        corners: partialCorners,
        outline: [...frontEdge, ...this.rearPoints],
        frontagePointCount: frontEdge.length,
        placedPoints: [...this.frontagePoints, ...this.rearPoints],
        hoverPoint: null,
        layout: null,
        stage: 3,
        valid: true,
        getHeightAt: this.map.getHeightAt.bind(this.map),
      });
    }
    this.emitState();
  }

  private refreshFinalLayout(): void {
    const corners = cornersFromPoints(this.corners.map(toPoint));
    this.layout = corners ? resolveBurgageLayout(corners, 0, this.plotCount) : null;
    if (this.layout && !this.plotCountTouched) this.plotCount = this.layout.plotCount;
    this.validationMessage = !corners
      ? 'The four points must form a simple, convex residence plot'
      : this.validateDepth(corners)
        ?? (!this.layout
          ? 'Frontage is too short or the angled plots are too shallow'
          : this.system.validatePlacement(corners, this.layout));
    if (this.validationMessage) this.statusMessage = this.validationMessage;
    else if (this.layout) {
      const count = this.layout.residences.length;
      this.statusMessage = `${count} ${count === 1 ? 'residence' : 'residences'} ready · +/− adjusts plots · Enter builds instantly`;
    }
    this.renderPreview();
  }

  private renderPreview(): void {
    this.preview.update({
      corners: this.corners,
      outline: this.outline,
      frontagePointCount: this.frontagePointCount,
      placedPoints: this.corners,
      hoverPoint: null,
      layout: this.layout,
      stage: this.stage,
      valid: !this.validationMessage,
      getHeightAt: this.map.getHeightAt.bind(this.map),
    });
    this.emitState();
  }

  private buildZone(firstRear: THREE.Vector3, secondRear?: THREE.Vector3): {
    corners: THREE.Vector3[];
    outline: THREE.Vector3[];
    frontagePointCount: number;
  } | null {
    if (this.frontagePoints.length < 2 || this.frontageCenters.length < 2) return null;
    const frontEdge = this.resolveFrontagePath(
      this.frontageCenters[0],
      this.frontageCenters[1],
      this.lockedSide ?? 1,
    );
    if (frontEdge.length < 2) return null;
    const frontStart = frontEdge[0];
    const frontEnd = frontEdge.at(-1)!;
    if (distanceXZ(frontStart, frontEnd) < MIN_PLOT_FRONTAGE * 0.5) return null;

    const inferredSecondRear = secondRear ?? this.map.getPointAt(
      frontStart.x + (firstRear.x - frontEnd.x),
      frontStart.z + (firstRear.z - frontEnd.z),
    );
    const corners = [
      frontStart.clone(),
      frontEnd.clone(),
      firstRear.clone(),
      inferredSecondRear.clone(),
    ];
    return {
      corners,
      outline: [
        ...frontEdge.map((point) => point.clone()),
        firstRear.clone(),
        inferredSecondRear.clone(),
      ],
      frontagePointCount: frontEdge.length,
    };
  }

  private validateDepth(corners: BurgageZoneCorners): string | null {
    const minimumDepth = measureZoneDepth(corners, 0);
    if (minimumDepth < MIN_ZONE_DEPTH - 0.05) {
      return `A back corner is too shallow — keep at least ${Math.round(MIN_ZONE_DEPTH)} m behind the road`;
    }
    const sideDepths = measureZoneSideDepths(corners, 0);
    if (Math.max(...sideDepths) > MAX_ZONE_DEPTH + 0.05) {
      return `A back corner is too deep — keep it within ${Math.round(MAX_ZONE_DEPTH)} m of the road`;
    }
    return null;
  }

  private updateBackCornerStatus(point: THREE.Vector3): void {
    const anchorIndex = this.stage === 3 ? 0 : 1;
    const front = this.frontagePoints[anchorIndex];
    const center = this.frontageCenters[anchorIndex];
    if (!front || !center) return;
    const inward = new THREE.Vector3(front.x - center.x, 0, front.z - center.z);
    if (inward.lengthSq() <= 1e-5) return;
    inward.normalize();
    const depth = (point.x - front.x) * inward.x + (point.z - front.z) * inward.z;
    const corner = this.stage === 3 ? 'Second' : 'First';
    if (depth < MIN_ZONE_DEPTH - 0.05) {
      this.statusMessage = `${corner} back corner is too shallow — pull farther from the road (~${Math.round(MIN_ZONE_DEPTH)} m min)`;
    } else if (depth > MAX_ZONE_DEPTH + 0.05) {
      this.statusMessage = `${corner} back corner is too deep — move closer to the road (~${Math.round(MAX_ZONE_DEPTH)} m max)`;
    } else {
      this.statusMessage = `Click to set the ${corner.toLowerCase()} back corner (point ${this.stage + 1}/4 · ~${Math.round(depth)} m deep)`;
    }
  }

  private snapBesideRoad(cursor: THREE.Vector3, lockedSide: 1 | -1 | null): FrontageSnap | null {
    const snap = this.network.findSnap(cursor, ROAD_SNAP_DISTANCE);
    if (!snap) return null;
    const { tangent, halfWidth } = tangentAndWidth(snap, this.network);
    const normal = roadPerpendicular(tangent);
    const side = lockedSide ?? (normal.x * (cursor.x - snap.point.x) + normal.z * (cursor.z - snap.point.z) >= 0 ? 1 : -1);
    const offset = halfWidth + ROAD_SETBACK;
    return {
      point: this.map.getPointAt(
        snap.point.x + normal.x * offset * side,
        snap.point.z + normal.z * offset * side,
      ),
      center: this.map.getPointAt(snap.point.x, snap.point.z),
      tangent,
      side,
    };
  }

  private resolveFrontagePath(start: THREE.Vector3, end: THREE.Vector3, side: 1 | -1): THREE.Vector3[] {
    const anchorA = nearestEdgeAnchor(this.network, start);
    const anchorB = nearestEdgeAnchor(this.network, end);
    if (anchorA && anchorB && anchorA.edge.id === anchorB.edge.id) {
      const from = Math.min(anchorA.distanceAlong, anchorB.distanceAlong);
      const to = Math.max(anchorA.distanceAlong, anchorB.distanceAlong);
      const centerPath = slicePath(anchorA.path, from, to, 1.1);
      const offsetPath = centerPath.map((center, index) => {
        const previous = centerPath[Math.max(0, index - 1)];
        const next = centerPath[Math.min(centerPath.length - 1, index + 1)];
        const tangent = new THREE.Vector3(next.x - previous.x, 0, next.z - previous.z).normalize();
        const normal = roadPerpendicular(tangent);
        const offset = anchorA.edge.width * 0.5 + ROAD_SETBACK;
        return this.map.getPointAt(center.x + normal.x * offset * side, center.z + normal.z * offset * side);
      });
      if (anchorA.distanceAlong > anchorB.distanceAlong) offsetPath.reverse();
      return offsetPath;
    }
    return [this.frontagePoints[0]?.clone() ?? start.clone(), this.hoverSnap?.point.clone() ?? this.frontagePoints[1]?.clone() ?? end.clone()];
  }

  private undoDraftStep(): void {
    if (this.stage >= 4) {
      this.rearPoints.pop();
      this.stage = 3;
      this.corners = [];
      this.outline = [];
      this.layout = null;
      this.validationMessage = null;
    } else if (this.stage === 3) {
      this.rearPoints.pop();
      this.stage = 2;
    } else if (this.stage === 2) {
      this.frontagePoints.pop();
      this.frontageCenters.pop();
      this.stage = 1;
    } else {
      this.cancelDraft(false);
    }
    this.statusMessage = this.stage === 3
      ? 'Click the other back corner to shape the angled rear boundary'
      : this.stage === 2
      ? 'Click the first back corner behind the frontage'
      : this.stage === 1
        ? 'Click farther along the road to set frontage width'
        : 'Click beside a road to start the residence frontage';
    this.refreshPreview();
  }

  private cancelDraft(emit = true): void {
    this.stage = 0;
    this.frontagePoints = [];
    this.frontageCenters = [];
    this.rearPoints = [];
    this.lockedSide = null;
    this.hoverPoint = null;
    this.hoverSnap = null;
    this.corners = [];
    this.outline = [];
    this.frontagePointCount = 0;
    this.layout = null;
    this.plotCount = 1;
    this.plotCountTouched = false;
    this.validationMessage = null;
    this.preview.clear();
    if (emit) {
      this.statusMessage = 'Click beside a road to start the residence frontage';
      this.emitState();
    }
  }

  private pick(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.pointer.set(
      (clientX - rect.left) / rect.width * 2 - 1,
      -((clientY - rect.top) / rect.height * 2 - 1),
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObject(this.terrainMesh, false)[0]?.point ?? null;
  }

  private emitState(): void {
    this.onStateChanged({
      enabled: this.enabled,
      hasDraft: this.hasDraft(),
      canBuild: this.isDraftBuildable(),
      stage: this.stage,
      plotCount: this.plotCount,
      residenceCount: this.layout?.residences.length ?? 0,
      message: this.statusMessage,
    });
  }
}

function tangentAndWidth(
  snap: ReturnType<RoadNetwork['findSnap']> extends infer T ? Exclude<T, null> : never,
  network: RoadNetwork,
): { tangent: THREE.Vector3; halfWidth: number } {
  if (snap.kind === 'segment') {
    const edge = network.edges.get(snap.edgeId);
    if (!edge) return { tangent: new THREE.Vector3(1, 0, 0), halfWidth: 2.1 };
    const path = getEdgePath(edge);
    const projection = projectToPath(path, snap.point);
    return { tangent: tangentAt(path, projection.segmentIndex), halfWidth: edge.width * 0.5 };
  }
  const node = network.nodes.get(snap.nodeId);
  if (!node) return { tangent: new THREE.Vector3(1, 0, 0), halfWidth: 2.1 };
  const tangent = new THREE.Vector3();
  let halfWidth = 2.1;
  for (const edgeId of node.edgeIds) {
    const edge = network.edges.get(edgeId);
    if (!edge) continue;
    const path = getEdgePath(edge);
    // Keep the edge's canonical start-to-end tangent at both endpoints. Flipping
    // it at the end node would also flip the meaning of the locked frontage side.
    const direction = edge.startNodeId === node.id
      ? tangentAt(path, 0)
      : tangentAt(path, path.length - 2);
    tangent.add(direction);
    halfWidth = Math.max(halfWidth, edge.width * 0.5);
  }
  if (tangent.lengthSq() < 1e-5) tangent.set(1, 0, 0);
  return { tangent: tangent.normalize(), halfWidth };
}

function nearestEdgeAnchor(network: RoadNetwork, point: THREE.Vector3): {
  edge: RoadEdge;
  path: THREE.Vector3[];
  distanceAlong: number;
} | null {
  let best: { edge: RoadEdge; path: THREE.Vector3[]; distanceAlong: number; distance: number } | null = null;
  for (const edge of network.edges.values()) {
    const path = getEdgePath(edge);
    if (path.length < 2) continue;
    const projection = projectToPath(path, point);
    if (!best || projection.distance < best.distance) best = { edge, path, ...projection };
  }
  if (!best || best.distance > 3.2) return null;
  return best;
}

function projectToPath(path: THREE.Vector3[], point: THREE.Vector3): {
  segmentIndex: number;
  distanceAlong: number;
  distance: number;
} {
  const cumulative = cumulativeDistances(path);
  let best = { segmentIndex: 0, distanceAlong: 0, distance: Infinity };
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq <= 1e-6 ? 0 : THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq, 0, 1);
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const distance = Math.hypot(point.x - x, point.z - z);
    if (distance < best.distance) {
      best = {
        segmentIndex: index,
        distanceAlong: cumulative[index] + Math.hypot(x - a.x, z - a.z),
        distance,
      };
    }
  }
  return best;
}

function slicePath(path: THREE.Vector3[], from: number, to: number, spacing: number): THREE.Vector3[] {
  if (to <= from + 0.05) return [];
  const cumulative = cumulativeDistances(path);
  const samples = Math.max(2, Math.ceil((to - from) / spacing) + 1);
  return Array.from({ length: samples }, (_, index) => {
    const distance = from + (to - from) * index / (samples - 1);
    for (let segment = 0; segment < path.length - 1; segment += 1) {
      if (distance > cumulative[segment + 1]) continue;
      const span = cumulative[segment + 1] - cumulative[segment];
      const t = span <= 1e-6 ? 0 : (distance - cumulative[segment]) / span;
      return path[segment].clone().lerp(path[segment + 1], t);
    }
    return path.at(-1)!.clone();
  });
}

function tangentAt(path: THREE.Vector3[], index: number): THREE.Vector3 {
  if (path.length < 2) return new THREE.Vector3(1, 0, 0);
  const clamped = THREE.MathUtils.clamp(index, 0, path.length - 2);
  return new THREE.Vector3(
    path[clamped + 1].x - path[clamped].x,
    0,
    path[clamped + 1].z - path[clamped].z,
  ).normalize();
}

function cumulativeDistances(path: THREE.Vector3[]): number[] {
  const distances = [0];
  for (let index = 1; index < path.length; index += 1) {
    distances.push(distances[index - 1] + distanceXZ(path[index - 1], path[index]));
  }
  return distances;
}

function toPoint(point: THREE.Vector3): Point2 {
  return { x: point.x, z: point.z };
}

function distanceXZ(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return element?.tagName === 'INPUT' || element?.tagName === 'TEXTAREA' || Boolean(element?.isContentEditable);
}
