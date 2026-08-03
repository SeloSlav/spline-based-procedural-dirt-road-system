import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { CameraController } from './camera/CameraController.ts';
import { createGrassBladeField, type GrassBladeField } from './grass/GrassBladeField.ts';
import { updateTerrainZoomBlend } from './grass/GrassLodConfig.ts';
import { computeForestTreePlacements, type ForestTreePlacement } from './props/forestPlacements.ts';
import { RoadEditor, type RoadEditorState } from './roads/RoadEditor.ts';
import type { RoadEdge } from './roads/RoadEdge.ts';
import { RoadMaterialFactory } from './roads/RoadMaterialFactory.ts';
import { RoadNetwork } from './roads/RoadNetwork.ts';
import { RoadRenderer } from './roads/RoadRenderer.ts';
import { ResidenceSystem } from './residences/ResidenceSystem.ts';
import { ResidenceTool, type ResidenceToolState } from './residences/ResidenceTool.ts';
import { createRiverBankMeshes } from './rivers/RiverBankMesh.ts';
import { RiverField } from './rivers/RiverField.ts';
import { createRiverReeds, type RiverReedField } from './rivers/RiverReeds.ts';
import { createRiverShoreStones } from './rivers/RiverShoreStones.ts';
import { createRiverWaterMesh, type RiverWaterController } from './rivers/RiverWaterMesh.ts';
import { createPreferredRenderer, type RendererBackend, type SupportedRenderer } from './scene/RendererBackend.ts';
import {
  computeViewShadowBounds,
  fitDirectionalLightShadow,
  intersectTerrainBounds,
} from './scene/fitDirectionalShadow.ts';
import { TREE_SHADOW_CAST_LAYER } from './scene/SceneLayers.ts';
import { setWorldAnimationTime } from './scene/worldAnimationTime.ts';
import { FixedMap, PLAYABLE_SIZE, TERRAIN_SIZE, WORLD_SEED } from './terrain/FixedMap.ts';
import type { Terrain } from './terrain/Terrain.ts';
import { distancePointToPolylineXZ } from './utils/pathGeometry.ts';
import { isPointInPolygon2 } from './utils/polygonGeometry.ts';
import { loadMossyRockTextures } from './utils/propTextureLoad.ts';
import {
  createSeedThreeForest,
  createSeedThreeForestController,
  type SeedThreeForestInstances,
} from './vegetation/seedthree/seedThreeForestBuilder.ts';
import type { SeedThreeForestController } from './vegetation/seedthree/seedThreeForestTypes.ts';
import './style.css';

const TREE_SEED = 0x5eedf0a5;
const ROAD_CLEAR_MARGIN = 1.35;
const STATIC_SUN_DIRECTION = new THREE.Vector3(-127.28, 131.63, -127.28).normalize();

