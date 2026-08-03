export type DeciduousFoliagePresentation = {
  /** Pale new-leaf treatment; zero is the mature summer color. */
  springFlush: number;
  /** Species-specific warm autumn treatment. */
  autumnColor: number;
  /** Fraction of deciduous leaf pixels that have dropped. */
  dormancy: number;
};

export const MATURE_DECIDUOUS_FOLIAGE: Readonly<DeciduousFoliagePresentation> =
  Object.freeze({
    springFlush: 0,
    autumnColor: 0,
    dormancy: 0,
  });
