// Quantização int8 simétrica de vetores densos + cosine sobre int8.
//
// Vetores do embedder já chegam L2-normalizados (float32). Guardar float32 cru
// custa 4 bytes/dim; int8 corta para 1 byte/dim (4×) com erro de quantização
// desprezível para ranking por cosine. A escala (max-abs / 127) é persistida só
// para eventual dequantização/debug — para *similaridade* ela se cancela
// (cosine é invariante a fator escalar positivo), então `cosineInt8` opera
// direto nos int8.

export interface QuantizedVector {
  bytes: Int8Array;
  scale: number;
}

/** Quantização simétrica por max-abs: byte = round(v / scale), scale = maxAbs/127. */
export function quantizeInt8(vector: Float32Array): QuantizedVector {
  let maxAbs = 0;
  for (const value of vector) {
    const abs = Math.abs(value);
    if (abs > maxAbs) {
      maxAbs = abs;
    }
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const bytes = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    const q = Math.round(vector[i] / scale);
    bytes[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return { bytes, scale };
}

/** Serializa o vetor int8 para BLOB (Buffer) e de volta. */
export function int8ToBlob(bytes: Int8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function blobToInt8(blob: Buffer): Int8Array {
  // Cópia para um buffer próprio: o Buffer vindo do SQLite pode compartilhar
  // memória reciclada entre linhas.
  return new Int8Array(Int8Array.from(blob));
}

/**
 * Cosine entre dois vetores int8. O fator de escala de cada lado se cancela no
 * cosine, então operamos direto nos inteiros. Retorna 0 se algum vetor é nulo.
 */
export function cosineInt8(a: Int8Array, b: Int8Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
