import * as THREE from 'three';
import type { FixedMap } from '../terrain/FixedMap.ts';
import type { RoadNetwork, RoadNetworkSnapshot } from '../roads/RoadNetwork.ts';
import { pathLengthXZ } from './DryStoneWall.ts';
import type { DryStoneWallRenderer } from './DryStoneWallRenderer.ts';
import {
  alignSecondWallAnchorParallel,
  findDryStoneWallRoadSnap,
  type DryStoneWallRoadSnap,
} from './DryStoneWallRoadSnap.ts';

const MIN_POINT_DISTANCE = 1.05;
const MIN_COMMIT_LENGTH = 2.2;
const SAMPLE_SPACING = 0.72;
const MAX_SAMPLES = 560;

export type DryStoneWallEditorState = {
  enabled: boolean;
  hasDraft: boolean;
  canBuild: boolean;
  anchors: number;
  wallCount: number;
  message: string;
};

/** Roadside placement tool for deterministic, terrain-following dry-stone walls. */
export class DryStoneWallEditor {
  private readonly domElement: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly terrainMesh: THREE.Mesh;
  private readonly map: FixedMap;
  private readonly network: RoadNetwork;
  private readonly renderer: DryStoneWallRenderer;
  private readonly onStateChanged: (state: DryStoneWallEditorState) => void;
  private readonly onPlaced: () => void;
  private readonly onToggleRequested?: () => void;
  private readonly raycaster = new THREE.Raycaster();
  private readonly deleteRaycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly projectedBuildPosition = new THREE.Vector3();
  private anchors: THREE.Vector3[] = [];
  private hover: THREE.Vector3 | null = null;
  private hoverRoadSnap: DryStoneWallRoadSnap | null = null;
  private wallStartTangent: THREE.Vector3 | null = null;
  private enabled = false;
  private canBuild = false;
  private statusMessage = 'Click a road shoulder to begin a low stone wall';
  private undoStack: RoadNetworkSnapshot[] = [];
  private redoStack: RoadNetworkSnapshot[] = [];

  constructor(options: {
    domElement: HTMLElement;
    camera: THREE.Camera;
    terrainMesh: THREE.Mesh;
    map: FixedMap;
    network: RoadNetwork;
    renderer: DryStoneWallRenderer;
    onStateChanged: (state: DryStoneWallEditorState) => void;
    onPlaced: () => void;
    onToggleRequested?: () => void;
  }) {
    this.domElement = options.domElement;
    this.camera = options.camera;
    this.terrainMesh = options.terrainMesh;
    this.map = options.map;
    this.network = options.network;
    this.renderer = options.renderer;
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
    return this.anchors.length > 0;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.cancelDraft(false);
    else this.statusMessage = this.network.edges.size > 0
      ? 'Click a road shoulder to begin a low stone wall'
      : 'Build a road first, then place a wall along its shoulder';
    this.emitState();
  }

  activateOrCommit(): void {
    if (this.canBuild) this.commit();
    else if (!this.enabled) this.onToggleRequested?.();
  }

  getCursor(): string | null {
    return this.enabled ? 'crosshair' : null;
  }

  shouldIgnoreCameraInput(event: MouseEvent | WheelEvent): boolean {
    return this.enabled
      && event instanceof MouseEvent
      && (event.button === 0 || event.button === 2);
  }

  getBuildButtonPosition(): { clientX: number; clientY: number } | null {
    if (!this.enabled || !this.canBuild) return null;
    const lastAnchor = this.anchors.at(-1);
    if (!lastAnchor) return null;
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const projected = this.projectedBuildPosition.copy(lastAnchor);
    projected.y += 1.45;
    projected.project(this.camera);
    if (projected.z < -1 || projected.z > 1) return null;
    return {
      clientX: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      clientY: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
    };
  }

