// Project-owned copies of the reference SeedThree shrub presets. Keeping them
// here makes the vegetation slice portable without mutating the vendor submodule.
export const bilberry = {
  name: 'Gorski Bilberry', latin: 'Vaccinium myrtillus', category: 'shrub',
  bark: 'bilberry_branch_albedo.png', leaf: 'bilberry_albedo.png', biome: 'temperate',
  tileWorldSize: 0.35, plantSink: 0.012, foliageType: 'sprayClusters',
  foliage: {
    clustersPerBranch: 4, clusterSize: 0.17, clusterSizeVar: 0.28, clusterQuads: 2,
    alphaTest: 0.44, tint: 0xd8efbb, transmit: [0.28, 0.46, 0.18],
    downAngle: 34, downAngleV: 14, droop: 12, startFrac: 0.18,
    parentSprays: 0.5, rotate: 137,
  },
  params: {
    trunks: 5, trunkSplayDeg: 38, firstForkHeight: 0.04, armLength: 0.15,
    armFalloff: 0.84, forkGenerations: 4, branchiness: 0.78, forkSpread: 29,
    forkTriChance: 0.08, curlUp: 0.16, armBend: 11, gnarliness: 13,
    continuationKink: 10, forkRadiusKeep: 0.76, trunkRadius: 0.008,
    trunkFlare: 1.15, branchRepel: 0.5, minRadius: 0.0018,
    radialSegs: 5, segCurveRes: 3, tileWorldSize: 0.35, barkGrainU: true,
    windWeightScale: 0.22,
  },
} as const;

export const commonJuniper = {
  name: 'Gorski Common Juniper', latin: 'Juniperus communis', category: 'shrub',
  bark: 'common_juniper_branch_albedo.png', leaf: 'juniper_scrub_albedo.png', biome: 'temperate',
  tileWorldSize: 0.4, plantSink: 0.015, foliageType: 'sprayClusters',
  foliage: {
    clustersPerBranch: 5, clusterSize: 0.34, clusterSizeVar: 0.32, clusterQuads: 2,
    alphaTest: 0.48, tint: 0xc4d4b6, transmit: [0.18, 0.28, 0.16],
    downAngle: 24, downAngleV: 18, droop: 8, startFrac: 0.12,
    parentSprays: 0.7, rotate: 137,
  },
  params: {
    trunks: 6, trunkSplayDeg: 42, firstForkHeight: 0.09, armLength: 0.33,
    armFalloff: 0.86, forkGenerations: 4, branchiness: 0.86, forkSpread: 25,
    forkTriChance: 0.12, curlUp: 0.24, armBend: 10, gnarliness: 16,
    continuationKink: 12, forkRadiusKeep: 0.8, trunkRadius: 0.012,
    trunkFlare: 1.2, branchRepel: 0.66, minRadius: 0.0025,
    radialSegs: 6, segCurveRes: 3, tileWorldSize: 0.4, barkGrainU: true,
    windWeightScale: 0.18,
  },
} as const;

export const commonHornbeamHedge = {
  name: 'Gorski Field Hornbeam Hedge',
  latin: 'Carpinus betulus',
  category: 'shrub',
  bark: 'hornbeam_hedge_branch_albedo.png',
  leaf: 'hornbeam_hedge_spray_albedo.png',
  biome: 'temperate',
  tileWorldSize: 0.42,
  plantSink: 0.018,
  foliageType: 'sprayClusters',
  foliage: {
    clustersPerBranch: 3, clusterSize: 0.22, clusterSizeVar: 0.24, clusterQuads: 2,
    alphaTest: 0.44, tint: 0xc9dfaa, transmit: [0.28, 0.42, 0.16],
    downAngle: 42, downAngleV: 12, droop: 7, startFrac: 0.16,
    parentSprays: 0.62, rotate: 137,
  },
  params: {
    trunks: 5, trunkSplayDeg: 21, firstForkHeight: 0.1, armLength: 0.24,
    armFalloff: 0.84, forkGenerations: 4, branchiness: 0.86, forkSpread: 25,
    forkTriChance: 0.12, curlUp: 0.38, armBend: 8, gnarliness: 9,
    continuationKink: 6, forkRadiusKeep: 0.78, trunkRadius: 0.012,
    trunkFlare: 1.2, branchRepel: 0.62, minRadius: 0.0024,
    radialSegs: 5, segCurveRes: 3, tileWorldSize: 0.42, windWeightScale: 0.18,
  },
} as const;
