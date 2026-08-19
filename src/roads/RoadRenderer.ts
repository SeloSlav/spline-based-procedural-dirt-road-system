import * as THREE from 'three';
import type { RiverField } from '../rivers/RiverField.ts';
import { getStillWaterSurfaceY } from '../rivers/RiverWaterLevel.ts';
import type { Terrain } from '../terrain/Terrain.ts';
import { BuildingAccessSpurs } from './BuildingAccessSpurs.ts';
import type { BuildingRoadConnectionSource } from './BuildingRoadConnections.ts';
import { applyBridgeHeightsToPath, detectBridgeSpans, type BridgeSamplingContext } from './RiverBridgeSpans.ts';
import type { RoadMaterialFactory } from './RoadMaterialFactory.ts';
import { RoadJunctionBuilder } from './RoadJunctionBuilder.ts';
import { ROAD_PLACED_SAMPLE_SPACING, RoadMeshBuilder } from './RoadMeshBuilder.ts';
import type { RoadNetwork } from './RoadNetwork.ts';

const PREVIEW_WIDTH = 4.2;
const PREVIEW_Y_OFFSET = 0.2;

/** Editor adapter around the authored road mesh/material implementation. */
export class RoadRenderer {
  readonly group = new THREE.Group();
  readonly previewGroup = new THREE.Group();
  private readonly roadSurfaceGroup = new THREE.Group();
  private readonly network: RoadNetwork;
  private readonly meshBuilder: RoadMeshBuilder;
  private readonly junctionBuilder: RoadJunctionBuilder;
  private readonly buildingAccessSpurs: BuildingAccessSpurs;
  private buildingAccessSources: BuildingRoadConnectionSource[] = [];
  private readonly bridgeContext: BridgeSamplingContext;
  private bridgeCount = 0;

  constructor(
    network: RoadNetwork,
    terrain: Terrain,
    riverField: RiverField,
    materials: RoadMaterialFactory,
  ) {
    this.network = network;
    this.group.name = 'Road network';
    this.roadSurfaceGroup.name = 'Main road surfaces';
    this.group.add(this.roadSurfaceGroup);
    this.previewGroup.name = 'Road preview';
    this.bridgeContext = {
      isWaterAt: (x, z) => riverField.isRenderedWetAt(x, z),
      getTerrainY: (x, z) => terrain.getHeightAt(x, z),
      getWaterSurfaceY: (x, z) => getStillWaterSurfaceY(terrain, riverField, x, z),
    };
    this.meshBuilder = new RoadMeshBuilder(terrain, materials, this.bridgeContext);
    this.junctionBuilder = new RoadJunctionBuilder(terrain, materials);
    this.buildingAccessSpurs = new BuildingAccessSpurs({
      parent: this.group,
      terrain,
      meshBuilder: this.meshBuilder,
    });
  }

  rebuild(): void {
    disposeGroupChildren(this.roadSurfaceGroup);
    this.bridgeCount = 0;
    for (const edge of this.network.edges.values()) {
      const mesh = this.meshBuilder.buildEdge(edge, this.network);
      this.bridgeCount += edge.materialData?.bridgeSpans?.length ?? 0;
      this.roadSurfaceGroup.add(mesh);
    }
    this.roadSurfaceGroup.add(this.junctionBuilder.build(this.network));
    this.buildingAccessSpurs.sync(this.buildingAccessSources, this.network);
  }

  syncBuildingAccessRoads(buildings: Iterable<BuildingRoadConnectionSource>): void {
    this.buildingAccessSources = [...buildings].map((building) => ({ ...building }));
    this.buildingAccessSpurs.sync(this.buildingAccessSources, this.network);
  }

  updatePreview(
    path: THREE.Vector3[],
    valid: boolean,
  ): { bridgeCount: number; sampled: THREE.Vector3[] } {
    disposeGroupChildren(this.previewGroup);
    if (path.length < 2) return { bridgeCount: 0, sampled: path };
    const sampled = this.meshBuilder.samplePath(path, ROAD_PLACED_SAMPLE_SPACING);
    const spans = detectBridgeSpans(sampled, this.bridgeContext);
    const elevated = sampled.map((point) => point.clone());
    if (spans.length > 0) {
      applyBridgeHeightsToPath(elevated, spans, this.bridgeContext, PREVIEW_Y_OFFSET);
    }
    const preview = this.meshBuilder.buildPreview(path, PREVIEW_WIDTH, valid, elevated);
    if (preview) this.previewGroup.add(preview);
    return { bridgeCount: spans.length, sampled: elevated };
  }

  clearPreview(): void {
    disposeGroupChildren(this.previewGroup);
  }

  sampleTerrainPath(path: THREE.Vector3[]): THREE.Vector3[] {
    return this.meshBuilder.samplePath(path, ROAD_PLACED_SAMPLE_SPACING);
  }

  getBridgeCount(): number {
    return this.bridgeCount;
  }
}

function disposeGroupChildren(group: THREE.Group): void {
  for (const child of [...group.children]) {
    child.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    group.remove(child);
  }
}
