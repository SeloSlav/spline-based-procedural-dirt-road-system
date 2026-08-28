import * as THREE from 'three';
import type { FixedMap } from '../terrain/FixedMap.ts';
import { publicAssetUrl } from '../utils/publicAssetUrl.ts';
import type { RoadNetwork, RoadNetworkSnapshot, SnapTarget } from './RoadNetwork.ts';
import type { RoadRenderer } from './RoadRenderer.ts';
import {
  BuildingRoadConnections,
  type BuildingRoadConnectionSource,
} from './BuildingRoadConnections.ts';
import {
  buildRoadBoundaryPath,
  buildRoadBoundaryToRoadPath,
  findRoadBoundarySnap,
  type RoadAlignmentTarget,
  type RoadBoundarySnap,
  type RoadBoundaryZone,
} from './RoadBoundarySnap.ts';
import { getEdgePath, inwardDirectionAtNode } from './roadEndpoint.ts';

const MIN_POINT_DISTANCE = 1.05;
const MIN_COMMIT_LENGTH = 3.5;
const CURVE_WHEEL_STEP = 1.35;
const MAX_CURVE_OFFSET = 34;
const SNAP_DISTANCE = 5.6;
const CURVE_EPSILON = 0.05;

export type RoadEditorState = {
  enabled: boolean;
  hasDraft: boolean;
  canBuild: boolean;
  anchors: number;
  roadCount: number;
  bridgeCount: number;
  previewBridges: number;
  curveOffset: number;
  message: string;
};

export class RoadEditor {
  private readonly domElement: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly terrainMesh: THREE.Mesh;
  private readonly map: FixedMap;
  private readonly network: RoadNetwork;
  private readonly renderer: RoadRenderer;
  private readonly onStateChanged: (state: RoadEditorState) => void;
  private readonly onToggleRequested?: () => void;
  private readonly getResidenceZones: () => Iterable<RoadBoundaryZone>;
  private readonly buildingConnections: BuildingRoadConnections;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly projectedBuildPosition = new THREE.Vector3();
  private anchors: THREE.Vector3[] = [];
  private anchorBoundarySnaps: Array<RoadBoundarySnap | null> = [];
  private anchorRoadAlignmentSnaps: Array<RoadAlignmentTarget | null> = [];
  private curves: number[] = [];
  private pendingCurve = 0;
  private hover: THREE.Vector3 | null = null;
  private hoverBoundarySnap: RoadBoundarySnap | null = null;
  private hoverRoadAlignmentSnap: RoadAlignmentTarget | null = null;
  private enabled = true;
  private canBuild = false;
  private previewBridges = 0;
  private statusMessage = 'Click the terrain to begin a road';
  private undoStack: RoadNetworkSnapshot[] = [];
  private redoStack: RoadNetworkSnapshot[] = [];
  private readonly initialSnapshot: RoadNetworkSnapshot;

