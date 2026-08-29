import type * as THREE from 'three';

export function generateDichotomous(
  params: Record<string, unknown>,
  rng: unknown,
): {
  stems: unknown[];
  terminalStems: unknown[];
  geometry: THREE.BufferGeometry;
};
