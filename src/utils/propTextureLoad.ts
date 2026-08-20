import * as THREE from 'three';
import { publicAssetUrl } from './publicAssetUrl.ts';
import { loadBitmapTexture } from './textureLoad.ts';

export type MossyRockTextureSet = {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
};

export async function loadMossyRockTextures(maxAnisotropy: number): Promise<MossyRockTextureSet> {
  const base = publicAssetUrl('assets/textures/props/mossy_rock');
  const [map, normalMap, roughnessMap] = await Promise.all([
    loadBitmapTexture(`${base}/albedo.png`, maxAnisotropy, { srgb: true }),
    loadBitmapTexture(`${base}/normal.png`, maxAnisotropy),
    loadBitmapTexture(`${base}/roughness.png`, maxAnisotropy),
  ]);
  return { map, normalMap, roughnessMap };
}

export async function loadPineFoliageTextures(maxAnisotropy: number): Promise<{
  needleMap: THREE.Texture;
  needleRoughnessMap: THREE.Texture;
}> {
  const base = publicAssetUrl('assets/textures/props/pine_foliage');
  const [needleMap, needleRoughnessMap] = await Promise.all([
    loadBitmapTexture(`${base}/albedo.png`, maxAnisotropy, { srgb: true, anisotropyLimit: 4 }),
    loadBitmapTexture(`${base}/roughness.png`, maxAnisotropy, { anisotropyLimit: 4 }),
  ]);
  return { needleMap, needleRoughnessMap };
}
