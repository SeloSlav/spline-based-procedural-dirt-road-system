import * as THREE from 'three';
import { CameraController } from './camera/CameraController.ts';
import { RoadEditor, type RoadEditorState } from './roads/RoadEditor.ts';
import { RoadNetwork } from './roads/RoadNetwork.ts';
import { RoadRenderer } from './roads/RoadRenderer.ts';
import { FixedMap } from './terrain/FixedMap.ts';
import { MapDecor } from './world/MapDecor.ts';
import './style.css';

class KupaRoadworksApp {
  private readonly root: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(54, 1, 0.1, 2_600);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  private readonly map = new FixedMap();
  private readonly network = new RoadNetwork();
  private readonly roadRenderer = new RoadRenderer(this.network, this.map);
  private readonly decor = new MapDecor(this.map);
  private readonly clock = new THREE.Clock();
  private readonly cameraTarget = new THREE.Vector3();
  private readonly roadEditor: RoadEditor;
  private readonly cameraController: CameraController;
  private lastTopologyRevision = -1;
  private ambientAudio: HTMLAudioElement | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = pageTemplate();
    const viewport = this.mustFind<HTMLElement>('[data-viewport]');
    viewport.prepend(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', 'Interactive three-dimensional road building map');
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    this.scene.background = new THREE.Color(0xb8c6ad);
    this.scene.fog = new THREE.FogExp2(0xb8c6ad, 0.00135);
    this.addLighting();
    const terrain = this.map.createTerrainMesh();
    this.scene.add(terrain, this.decor.group, this.roadRenderer.group, this.roadRenderer.previewGroup);

    this.roadEditor = new RoadEditor({
      domElement: this.renderer.domElement,
      camera: this.camera,
      terrainMesh: terrain,
      map: this.map,
      network: this.network,
      renderer: this.roadRenderer,
      onStateChanged: (state) => this.renderEditorState(state),
    });

    this.cameraController = new CameraController({
      camera: this.camera,
      target: this.cameraTarget,
      domElement: this.renderer.domElement,
      bounds: this.map.bounds,
      getHeightAt: (x, z) => this.map.getHeightAt(x, z),
      getCursorOverride: () => this.roadEditor.getCursor(),
      shouldIgnoreInput: (event) => this.roadEditor.shouldIgnoreCameraInput(event),
      continuousRenderLoop: true,
    });
    this.cameraController.applyShowcaseView(0, -30, THREE.MathUtils.degToRad(-58), THREE.MathUtils.degToRad(54), 285);

    this.bindUi();
    this.onResize();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointerdown', this.startAmbientAudio, { once: true });
    this.animate();
  }