  constructor(options: {
    domElement: HTMLElement;
    camera: THREE.Camera;
    terrainMesh: THREE.Mesh;
    map: FixedMap;
    network: RoadNetwork;
    renderer: RoadRenderer;
    connectionParent: THREE.Object3D;
    getBuildings: () => Iterable<BuildingRoadConnectionSource>;
    getResidenceZones: () => Iterable<RoadBoundaryZone>;
    onStateChanged: (state: RoadEditorState) => void;
    onToggleRequested?: () => void;
  }) {
    this.domElement = options.domElement;
    this.camera = options.camera;
    this.terrainMesh = options.terrainMesh;
    this.map = options.map;
    this.network = options.network;
    this.renderer = options.renderer;
    this.onStateChanged = options.onStateChanged;
    this.onToggleRequested = options.onToggleRequested;
    this.buildingConnections = new BuildingRoadConnections({
      parent: options.connectionParent,
      map: options.map,
      getBuildings: options.getBuildings,
      getRoadNodes: () => this.network.nodes.values(),
    });
    this.getResidenceZones = options.getResidenceZones;
    this.initialSnapshot = this.network.snapshot();
    this.domElement.addEventListener('mousedown', this.onPointerDown, { capture: true });
    this.domElement.addEventListener('mousemove', this.onPointerMove);
    this.domElement.addEventListener('mouseleave', this.onPointerLeave);
    this.domElement.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
    window.addEventListener('keydown', this.onKeyDown);
    this.buildingConnections.setVisible(this.enabled);
    this.emitState();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  hasDraft(): boolean {
    return this.anchors.length > 0;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.buildingConnections.setVisible(enabled);
    if (!enabled) this.cancelDraft();
    else this.statusMessage = 'Click the terrain to begin a road';
    this.emitState();
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  activateOrCommit(): void {
    if (this.canBuild) {
      this.commit();
      return;
    }
    if (!this.hasDraft()) this.toggle();
  }

  getCursor(): string | null {
    if (!this.enabled) return null;
    return this.hasDraft() ? 'crosshair' : 'copy';
  }

  getBuildButtonPosition(): { clientX: number; clientY: number } | null {
    if (!this.enabled || !this.canBuild) return null;
    const lastAnchor = this.anchors.at(-1);
    if (!lastAnchor) return null;
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const projected = this.projectedBuildPosition.copy(lastAnchor);
    projected.y += 1.2;
    projected.project(this.camera);
    if (projected.z < -1 || projected.z > 1) return null;

    return {
      clientX: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      clientY: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
    };
  }

  shouldIgnoreCameraInput(event: MouseEvent | WheelEvent): boolean {
    if (!this.enabled) return false;
    if (event instanceof WheelEvent) return event.ctrlKey;
    return event.button === 0 || event.button === 2;
  }

  update(dt: number): void {
    this.buildingConnections.update(dt);
  }

  commit(): void {
    if (!this.canBuild) return;
    const draft = this.buildDraftPath(false);
    const preview = this.renderer.updatePreview(draft, true);
    const snapshot = this.network.snapshot();
    const added = this.network.addRoadPath(preview.sampled, 4.2);
    if (added.length === 0) return;
    this.undoStack.push(snapshot);
    this.redoStack.length = 0;
    this.renderer.clearPreview();
    this.renderer.rebuild();
    this.playPlacementSound();
    const bridges = this.renderer.getBridgeCount();
    this.cancelDraft(false);
    this.statusMessage = bridges > snapshotBridgeCount(snapshot)
      ? 'Timber bridge generated across the river'
      : 'Road placed';
    this.emitState();
  }

  undo(): void {
    if (this.hasDraft()) {
      this.undoLastAnchor();
      return;
    }
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.redoStack.push(this.network.snapshot());
    this.restoreRoadSnapshot(snapshot);
    this.renderer.rebuild();
    this.statusMessage = 'Last road change undone';
    this.emitState();
  }

  redo(): void {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return;
    this.undoStack.push(this.network.snapshot());
    this.restoreRoadSnapshot(snapshot);
    this.renderer.rebuild();
    this.statusMessage = 'Road change restored';
    this.emitState();
  }

  clearAll(): void {
    if (this.network.edges.size === 0) return;
    this.undoStack.push(this.network.snapshot());
    this.redoStack.length = 0;
    this.network.restore(this.initialSnapshot);
    this.renderer.rebuild();
    this.cancelDraft(false);
    this.statusMessage = 'Map cleared';
    this.emitState();
  }

  cancelDraft(emit = true): void {
    this.anchors = [];
    this.anchorBoundarySnaps = [];
    this.anchorRoadAlignmentSnaps = [];
    this.curves = [];
    this.pendingCurve = 0;
    this.hover = null;
    this.hoverBoundarySnap = null;
    this.hoverRoadAlignmentSnap = null;
    this.canBuild = false;
    this.previewBridges = 0;
    this.renderer.clearPreview();
    if (this.enabled) this.statusMessage = 'Click the terrain to begin a road';
    if (emit) this.emitState();
  }

  private readonly onPointerDown = (event: MouseEvent): void => {
    if (!this.enabled) return;
    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
      if (this.hasDraft()) this.cancelDraft();
      else this.setEnabled(false);
      return;
    }
    if (event.button !== 0) return;
    const hit = this.pick(event.clientX, event.clientY);
    if (!hit) return;
    this.buildingConnections.setCursor(hit);
    event.preventDefault();
    event.stopPropagation();
    const point = this.applySnap(hit);
    const last = this.anchors.at(-1);
    if (last && distanceXZ(last, point) < MIN_POINT_DISTANCE) return;
    if (last) this.curves.push(this.pendingCurve);
    this.anchors.push(point);
    this.anchorBoundarySnaps.push(this.hoverBoundarySnap);
    this.anchorRoadAlignmentSnaps.push(this.hoverRoadAlignmentSnap);
    this.pendingCurve = 0;
    this.hover = null;
    this.refreshPreview();
  };

  private readonly onPointerMove = (event: MouseEvent): void => {
    if (!this.enabled) return;
    const hit = this.pick(event.clientX, event.clientY);
    this.buildingConnections.setCursor(hit);
    this.hover = hit ? this.applySnap(hit) : null;
    this.refreshPreview();
  };

  private readonly onPointerLeave = (): void => {
    this.buildingConnections.setCursor(null);
    this.hover = null;
    this.hoverBoundarySnap = null;
    this.hoverRoadAlignmentSnap = null;
    this.refreshPreview();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || !this.hasDraft() || !event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.deltaY > 0 ? -1 : 1;
    const steps = Math.max(1, Math.ceil(Math.abs(event.deltaY) / 100));
    this.pendingCurve = THREE.MathUtils.clamp(
      this.pendingCurve + direction * CURVE_WHEEL_STEP * steps,
      -MAX_CURVE_OFFSET,
      MAX_CURVE_OFFSET,
    );
    this.statusMessage = `Curve offset ${Math.abs(this.pendingCurve).toFixed(1)} m ${this.pendingCurve < 0 ? 'right' : 'left'}`;
    this.refreshPreview();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'r') {
      event.preventDefault();
      if (this.onToggleRequested) this.onToggleRequested();
      else this.toggle();
      return;
    }
    if (!this.enabled) return;
    if (key === 'escape') {
      event.preventDefault();
      if (this.hasDraft()) this.cancelDraft();
      else this.setEnabled(false);
      return;
    }
    if (key === 'enter' && this.hasDraft()) {
      event.preventDefault();
      this.commit();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      this.undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (key === 'y' || (event.shiftKey && key === 'z'))) {
      event.preventDefault();
      this.redo();
    }
  };

