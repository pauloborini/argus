/**
 * Fixture stress Plano 1 — símbolo acima dos caps balanced (16 linhas / 120 tokens).
 * Needle exclusivo fica além da janela truncada para prova explore→retrieve.
 */
export function largeHardeningSymbol(): string {
  return [
    "pad-01",
    "pad-02",
    "pad-03",
    "pad-04",
    "pad-05",
    "pad-06",
    "pad-07",
    "pad-08",
    "pad-09",
    "pad-10",
    "pad-11",
    "pad-12",
    "pad-13",
    "pad-14",
    "pad-15",
    "pad-16",
    "HARDENING_NEEDLE_BEYOND_CAP_16",
  ].at(-1)!;
}