  commit(): void {
    if (!this.canBuild) return;
    const path = this.buildPath(false);
    const snapshot = this.network.snapshot();
    const wallId = this.network.addDryStoneWallPath(path);
    if (!wallId) return;
    this.undoStack.push(snapshot);
    this.redoStack.length = 0;
    this.renderer.sync(this.network.dryStoneWalls.values(), this.network);
    this.cancelDraft(false);
    this.statusMessage = 'Low dry-stone wall placed along the road';
    this.onPlaced();
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
    this.restoreWallSnapshot(snapshot);
    this.renderer.sync(this.network.dryStoneWalls.values(), this.network);
    this.statusMessage = 'Last stone-wall change undone';
    this.onPlaced();
    this.emitState();
  }

  redo(): void {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return;
    this.undoStack.push(this.network.snapshot());
    this.restoreWallSnapshot(snapshot);
    this.renderer.sync(this.network.dryStoneWalls.values(), this.network);
    this.statusMessage = 'Stone wall restored';
    this.onPlaced();
    this.emitState();
  }

  clearAll(): void {
    if (this.network.dryStoneWalls.size === 0) return;
    this.undoStack.push(this.network.snapshot());
    this.redoStack.length = 0;
    for (const wallId of [...this.network.dryStoneWalls.keys()]) {
      this.network.deleteDryStoneWall(wallId);
    }
    this.cancelDraft(false);
    this.renderer.sync(this.network.dryStoneWalls.values(), this.network);
    this.statusMessage = 'All low stone walls cleared';
    this.onPlaced();
    this.emitState();
  }

