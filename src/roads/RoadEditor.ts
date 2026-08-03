import * as THREE from 'three';
import type { FixedMap } from '../terrain/FixedMap.ts';
import type { RoadNetwork, RoadNetworkSnapshot } from './RoadNetwork.ts';
import type { RoadRenderer } from './RoadRenderer.ts';
import {
  BuildingRoadConnections,
  type BuildingRoadConnectionSource,
} from './BuildingRoadConnections.ts';

const MIN_POINT_DISTANCE = 1.05;
const MIN_COMMIT_LENGTH = 3.5;
const CURVE_WHEEL_STEP = 1.35;
const MAX_CURVE_OFFSET = 34;
const SNAP_DISTANCE = 5.6;

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
  private readonly buildingConnections: BuildingRoadConnections;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly projectedBuildPosition = new THREE.Vector3();
  private anchors: THREE.Vector3[] = [];
  private curves: number[] = [];
  private pendingCurve = 0;
  private hover: THREE.Vector3 | null = null;
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
    this.network.restore(snapshot);
    this.renderer.rebuild();
    this.statusMessage = 'Last road change undone';
    this.emitState();
  }

  redo(): void {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return;
    this.undoStack.push(this.network.snapshot());
    this.network.restore(snapshot);
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
    this.curves = [];
    this.pendingCurve = 0;
    this.hover = null;
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
    const hover = includeHover ? this.getUsableHover() : null;
    if (hover) {
      anchors.push(hover.clone());
      curves.push(this.pendingCurve);
    }
    if (anchors.length === 0) return [];
    const path = [anchors[0].clone()];
    for (let index = 0; index < anchors.length - 1; index++) {
      const a = anchors[index];
      const b = anchors[index + 1];
      const curve = curves[index] ?? 0;
      if (Math.abs(curve) > 0.05) {
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
    let best = networkSnap ? { point: networkSnap.point, distance: networkSnap.distance } : null;
    for (let index = 0; index < this.anchors.length - 1; index++) {
      const anchor = this.anchors[index];
      const distance = distanceXZ(anchor, point);
      if (distance <= SNAP_DISTANCE && (!best || distance < best.distance)) best = { point: anchor, distance };
    }
    const buildingSnap = this.buildingConnections.findSnap(point, SNAP_DISTANCE);
    if (buildingSnap && (!best || buildingSnap.distance < best.distance)) best = buildingSnap;
    return best ? best.point.clone() : this.map.getPointAt(point.x, point.z);
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
    const sound = new Audio('/sounds/ui/road_place.mp3');
    sound.volume = 0.3;
    void sound.play().catch(() => undefined);
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
