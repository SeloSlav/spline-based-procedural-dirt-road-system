export type DeciduousFoliagePresentation = {
  springFlush: number;
  autumnColor: number;
  dormancy: number;
};

export const MATURE_DECIDUOUS_FOLIAGE: Readonly<DeciduousFoliagePresentation> =
  Object.freeze({ springFlush: 0, autumnColor: 0, dormancy: 0 });