  private undoLastAnchor(): void {
    this.anchors.pop();
    this.anchorBoundarySnaps.pop();
    this.anchorRoadAlignmentSnaps.pop();
    if (this.curves.length >= this.anchors.length) this.curves.pop();
    this.pendingCurve = 0;
    if (this.anchors.length === 0) this.cancelDraft();
    else this.refreshPreview();
  }

  private refreshPreview(): void {
    if (!this.hasDraft()) {
      this.renderer.clearPreview();
      this.canBuild = false;
      this.emitState();
      return;
    }
    const path = this.buildDraftPath(true);
    const commitPath = this.buildDraftPath(false);
    const sampledCommitPath = this.renderer.sampleTerrainPath(commitPath);
    const length = pathLength(sampledCommitPath);
    const provisionalPreview = this.renderer.updatePreview(path, true);
    this.canBuild = this.anchors.length >= 2
      && length >= MIN_COMMIT_LENGTH;
    if (this.anchors.length < 2) this.statusMessage = 'Click to set the next point';
    else if (length < MIN_COMMIT_LENGTH) this.statusMessage = 'Road segment is too short';
    else this.statusMessage = 'Click for another point, or choose the hammer / press Enter to build';
    const preview = this.canBuild
      ? provisionalPreview
      : this.renderer.updatePreview(path, false);
    this.previewBridges = preview.bridgeCount;
    this.addPreviewMarkers();
    this.emitState();
  }