class RoadNetworkEditorApp {
  private readonly root: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly fpsLabel: HTMLElement;
  private readonly buildButton: HTMLButtonElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2_600);
  private readonly renderer: SupportedRenderer;
  private readonly rendererBackend: RendererBackend;
  private readonly map = new FixedMap();
  private readonly network = new RoadNetwork();
  private readonly roadRenderer: RoadRenderer;
  private readonly clock = new THREE.Clock();
  private readonly cameraTarget = new THREE.Vector3();
  private readonly roadEditor: RoadEditor;
  private readonly residenceSystem: ResidenceSystem;
  private readonly residenceTool: ResidenceTool;
  private readonly interactionOverlay = new THREE.Group();
  private readonly cameraController: CameraController;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly terrainSurface: Terrain;
  private readonly riverField: RiverField;
  private readonly riverGroup = new THREE.Group();
  private readonly riverWater: RiverWaterController | null;
  private riverReeds: RiverReedField | null = null;
  private forest: SeedThreeForestInstances | null = null;
  private forestController: SeedThreeForestController | null = null;
  private forestPlacements: ForestTreePlacement[] = [];
  private grass: GrassBladeField | null = null;
  private readonly frameSamples: number[] = [];
  private readonly cpuSamples: number[] = [];
  private readonly renderSubmitSamples: number[] = [];
  private readonly viewShadowBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private readonly shadowBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private shadowRefreshRequested = true;
  private lastShadowTargetX = Number.NaN;
  private lastShadowTargetZ = Number.NaN;
  private lastShadowDistance = Number.NaN;
  private renderFrame = 0;
  private lastZoomPercent = Number.NaN;
  private lastTopologyRevision = -1;
  private roadState: RoadEditorState = {
    enabled: true,
    hasDraft: false,
    canBuild: false,
    anchors: 0,
    roadCount: 0,
    bridgeCount: 0,
    previewBridges: 0,
    curveOffset: 0,
    message: 'Click the terrain to begin a road',
  };
  private residenceState: ResidenceToolState = {
    enabled: false,
    hasDraft: false,
    canBuild: false,
    stage: 0,
    plotCount: 1,
    residenceCount: 0,
    message: 'Click beside a road to start the residence frontage',
  };

  constructor(
    root: HTMLElement,
    rendererBackend: RendererBackend,
    materials: RoadMaterialFactory,
  ) {
    this.root = root;
    this.rendererBackend = rendererBackend;
    this.renderer = rendererBackend.renderer;
    document.documentElement.dataset.rendererBackend = rendererBackend.kind;
    this.root.innerHTML = pageTemplate();
    this.viewport = this.mustFind<HTMLElement>('[data-viewport]');
    this.zoomLabel = this.mustFind<HTMLElement>('[data-zoom]');
    this.fpsLabel = this.mustFind<HTMLElement>('[data-fps]');
    this.buildButton = this.mustFind<HTMLButtonElement>('[data-build]');
    this.viewport.prepend(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', 'Interactive three-dimensional road building map');
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMappingExposure = 1.04;

    this.scene.background = new THREE.Color(0x78929d);
    this.scene.fog = new THREE.FogExp2(0x879da3, 0.00072);
    this.sunLight = this.addLighting();
    this.riverField = RiverField.fromLayout({
      bounds: this.map.bounds,
      layout: this.map.riverLayout,
    });
    const terrain = this.map.createTerrainMesh(
      materials.createTerrainMaterialWithRiverShore(),
      this.riverField,
    );
    this.terrainSurface = {
      playableSize: PLAYABLE_SIZE,
      size: TERRAIN_SIZE,
      mesh: terrain,
      getHeightAt: (x, z) => this.map.getHeightAt(x, z),
      getPointAt: (x, z, offset = 0) => this.map.getPointAt(x, z, offset),
      getPointAtInto: (x, z, target, offset = 0) => target.set(
        x,
        this.map.getHeightAt(x, z) + offset,
        z,
      ),
      setDirtZoomGate: (value) => {
        const attribute = terrain.geometry.getAttribute('dirtZoomGate');
        (attribute.array as Float32Array).fill(value);
        attribute.needsUpdate = true;
      },
    };
    this.roadRenderer = new RoadRenderer(
      this.network,
      this.terrainSurface,
      this.riverField,
      materials,
    );
    this.riverGroup.name = 'River system';
    this.riverWater = createRiverWaterMesh(this.riverGroup, this.terrainSurface, this.riverField);
    this.riverGroup.add(
      createRiverBankMeshes(this.terrainSurface, this.riverField, materials.riverBank),
    );
    this.residenceSystem = new ResidenceSystem(this.map);
    this.interactionOverlay.name = 'Placement interaction overlays';
    this.scene.add(
      terrain,
      this.riverGroup,
      this.roadRenderer.group,
      this.roadRenderer.previewGroup,
      this.residenceSystem.group,
      this.interactionOverlay,
    );

    this.roadEditor = new RoadEditor({
      domElement: this.renderer.domElement,
      camera: this.camera,
      terrainMesh: terrain,
      map: this.map,
      network: this.network,
      renderer: this.roadRenderer,
      connectionParent: this.interactionOverlay,
      getBuildings: () => this.residenceSystem.getRoadConnectionSources(),
      onStateChanged: (state) => this.renderEditorState(state),
      onToggleRequested: () => this.toggleTool('road'),
    });

    this.residenceTool = new ResidenceTool({
      domElement: this.renderer.domElement,
      camera: this.camera,
      terrainMesh: terrain,
      map: this.map,
      network: this.network,
      system: this.residenceSystem,
      previewParent: this.interactionOverlay,
      onStateChanged: (state) => this.renderResidenceState(state),
      onPlaced: () => {
        this.syncSourceEnvironmentRoadClearance();
        this.requestShadowRefresh();
      },
      onToggleRequested: () => this.toggleTool('residence'),
    });

    this.cameraController = new CameraController({
      camera: this.camera,
      target: this.cameraTarget,
      domElement: this.renderer.domElement,
      bounds: this.map.bounds,
      getHeightAt: (x, z) => this.map.getHeightAt(x, z),
      getCursorOverride: () => this.residenceTool.getCursor() ?? this.roadEditor.getCursor(),
      shouldIgnoreInput: (event) => (
        this.residenceTool.shouldIgnoreCameraInput(event)
        || this.roadEditor.shouldIgnoreCameraInput(event)
      ),
      continuousRenderLoop: true,
    });
    this.cameraController.applyShowcaseView(0, -30, THREE.MathUtils.degToRad(-58), THREE.MathUtils.degToRad(54), 285);

    this.bindUi();
    this.onResize();
    window.addEventListener('resize', this.onResize);
    this.animate();
    void this.loadSourceEnvironment();
  }

  private addLighting(): THREE.DirectionalLight {
    const hemisphere = new THREE.HemisphereLight(0xd9e8ec, 0x59634f, 1.55);
    const ambient = new THREE.AmbientLight(0xb8c8d2, 0.18);
    const sun = new THREE.DirectionalLight(0xffefd2, 5.2);
    sun.name = 'Sun';
    sun.position.copy(STATIC_SUN_DIRECTION).multiplyScalar(180);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.00008;
    sun.shadow.normalBias = 0.008;
    sun.shadow.radius = 1.8;
    sun.shadow.autoUpdate = false;
    sun.shadow.camera.layers.enable(TREE_SHADOW_CAST_LAYER);
    const fill = new THREE.DirectionalLight(0xa8c6d8, 0.34);
    fill.name = 'Sky fill';
    fill.position.set(63.64, -0.82, 63.64);
    this.scene.add(hemisphere, ambient, sun, sun.target, fill);
    return sun;
  }

  private async loadSourceEnvironment(): Promise<void> {
    document.documentElement.dataset.environmentReady = 'loading';
    try {
      this.forestPlacements = computeForestTreePlacements(
        this.terrainSurface.playableSize,
        this.terrainSurface.size,
        (x, z) => this.riverField.isBlockedForProps(x, z),
        { treeSeed: TREE_SEED, densityScale: 1 },
      );
      const [forest, grass, reeds, rockTextures] = await Promise.all([
        createSeedThreeForest(
          this.forestPlacements,
          this.terrainSurface,
          this.rendererBackend.maxAnisotropy,
          TREE_SEED,
          this.renderer as WebGPURenderer,
        ),
        createGrassBladeField(this.terrainSurface, {
          isBlockedAt: (x, z) => this.riverField.isGrassBlockedAt(x, z),
          maxAnisotropy: this.rendererBackend.maxAnisotropy,
          rendererBackend: this.rendererBackend.kind,
          lodFadeMode: 'continuous-alpha-hash',
        }),
        createRiverReeds(
          this.terrainSurface,
          this.riverField,
          mulberry32(0x8eed1212),
          this.rendererBackend.maxAnisotropy,
          this.rendererBackend.kind,
        ),
        loadMossyRockTextures(this.rendererBackend.maxAnisotropy),
      ]);
      this.forest = forest;
      this.forestController = createSeedThreeForestController(forest);
      this.forestController.setShadows(true);
      this.grass = grass;
      this.riverReeds = reeds;
      const rockMaterial = createRiverRockMaterial(rockTextures);
      const shoreStones = createRiverShoreStones(
        this.terrainSurface,
        this.riverField,
        rockMaterial,
        createPropShadowMaterials(),
        mulberry32(0x71ee1212),
      );
      this.riverGroup.add(reeds.group, shoreStones.group);
      this.scene.add(forest.group, grass.group);
      this.syncSourceEnvironmentRoadClearance();
      this.requestShadowRefresh();
      document.documentElement.dataset.environmentReady = 'true';
    } catch (error) {
      document.documentElement.dataset.environmentReady = 'error';
      console.error('Failed to initialize the source environment.', error);
    }
  }

  private syncSourceEnvironmentRoadClearance(): void {
    const edges = [...this.network.edges.values()];
    const residencePolygons = this.residenceSystem.getClearancePolygons();
    if (this.forestController) {
      for (let index = 0; index < this.forestPlacements.length; index++) {
        const placement = this.forestPlacements[index];
        const insideResidenceFrontage = residencePolygons.some((polygon) => (
          isPointInPolygon2({ x: placement.x, z: placement.z }, polygon)
        ));
        if (insideResidenceFrontage || this.isTreeNearAnyEdge(placement, edges)) this.forestController.hideTree(index);
        else this.forestController.showTree(index);
      }
      this.forestController.commit();
    }
    this.grass?.syncRoadClearance(this.network);
    this.grass?.syncPlacementClearance(residencePolygons);
    this.requestShadowRefresh();
  }

  private isTreeNearAnyEdge(placement: ForestTreePlacement, edges: RoadEdge[]): boolean {
    for (const edge of edges) {
      const path = edge.sampledPath.length >= 2 ? edge.sampledPath : edge.controlPoints;
      if (path.length < 2) continue;
      const distance = distancePointToPolylineXZ(placement.x, placement.z, path);
      if (distance <= treeClearRadius(placement, edge.width)) return true;
    }
    return false;
  }

  private requestShadowRefresh(): void {
    this.shadowRefreshRequested = true;
    const shadowMap = this.renderer.shadowMap as typeof this.renderer.shadowMap & { needsUpdate?: boolean };
    if ('needsUpdate' in shadowMap) shadowMap.needsUpdate = true;
  }

  private shouldRefitShadowMap(cameraDistance: number): boolean {
    if (this.shadowRefreshRequested || !Number.isFinite(this.lastShadowTargetX)) return true;
    if (this.renderFrame % 5 !== 0) return false;
    const dx = this.cameraTarget.x - this.lastShadowTargetX;
    const dz = this.cameraTarget.z - this.lastShadowTargetZ;
    if (Math.hypot(dx, dz) > 14) return true;
    return Math.abs(cameraDistance - this.lastShadowDistance) > 12;
  }

  private refitShadowMap(cameraDistance: number): void {
    fitDirectionalLightShadow(this.sunLight, {
      bounds: this.shadowBounds,
      sunOffsetDir: STATIC_SUN_DIRECTION,
    });
    this.lastShadowTargetX = this.cameraTarget.x;
    this.lastShadowTargetZ = this.cameraTarget.z;
    this.lastShadowDistance = cameraDistance;
    this.shadowRefreshRequested = false;
    this.sunLight.shadow.needsUpdate = true;
    const shadowMap = this.renderer.shadowMap as typeof this.renderer.shadowMap & { needsUpdate?: boolean };
    if ('needsUpdate' in shadowMap) shadowMap.needsUpdate = true;
  }

  private bindUi(): void {
    this.mustFind<HTMLButtonElement>('[data-tool-road]').addEventListener('click', () => this.toggleTool('road'));
    this.mustFind<HTMLButtonElement>('[data-tool-residence]').addEventListener('click', () => this.toggleTool('residence'));
    this.buildButton.addEventListener('click', () => {
      if (this.residenceTool.isEnabled()) this.residenceTool.commit();
      else this.roadEditor.commit();
    });
    this.mustFind<HTMLButtonElement>('[data-undo]').addEventListener('click', () => {
      if (this.residenceTool.isEnabled()) this.residenceTool.undo();
      else this.roadEditor.undo();
    });
    this.mustFind<HTMLButtonElement>('[data-redo]').addEventListener('click', () => {
      if (this.residenceTool.isEnabled()) this.residenceTool.redo();
      else this.roadEditor.redo();
    });
    this.mustFind<HTMLButtonElement>('[data-clear]').addEventListener('click', () => {
      this.roadEditor.clearAll();
      this.residenceTool.clearAll();
    });
  }

  private renderEditorState(state: RoadEditorState): void {
    this.roadState = state;
    this.renderToolState();

    const revision = this.network.getTopologyRevision();
    if (revision !== this.lastTopologyRevision) {
      this.lastTopologyRevision = revision;
      this.syncSourceEnvironmentRoadClearance();
    }
  }

  private renderResidenceState(state: ResidenceToolState): void {
    this.residenceState = state;
    this.renderToolState();
  }

  private renderToolState(): void {
    const roadActive = this.roadState.enabled;
    const residenceActive = this.residenceState.enabled;
    const roadTool = this.mustFind<HTMLButtonElement>('[data-tool-road]');
    const residenceTool = this.mustFind<HTMLButtonElement>('[data-tool-residence]');
    roadTool.classList.toggle('is-active', roadActive);
    residenceTool.classList.toggle('is-active', residenceActive);
    roadTool.setAttribute('aria-pressed', String(roadActive));
    residenceTool.setAttribute('aria-pressed', String(residenceActive));
    const activeState = residenceActive ? this.residenceState : this.roadState;
    this.mustFind<HTMLElement>('[data-mode]').textContent = residenceActive
      ? 'HOUSE PLACEMENT ACTIVE'
      : roadActive
        ? 'ROAD TOOL ACTIVE'
        : 'NAVIGATION MODE';
    this.mustFind<HTMLElement>('[data-status]').textContent = activeState.message;
    this.mustFind<HTMLElement>('[data-road-count]').textContent = String(this.roadState.roadCount);
    this.mustFind<HTMLElement>('[data-bridge-count]').textContent = String(this.roadState.bridgeCount);
    this.mustFind<HTMLElement>('[data-residence-count]').textContent = String(this.residenceSystem.getResidenceCount());
    this.mustFind<HTMLElement>('[data-frontage-count]').textContent = String(this.residenceSystem.getZoneCount());
    this.mustFind<HTMLElement>('[data-anchor-count]').textContent = residenceActive
      ? String(this.residenceState.stage < 4 ? this.residenceState.stage : 4)
      : String(this.roadState.anchors);
    const bridgeHint = this.mustFind<HTMLElement>('[data-bridge-hint]');
    bridgeHint.classList.toggle('is-visible', !residenceActive && this.roadState.previewBridges > 0);
    bridgeHint.classList.toggle('is-residence', residenceActive);
    bridgeHint.textContent = residenceActive
      ? 'Frontage snaps beside roads · cottages appear instantly'
      : this.roadState.previewBridges > 0
        ? `${this.roadState.previewBridges} automatic timber bridge${this.roadState.previewBridges === 1 ? '' : 's'} in this route`
        : 'Roads snap to nearby white circles on roads and residences';
    const build = this.buildButton;
    const canBuild = residenceActive ? this.residenceState.canBuild : this.roadState.canBuild;
    build.disabled = !canBuild;
    build.hidden = !canBuild;
    const buildLabel = residenceActive
      ? 'Construct residences instantly'
      : this.roadState.previewBridges > 0
        ? 'Build road and bridge'
        : 'Build road';
    build.setAttribute('aria-label', buildLabel);
    build.title = `${buildLabel} (Enter)`;
    this.syncBuildButtonPosition();
  }

  private toggleTool(tool: 'road' | 'residence'): void {
    if (tool === 'road') {
      const next = !this.roadEditor.isEnabled();
      this.residenceTool.setEnabled(false);
      this.roadEditor.setEnabled(next);
      return;
    }
    const next = !this.residenceTool.isEnabled();
    this.roadEditor.setEnabled(false);
    this.residenceTool.setEnabled(next);
  }

  private readonly onResize = (): void => {
    const width = this.root.clientWidth || window.innerWidth;
    const height = this.root.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.requestShadowRefresh();
    this.syncBuildButtonPosition();
  };

  private syncBuildButtonPosition(): void {
    const build = this.buildButton;
    if (!this.roadEditor || !this.residenceTool) {
      build.hidden = true;
      return;
    }
    if (build.disabled) {
      build.hidden = true;
      return;
    }
    const position = this.residenceTool.isEnabled()
      ? this.residenceTool.getBuildButtonPosition()
      : this.roadEditor.getBuildButtonPosition();
    if (!position) {
      build.hidden = true;
      return;
    }

    const viewportRect = this.viewport.getBoundingClientRect();
    const size = 44;
    const margin = 10;
    const gap = 12;
    const left = Math.round(Math.max(
      margin,
      Math.min(viewportRect.width - size - margin, position.clientX - viewportRect.left + gap),
    ));
    const top = Math.round(Math.max(
      margin,
      Math.min(viewportRect.height - size - margin, position.clientY - viewportRect.top - size - gap),
    ));
    build.hidden = false;
    build.style.left = `${left}px`;
    build.style.top = `${top}px`;
  }

  private readonly animate = (): void => {
    requestAnimationFrame(this.animate);
    const cpuStartedAt = performance.now();
    const dt = Math.min(0.05, this.clock.getDelta());
    this.cameraController.update(dt);
    this.roadEditor.update(dt);
    setWorldAnimationTime(this.clock.elapsedTime);
    this.riverWater?.tick(dt, this.clock.elapsedTime);
    const cameraDistance = this.cameraController.getOrbitDistance();
    const viewShadowBounds = computeViewShadowBounds(
      this.camera,
      this.cameraTarget,
      cameraDistance,
      1.24,
      this.viewShadowBounds,
    );
    const shadowBounds = intersectTerrainBounds(
      viewShadowBounds,
      this.map.bounds,
      this.shadowBounds,
    );
    updateTerrainZoomBlend(this.terrainSurface, cameraDistance, false);
    const forestMatrixWritesBefore = this.forest?.updateTelemetry.matrixWrites ?? 0;
    const forestChanged = this.forestController?.updateCamera(
      this.camera,
      cameraDistance,
      false,
      shadowBounds,
      this.cameraController.isNavigationActive(),
      dt,
    );
    // Billboard opacity changes are color-only. Redraw the static atlas only
    // when compaction actually changes the tree matrices submitted to it.
    if (
      forestChanged
      && this.forest
      && this.forest.updateTelemetry.matrixWrites !== forestMatrixWritesBefore
    ) this.requestShadowRefresh();
    this.grass?.updateCameraState(this.camera.position, this.cameraTarget, cameraDistance, false);
    this.riverReeds?.updateCameraState(this.camera.position, this.cameraTarget, cameraDistance, false);
    const zoomPercent = Math.round(this.cameraController.getZoomPercent());
    if (zoomPercent !== this.lastZoomPercent) {
      this.lastZoomPercent = zoomPercent;
      this.zoomLabel.textContent = `${zoomPercent}%`;
    }
    if (!this.buildButton.disabled) this.syncBuildButtonPosition();
    this.renderFrame++;
    if (this.shouldRefitShadowMap(cameraDistance)) this.refitShadowMap(cameraDistance);
    const renderStartedAt = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.publishFrameDiagnostics(
      dt,
      renderStartedAt - cpuStartedAt,
      performance.now() - renderStartedAt,
    );
  };

  private publishFrameDiagnostics(dt: number, cpuMs: number, renderSubmitMs: number): void {
    this.frameSamples.push(dt);
    this.cpuSamples.push(cpuMs);
    this.renderSubmitSamples.push(renderSubmitMs);
    if (this.frameSamples.length < 120) return;
    const sorted = [...this.frameSamples].sort((left, right) => left - right);
    const total = this.frameSamples.reduce((sum, sample) => sum + sample, 0);
    const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    const info = this.renderer.info as typeof this.renderer.info & {
      render?: { calls?: number; triangles?: number; points?: number; lines?: number };
    };
    const fps = (this.frameSamples.length / total).toFixed(1);
    document.documentElement.dataset.frameFps = fps;
    this.fpsLabel.textContent = fps;
    document.documentElement.dataset.frameP95Ms = (sorted[p95Index]! * 1_000).toFixed(2);
    document.documentElement.dataset.cpuMs = (
      this.cpuSamples.reduce((sum, sample) => sum + sample, 0) / this.cpuSamples.length
    ).toFixed(2);
    document.documentElement.dataset.renderSubmitMs = (
      this.renderSubmitSamples.reduce((sum, sample) => sum + sample, 0)
      / this.renderSubmitSamples.length
    ).toFixed(2);
    document.documentElement.dataset.renderCalls = String(info.render?.calls ?? 0);
    document.documentElement.dataset.renderTriangles = String(info.render?.triangles ?? 0);
    if (this.forestController) {
      document.documentElement.dataset.forestStats = JSON.stringify(
        this.forestController.getStructuralStats(),
      );
    }
    if (this.forest) {
      let viewInstances = 0;
      let shadowInstances = 0;
      let viewTriangles = 0;
      let shadowTriangles = 0;
      let viewDraws = 0;
      this.forest.group.traverse((object) => {
        const mesh = object as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh) return;
        const viewCount = Number(mesh.userData.forestViewInstanceCount) || 0;
        const shadowCount = Number(mesh.userData.forestShadowInstanceCount) || 0;
        const geometryTriangles = mesh.geometry.index
          ? mesh.geometry.index.count / 3
          : mesh.geometry.attributes.position.count / 3;
        if (viewCount > 0) viewDraws += 1;
        viewInstances += viewCount;
        shadowInstances += shadowCount;
        viewTriangles += viewCount * geometryTriangles;
        shadowTriangles += shadowCount * geometryTriangles;
      });
      document.documentElement.dataset.forestPassStats = JSON.stringify({
        viewTrees: this.forest.buckets.reduce(
          (sum, bucket) => sum + bucket.nearViewSlotCount + bucket.overviewViewSlotCount,
          0,
        ),
        viewDraws,
        viewInstances,
        shadowInstances,
        viewTriangles,
        shadowTriangles,
      });
    }
    if (this.grass) {
      let draws = 0;
      let instances = 0;
      let triangles = 0;
      this.grass.group.traverse((object) => {
        const mesh = object as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh || !mesh.visible || mesh.count <= 0) return;
        const geometryTriangles = mesh.geometry.index
          ? mesh.geometry.index.count / 3
          : mesh.geometry.attributes.position.count / 3;
        draws += 1;
        instances += mesh.count;
        triangles += mesh.count * geometryTriangles;
      });
      document.documentElement.dataset.grassStats = JSON.stringify({
        draws,
        instances,
        triangles,
        stream: this.grass.getStreamTelemetry(),
      });
    }
    this.frameSamples.length = 0;
    this.cpuSamples.length = 0;
    this.renderSubmitSamples.length = 0;
  }

  private mustFind<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing interface element: ${selector}`);
    return element;
  }
}

function treeCanopyRadius(placement: ForestTreePlacement): number {
  if (placement.form === 'broad') return 4.1 * placement.scale;
  if (placement.form === 'young' || placement.form === 'midstory') return 2.3 * placement.scale;
  return 3.3 * placement.scale;
}

function treeClearRadius(placement: ForestTreePlacement, roadWidth: number): number {
  return roadWidth * 0.5 + treeCanopyRadius(placement) + ROAD_CLEAR_MARGIN;
}

function createPropShadowMaterials(): {
  shadowCast: THREE.MeshStandardMaterial;
  shadowDepth: THREE.MeshDepthMaterial;
} {
  return {
    shadowCast: new THREE.MeshStandardMaterial({
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
    }),
    shadowDepth: new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    }),
  };
}

function createRiverRockMaterial(
  rockTextures: Awaited<ReturnType<typeof loadMossyRockTextures>>,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: rockTextures.map,
    normalMap: rockTextures.normalMap,
    roughnessMap: rockTextures.roughnessMap,
    color: 0xb0aea0,
    roughness: 0.92,
    metalness: 0,
  });
  material.normalScale.set(0.55, 0.55);
  return material;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pageTemplate(): string {
  return `
    <section class="viewport" data-viewport>
      <header class="topbar">
        <div class="brand-panel panel">
          <div class="brand-mark" aria-hidden="true">DR</div>
          <div>
            <div class="eyebrow">PROCEDURAL ROAD NETWORK</div>
            <h1>Road &amp; Bridge Editor</h1>
          </div>
          <span class="client-badge">SPLINE EDITOR</span>
        </div>

        <div class="view-panel panel" aria-label="View information">
          <div class="fps-stat"><span>FPS</span><strong data-fps aria-live="off">--</strong></div>
          <div><span>ZOOM</span><strong data-zoom>100%</strong></div>
          <div><span>LIGHT</span><strong>DAY</strong></div>
          <div><span>SEED</span><strong>${WORLD_SEED.toString(16).padStart(8, '0').toUpperCase()}</strong></div>
        </div>
      </header>

      <aside class="stats-panel panel" aria-label="Road network statistics">
        <div class="stats-title">NETWORK</div>
        <dl>
          <div><dt>Road segments</dt><dd data-road-count>0</dd></div>
          <div><dt>River bridges</dt><dd data-bridge-count>0</dd></div>
          <div><dt>Residences</dt><dd data-residence-count>0</dd></div>
          <div><dt>Frontages</dt><dd data-frontage-count>0</dd></div>
          <div><dt>Draft points</dt><dd data-anchor-count>0</dd></div>
        </dl>
      </aside>

      <aside class="controls-panel panel">
        <div class="eyebrow">CAMERA</div>
        <div class="control-row"><kbd>WASD</kbd><span>Move across map</span></div>
        <div class="control-row"><kbd>MMB</kbd><span>Rotate view</span></div>
        <div class="control-row"><kbd>WHEEL</kbd><span>Zoom 30–1000%</span></div>
        <div class="control-row"><kbd>Q / E</kbd><span>Rotate left / right</span></div>
        <div class="control-row"><kbd>B</kbd><span>House placement tool</span></div>
        <div class="control-row"><kbd>+ / −</kbd><span>Adjust residence plots</span></div>
      </aside>

      <div class="bridge-hint panel" data-bridge-hint>Cross the river to generate a bridge</div>

      <div class="status-stack">
        <div class="mode-label" data-mode>ROAD TOOL ACTIVE</div>
        <div class="status-message panel"><span class="status-dot"></span><span data-status>Click the terrain to begin a road</span></div>
      </div>

      <nav class="tool-dock panel" aria-label="Road building tools">
        <button class="tool-button is-active" data-tool-road type="button" aria-label="Toggle road tool" aria-pressed="true">
          <span class="road-sprite" aria-hidden="true"></span>
          <span class="tool-label">Road</span>
          <kbd>R</kbd>
        </button>
        <button class="tool-button residence-tool" data-tool-residence type="button" aria-label="Toggle house placement mode" aria-pressed="false" title="House placement mode (B)">
          <span class="residence-sprite" aria-hidden="true">⌂</span>
          <span class="tool-label">House</span>
          <kbd>B</kbd>
        </button>
        <div class="dock-divider"></div>
        <button class="dock-action" data-undo type="button" aria-label="Undo last point or road"><span>↶</span>Undo</button>
        <button class="dock-action" data-redo type="button" aria-label="Redo road"><span>↷</span>Redo</button>
        <button class="dock-action danger" data-clear type="button" aria-label="Clear all roads"><span>×</span>Clear</button>
      </nav>

      <button class="floating-build-button" data-build type="button" aria-label="Build road" title="Build road (Enter)" disabled hidden>
        <span class="hammer-sprite" aria-hidden="true"></span>
      </button>

      <div class="curve-tip">Terrain-aware splines · automatic river bridges · <kbd>CTRL</kbd> + <kbd>WHEEL</kbd> bends road splines</div>
    </section>
  `;
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');
void createPreferredRenderer().then(async (rendererBackend) => {
  const materials = RoadMaterialFactory.createProgressive(rendererBackend.maxAnisotropy);
  await materials.whenTexturesReady();
  new RoadNetworkEditorApp(root, rendererBackend, materials);
});
