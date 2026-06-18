/**
 * Estimador de tokens subword-aware (BPE-like), zero deps.
 * Quebra camelCase, trata pontuação como 1 token, e divide runs longos em
 * ~6 chars/subtoken — alinhado com comportamento observado de cl100k_base.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  const atoms = text.match(/[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g);
  if (!atoms) return 0;
  let count = 0;
  for (const atom of atoms) {
    if (/^[A-Za-z]+$/.test(atom)) {
      const parts = atom.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
      for (const part of parts) {
        count += Math.max(1, Math.ceil(part.length / 6));
      }
    } else {
      count += 1;
    }
  }
  return count;
}
