// Keep this list aligned with the seven Gorski presets plus the apple/cherry
// backyard models. A directory-wide eager glob made every unused SeedThree
// biome texture part of the production payload.
const barkModules = import.meta.glob(
  '../../../vendor/seedthree/assets/bark/{american_beech,white_oak,red_maple,sweetgum,douglas_fir,loblolly,pine,apple_bark,cherry_bark}_{albedo,normal,roughness}.png',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>;

const projectShrubBarkModules = import.meta.glob(
  [
    '../../assets/vegetation/shrubs/bark/{bilberry_branch,common_juniper_branch,hornbeam_hedge_branch}_{albedo,normal,roughness}.png',
    '../../assets/vegetation/common-dogwood/common_dogwood_branch_{albedo,normal,roughness}.png',
    '../../assets/vegetation/stinging-nettle/stinging_nettle_stem_{albedo,normal,roughness}.png',
  ],
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>;

const leafModules = import.meta.glob(
  [
    '../../../vendor/seedthree/assets/leaves/{american_beech_single,white_oak_single,red_maple_single,sweetgum_single,douglas_fir_needle,loblolly_needle,pine_needle}_{albedo,normal,roughness,translucency}.png',
    '../../../vendor/seedthree/assets/leaves/cattail_reed_card{,_normal,_roughness,_translucency}.png',
  ],
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>;

const projectShrubLeafModules = import.meta.glob(
  [
    '../../assets/vegetation/shrubs/leaves/{bilberry,fern,juniper_scrub,hornbeam_hedge_spray}_{albedo,normal,roughness,translucency}.png',
    '../../assets/vegetation/common-dogwood/common_dogwood_single_{albedo,normal,roughness,translucency}.png',
    '../../assets/vegetation/stinging-nettle/stinging_nettle_single_{albedo,normal,roughness,translucency}.png',
  ],
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>;

function byBasename(modules: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(modules)) {
    out[path.split('/').pop() ?? path] = url;
  }
  return out;
}

const barkUrls = {
  ...byBasename(barkModules),
  ...byBasename(projectShrubBarkModules),
};
const leafUrls = {
  ...byBasename(leafModules),
  ...byBasename(projectShrubLeafModules),
};

export function seedThreeBarkUrl(name: string): string | undefined {
  return barkUrls[name];
}

export function seedThreeLeafUrl(name: string): string | undefined {
  return leafUrls[name];
}