  private buildDraftPath(includeHover: boolean): THREE.Vector3[] {
    const anchors = this.anchors.map((point) => point.clone());
    const curves = [...this.curves];
    const boundarySnaps = [...this.anchorBoundarySnaps];
    const roadAlignmentSnaps = [...this.anchorRoadAlignmentSnaps];
    const hover = includeHover ? this.getUsableHover() : null;
    if (hover) {
      anchors.push(hover.clone());
      curves.push(this.pendingCurve);
      boundarySnaps.push(this.hoverBoundarySnap);
      roadAlignmentSnaps.push(this.hoverRoadAlignmentSnap);
    }
    if (anchors.length === 0) return [];
    const path = [anchors[0].clone()];
    for (let index = 0; index < anchors.length - 1; index++) {
      const a = anchors[index];
      const b = anchors[index + 1];
      const curve = curves[index] ?? 0;
      const boundaryStart = boundarySnaps[index] ?? null;
      const boundaryEnd = boundarySnaps[index + 1] ?? null;
      const roadStart = roadAlignmentSnaps[index] ?? null;
      const roadEnd = roadAlignmentSnaps[index + 1] ?? null;
      let constrainedPath: Array<{ x: number; z: number }> | null = null;
      if (Math.abs(curve) <= CURVE_EPSILON) {
        if (boundaryStart && boundaryEnd) {
          constrainedPath = buildRoadBoundaryPath(boundaryStart, boundaryEnd);
        } else if (boundaryStart && roadEnd) {
          constrainedPath = buildRoadBoundaryToRoadPath(boundaryStart, roadEnd);
        } else if (roadStart && boundaryEnd) {
          constrainedPath = buildRoadBoundaryToRoadPath(boundaryEnd, roadStart);
          constrainedPath?.reverse();
        }
      }
      if (constrainedPath) {
        for (let pathIndex = 1; pathIndex < constrainedPath.length; pathIndex++) {
          if (pathIndex === constrainedPath.length - 1) {
            path.push(b.clone());
            continue;
          }
          const point = constrainedPath[pathIndex];
          const terrainPoint = this.map.getPointAt(point.x, point.z);
          if (distanceXZ(path[path.length - 1], terrainPoint) >= 0.1) path.push(terrainPoint);
        }
        continue;
      }
      if (Math.abs(curve) > CURVE_EPSILON) {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length > 0.001) {
          const x = (a.x + b.x) * 0.5 - dz / length * curve;
          const z = (a.z + b.z) * 0.5 + dx / length * curve;
          path.push(this.map.getPointAt(x, z));
        }
      }
      path.push(b.clone());
    }
    return path;
  }

  private getUsableHover(): THREE.Vector3 | null {
    if (!this.hover || !this.hasDraft()) return null;
    return distanceXZ(this.anchors.at(-1)!, this.hover) >= MIN_POINT_DISTANCE ? this.hover : null;
  }

  private applySnap(point: THREE.Vector3): THREE.Vector3 {
    this.buildingConnections.refresh();
    const networkSnap = this.network.findSnap(point, SNAP_DISTANCE);
    const draftSnap = this.findDraftSnap(point, SNAP_DISTANCE);
    const buildingSnap = this.buildingConnections.findSnap(point, SNAP_DISTANCE);
    let bestPoint: THREE.Vector3 | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    this.hoverBoundarySnap = null;
    this.hoverRoadAlignmentSnap = null;
    if (networkSnap && networkSnap.distance < bestDistance) {
      bestPoint = networkSnap.point;
      bestDistance = networkSnap.distance;
      this.hoverRoadAlignmentSnap = this.resolveRoadAlignmentSnap(networkSnap);
    }
    if (draftSnap && draftSnap.distance < bestDistance) {
      bestPoint = draftSnap.point;
      bestDistance = draftSnap.distance;
      this.hoverBoundarySnap = draftSnap.boundarySnap;
      this.hoverRoadAlignmentSnap = draftSnap.roadAlignmentSnap;
    }
    if (buildingSnap && buildingSnap.distance < bestDistance) {
      bestPoint = buildingSnap.point;
      bestDistance = buildingSnap.distance;
      this.hoverBoundarySnap = null;
      this.hoverRoadAlignmentSnap = null;
    }
    if (bestPoint) return bestPoint.clone();

    const boundarySnap = findRoadBoundarySnap(point, this.getResidenceZones());
    if (boundarySnap) {
      this.hoverBoundarySnap = boundarySnap;
      return this.map.getPointAt(boundarySnap.point.x, boundarySnap.point.z);
    }
    return this.map.getPointAt(point.x, point.z);
  }

  private findDraftSnap(
    point: THREE.Vector3,
    maxDistance: number,
  ): {
    point: THREE.Vector3;
    distance: number;
    boundarySnap: RoadBoundarySnap | null;
    roadAlignmentSnap: RoadAlignmentTarget | null;
  } | null {
    let best: {
      point: THREE.Vector3;
      distance: number;
      boundarySnap: RoadBoundarySnap | null;
      roadAlignmentSnap: RoadAlignmentTarget | null;
    } | null = null;
    const lastIndex = this.anchors.length - 1;
    for (let index = 0; index < this.anchors.length; index++) {
      if (index === lastIndex) continue;
      const anchor = this.anchors[index];
      const distance = distanceXZ(anchor, point);
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = {
          point: anchor,
          distance,
          boundarySnap: this.anchorBoundarySnaps[index] ?? null,
          roadAlignmentSnap: this.anchorRoadAlignmentSnaps[index] ?? null,
        };
      }
    }
    return best;
  }

  private resolveRoadAlignmentSnap(snap: SnapTarget): RoadAlignmentTarget | null {
    const tangents: Array<{ x: number; z: number }> = [];
    if (snap.kind === 'node') {
      const node = this.network.nodes.get(snap.nodeId);
      if (!node) return null;
      for (const incident of this.network.getIncidents(node)) {
        const direction = inwardDirectionAtNode(incident.edge, node.id);
        tangents.push({ x: direction.x, z: direction.z });
      }
    } else {
      const edge = this.network.edges.get(snap.edgeId);
      if (!edge) return null;
      const edgePath = getEdgePath(edge);
      if (edgePath.length < 2) return null;
      const scaledIndex = THREE.MathUtils.clamp(snap.t, 0, 1) * (edgePath.length - 1);
      const index = Math.min(edgePath.length - 2, Math.floor(scaledIndex));
      const dx = edgePath[index + 1].x - edgePath[index].x;
      const dz = edgePath[index + 1].z - edgePath[index].z;
      const length = Math.hypot(dx, dz);
      if (length > 1e-5) tangents.push({ x: dx / length, z: dz / length });
    }
    return tangents.length > 0
      ? { point: { x: snap.point.x, z: snap.point.z }, tangents }
      : null;
  }

  private pick(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.pointer.set(
      (clientX - rect.left) / rect.width * 2 - 1,
      -((clientY - rect.top) / rect.height * 2 - 1),
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
    return hit?.point ?? null;
  }

  private addPreviewMarkers(): void {
    const markerGeometry = new THREE.SphereGeometry(0.78, 10, 8);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffe6a6, depthTest: false });
    for (const anchor of this.anchors) {
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.copy(anchor).add(new THREE.Vector3(0, 0.7, 0));
      marker.renderOrder = 4;
      this.renderer.previewGroup.add(marker);
    }
  }

  private emitState(): void {
    this.onStateChanged({
      enabled: this.enabled,
      hasDraft: this.hasDraft(),
      canBuild: this.canBuild,
      anchors: this.anchors.length,
      roadCount: this.network.edges.size,
      bridgeCount: this.renderer.getBridgeCount(),
      previewBridges: this.previewBridges,
      curveOffset: this.pendingCurve,
      message: this.statusMessage,
    });
  }

  private playPlacementSound(): void {
    const sound = new Audio(publicAssetUrl('sounds/ui/road_place.mp3'));
    sound.volume = 0.3;
    void sound.play().catch(() => undefined);
  }

  /** Road history is independent from the decoration tool's wall history. */
  private restoreRoadSnapshot(snapshot: RoadNetworkSnapshot): void {
    const current = this.network.snapshot();
    this.network.restore({
      ...snapshot,
      nextDryStoneWallId: current.nextDryStoneWallId,
      dryStoneWalls: current.dryStoneWalls,
    });
  }
}

function snapshotBridgeCount(snapshot: RoadNetworkSnapshot): number {
  return snapshot.edges.reduce((total, edge) => total + (edge.bridgeSpans?.length ?? 0), 0);
}

function pathLength(path: THREE.Vector3[]): number {
  let length = 0;
  for (let index = 1; index < path.length; index++) length += distanceXZ(path[index - 1], path[index]);
  return length;
}

function distanceXZ(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return element?.tagName === 'INPUT' || element?.tagName === 'TEXTAREA' || Boolean(element?.isContentEditable);
}