  private addLighting(): void {
    const hemisphere = new THREE.HemisphereLight(0xe8f0de, 0x5b513e, 2.15);
    const sun = new THREE.DirectionalLight(0xfff0ce, 3.35);
    sun.position.set(-190, 310, -120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -290;
    sun.shadow.camera.right = 290;
    sun.shadow.camera.top = 290;
    sun.shadow.camera.bottom = -290;
    sun.shadow.camera.near = 40;
    sun.shadow.camera.far = 760;
    sun.shadow.bias = -0.00016;
    const fill = new THREE.DirectionalLight(0x9fb4c4, 0.45);
    fill.position.set(180, 120, 240);
    this.scene.add(hemisphere, sun, fill);
  }

  private bindUi(): void {
    this.mustFind<HTMLButtonElement>('[data-tool-road]').addEventListener('click', () => this.roadEditor.toggle());
    this.mustFind<HTMLButtonElement>('[data-build]').addEventListener('click', () => this.roadEditor.commit());
    this.mustFind<HTMLButtonElement>('[data-undo]').addEventListener('click', () => this.roadEditor.undo());
    this.mustFind<HTMLButtonElement>('[data-redo]').addEventListener('click', () => this.roadEditor.redo());
    this.mustFind<HTMLButtonElement>('[data-clear]').addEventListener('click', () => this.roadEditor.clearAll());
  }

  private renderEditorState(state: RoadEditorState): void {
    const tool = this.mustFind<HTMLButtonElement>('[data-tool-road]');
    tool.classList.toggle('is-active', state.enabled);
    tool.setAttribute('aria-pressed', String(state.enabled));
    this.mustFind<HTMLElement>('[data-mode]').textContent = state.enabled ? 'ROAD TOOL ACTIVE' : 'NAVIGATION MODE';
    this.mustFind<HTMLElement>('[data-status]').textContent = state.message;
    this.mustFind<HTMLElement>('[data-road-count]').textContent = String(state.roadCount);
    this.mustFind<HTMLElement>('[data-bridge-count]').textContent = String(state.bridgeCount);
    this.mustFind<HTMLElement>('[data-anchor-count]').textContent = String(state.anchors);
    const bridgeHint = this.mustFind<HTMLElement>('[data-bridge-hint]');
    bridgeHint.classList.toggle('is-visible', state.previewBridges > 0);
    bridgeHint.textContent = state.previewBridges > 0
      ? `${state.previewBridges} automatic timber bridge${state.previewBridges === 1 ? '' : 's'} in this route`
      : 'Cross the river to generate a bridge';
    const build = this.mustFind<HTMLButtonElement>('[data-build]');
    build.disabled = !state.canBuild;
    build.classList.toggle('is-ready', state.canBuild);
    build.querySelector('span')!.textContent = state.previewBridges > 0 ? 'Build road + bridge' : 'Build road';

    const revision = this.network.getTopologyRevision();
    if (revision !== this.lastTopologyRevision) {
      this.lastTopologyRevision = revision;
      this.decor.updateRoadClearance(this.network.edges.values());
    }
  }

  private readonly onResize = (): void => {
    const width = this.root.clientWidth || window.innerWidth;
    const height = this.root.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly startAmbientAudio = (): void => {
    this.ambientAudio = new Audio('/sounds/ambient/river_water_rushing.mp3');
    this.ambientAudio.loop = true;
    this.ambientAudio.volume = 0.055;
    void this.ambientAudio.play().catch(() => undefined);
  };

  private readonly animate = (): void => {
    requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.cameraController.update(dt);
    this.decor.update(this.clock.elapsedTime);
    this.mustFind<HTMLElement>('[data-zoom]').textContent = `${Math.round(this.cameraController.getZoomPercent())}%`;
    this.renderer.render(this.scene, this.camera);
  };

  private mustFind<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing interface element: ${selector}`);
    return element;
  }
}

function pageTemplate(): string {
  return `
    <section class="viewport" data-viewport>
      <header class="topbar">
        <div class="brand-panel panel">
          <div class="brand-mark" aria-hidden="true">KR</div>
          <div>
            <div class="eyebrow">KUPA ROADWORKS · FIXED MAP</div>
            <h1>Road &amp; Bridge Editor</h1>
          </div>
          <span class="client-badge">CLIENT-SIDE</span>
        </div>

        <div class="view-panel panel" aria-label="View information">
          <div><span>ZOOM</span><strong data-zoom>100%</strong></div>
          <div><span>MAP</span><strong>SMALL</strong></div>
          <div><span>SEED</span><strong>071A2E0D</strong></div>
        </div>
      </header>

      <aside class="stats-panel panel" aria-label="Road network statistics">
        <div class="stats-title">NETWORK</div>
        <dl>
          <div><dt>Road segments</dt><dd data-road-count>0</dd></div>
          <div><dt>River bridges</dt><dd data-bridge-count>0</dd></div>
          <div><dt>Draft points</dt><dd data-anchor-count>0</dd></div>
        </dl>
      </aside>

      <aside class="controls-panel panel">
        <div class="eyebrow">CAMERA</div>
        <div class="control-row"><kbd>WASD</kbd><span>Move across map</span></div>
        <div class="control-row"><kbd>MMB</kbd><span>Rotate view</span></div>
        <div class="control-row"><kbd>WHEEL</kbd><span>Zoom 30–1000%</span></div>
        <div class="control-row"><kbd>Q / E</kbd><span>Rotate left / right</span></div>
      </aside>

      <div class="bridge-hint panel" data-bridge-hint>Cross the river to generate a bridge</div>

      <div class="status-stack">
        <div class="mode-label" data-mode>ROAD TOOL ACTIVE</div>
        <div class="status-message panel"><span class="status-dot"></span><span data-status>Click the terrain to begin a road</span></div>
      </div>

      <nav class="tool-dock panel" aria-label="Road building tools">
        <button class="tool-button is-active" data-tool-road type="button" aria-label="Toggle road tool" aria-pressed="true">
          <span class="hammer-sprite" aria-hidden="true"></span>
          <span class="tool-label">Road</span>
          <kbd>R</kbd>
        </button>
        <div class="dock-divider"></div>
        <button class="dock-action" data-undo type="button" aria-label="Undo last point or road"><span>↶</span>Undo</button>
        <button class="dock-action" data-redo type="button" aria-label="Redo road"><span>↷</span>Redo</button>
        <button class="dock-action danger" data-clear type="button" aria-label="Clear all roads"><span>×</span>Clear</button>
        <div class="dock-divider"></div>
        <button class="build-button" data-build type="button" disabled>
          <span>Build road</span><kbd>ENTER</kbd>
        </button>
      </nav>

      <div class="curve-tip"><kbd>CTRL</kbd> + <kbd>WHEEL</kbd> bends the next spline segment</div>
    </section>
  `;
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');
new KupaRoadworksApp(root);
