import type { WorldTerrainPreset } from './worldTerrainPresets.ts';

export type WorldGenerationSettings = {
  seed: number;
  terrainPreset: WorldTerrainPreset;
  mapSize: 'small' | 'medium' | 'large';
  topography: number;
  hydrology: number;
  forestDensity: number;
  resourceAbundance: number;
  resourceVariety: number;
  conflictMode: 'peaceful' | 'frontier';
  enemyPressure: number;
};