  private readonly onPointerDown = (event: MouseEvent): void => {
    if (!this.enabled) return;
    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
      if (this.hasDraft()) this.undoLastAnchor();
      else this.setEnabled(false);
      return;
    }
    if (event.button !== 0) return;
    if (event.altKey) {
      this.deleteWallAt(event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const hit = this.pick(event.clientX, event.clientY);
    if (!hit) return;
    const point = this.applySnap(hit);
    if (!this.hasDraft() && !this.hoverRoadSnap) {
      this.statusMessage = 'The first wall point must snap to a road shoulder';
      this.emitState();
      return;
    }
    const previous = this.anchors.at(-1);
    if (previous && distanceXZ(previous, point) < MIN_POINT_DISTANCE) {
      this.statusMessage = 'Move farther along the shoulder for the next wall point';
      this.emitState();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.anchors.push(point.clone());
    if (this.anchors.length === 1 && this.hoverRoadSnap) {
      this.wallStartTangent = this.hoverRoadSnap.tangent.clone();
    }
    this.hover = null;
    this.refreshPreview();
  };

  private readonly onPointerMove = (event: MouseEvent): void => {
    if (!this.enabled) return;
    const hit = this.pick(event.clientX, event.clientY);
    this.hover = hit ? this.applySnap(hit) : null;
    this.refreshPreview();
  };

  private readonly onPointerLeave = (): void => {
    this.hover = null;
    this.hoverRoadSnap = null;
    this.renderer.setPreviewCursor(null);
    this.refreshPreview();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'l') {
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
      this.undoLastAnchor();
      return;
    }
    if (key === 'enter') {
      event.preventDefault();
      this.commit();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      this.undo();
    } else if ((event.ctrlKey || event.metaKey) && (key === 'y' || (event.shiftKey && key === 'z'))) {
      event.preventDefault();
      this.redo();
    }
  };

  private applySnap(point: THREE.Vector3): THREE.Vector3 {
    const roadside = findDryStoneWallRoadSnap(this.network, this.map, point);
    this.hoverRoadSnap = roadside;
    if (roadside) return roadside.point.clone();
    const terrainPoint = this.map.getPointAt(point.x, point.z);
    if (this.anchors.length === 1 && this.wallStartTangent) {
      return alignSecondWallAnchorParallel(
        this.anchors[0],
        this.wallStartTangent,
        terrainPoint,
        this.map,
      );
    }
    return terrainPoint;
  }

  private buildPath(includeHover: boolean): THREE.Vector3[] {
    const controls = this.anchors.map((point) => point.clone());
    if (includeHover && this.hover) {
      const previous = controls.at(-1);
      if (!previous || distanceXZ(previous, this.hover) >= MIN_POINT_DISTANCE) {
        controls.push(this.hover.clone());
      }
    }
    if (controls.length < 2) return controls;
    const controlLength = pathLengthXZ(controls);
    const sampleCount = THREE.MathUtils.clamp(
      Math.ceil(controlLength / SAMPLE_SPACING) + 1,
      2,
      MAX_SAMPLES,
    );
    if (controls.length === 2) {
      return Array.from({ length: sampleCount }, (_, index) => {
        const t = index / (sampleCount - 1);
        const point = controls[0].clone().lerp(controls[1], t);
        point.y = this.map.getHeightAt(point.x, point.z);
        return point;
      });
    }
    const curve = new THREE.CatmullRomCurve3(controls, false, 'centripetal', 0.38);
    return curve.getPoints(sampleCount - 1).map((point) => (
      this.map.getPointAt(point.x, point.z)
    ));
  }

  private refreshPreview(): void {
    if (!this.enabled) return;
    const previewPath = this.buildPath(true);
    const commitPath = this.buildPath(false);
    this.canBuild = this.anchors.length >= 2 && pathLengthXZ(commitPath) >= MIN_COMMIT_LENGTH;
    const previewValid = previewPath.length >= 2 && pathLengthXZ(previewPath) >= MIN_COMMIT_LENGTH;
    this.renderer.updatePreview(previewPath, previewValid, this.anchors);
    this.renderer.setPreviewCursor(
      this.hover,
      this.hasDraft() || Boolean(this.hoverRoadSnap),
    );
    if (this.anchors.length === 0) {
      this.statusMessage = this.network.edges.size > 0
        ? 'Click a road shoulder to begin a low stone wall'
        : 'Build a road first, then place a wall along its shoulder';
    } else if (this.anchors.length === 1) {
      this.statusMessage = 'Click farther along the road; the first wall span stays parallel';
    } else if (this.canBuild) {
      this.statusMessage = 'Click for another point, or choose the hammer / press Enter to build';
    } else {
      this.statusMessage = 'Stone wall is too short';
    }
    this.emitState();
  }

  private undoLastAnchor(): void {
    this.anchors.pop();
    this.hover = null;
    if (this.anchors.length === 0) {
      this.wallStartTangent = null;
      this.cancelDraft();
    } else {
      this.refreshPreview();
    }
  }

  private cancelDraft(emit = true): void {
    this.anchors = [];
    this.hover = null;
    this.hoverRoadSnap = null;
    this.wallStartTangent = null;
    this.canBuild = false;
    this.renderer.clearPreview();
    if (this.enabled) this.statusMessage = 'Click a road shoulder to begin a low stone wall';
    if (emit) this.emitState();
  }

  private deleteWallAt(clientX: number, clientY: number): void {
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.set(
      (clientX - rect.left) / Math.max(1, rect.width) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height) * 2 - 1),
    );
    this.deleteRaycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.deleteRaycaster.intersectObjects(this.renderer.group.children, true);
    for (const hit of hits) {
      const wallIds = hit.object.userData.dryStoneWallIds as string[] | undefined;
      if (!wallIds || hit.instanceId === undefined) continue;
      const wallId = wallIds[hit.instanceId];
      if (!wallId) continue;
      const snapshot = this.network.snapshot();
      if (!this.network.deleteDryStoneWall(wallId)) return;
      this.undoStack.push(snapshot);
      this.redoStack.length = 0;
      this.renderer.sync(this.network.dryStoneWalls.values(), this.network);
      this.statusMessage = 'Stone wall removed';
      this.onPlaced();
      this.emitState();
      return;
    }
    this.statusMessage = 'Alt-click directly on a wall stone to remove that wall';
    this.emitState();
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
      canBuild: this.canBuild,
      anchors: this.anchors.length,
      wallCount: this.network.dryStoneWalls.size,
      message: this.statusMessage,
    });
  }

  /** Wall history is independent from road geometry and bridge revisions. */
  private restoreWallSnapshot(snapshot: RoadNetworkSnapshot): void {
    const current = this.network.snapshot();
    this.network.restore({
      ...current,
      nextDryStoneWallId: snapshot.nextDryStoneWallId,
      dryStoneWalls: snapshot.dryStoneWalls,
    });
  }
}

function distanceXZ(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return element?.tagName === 'INPUT'
    || element?.tagName === 'TEXTAREA'
    || Boolean(element?.isContentEditable);
}
