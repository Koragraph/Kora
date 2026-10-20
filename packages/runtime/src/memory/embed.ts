import type { Embedder } from './types';
import { words, stem } from './text';

function fnv(s: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Dependency-free feature-hashing embedder (stemmed words + char trigrams → 256 dims). It is NOT a semantic model:
 * it only adds typo/morphology tolerance on top of FTS. It exists so the vector path is exercised end to end and so
 * a real ONNX model can be swapped in behind the same `Embedder` interface later.
 */
export function createHashEmbedder(dims = 256): Embedder {
  const embedOne = (text: string): Float32Array => {
    const v = new Float32Array(dims);
    const add = (feat: string, w: number) => {
      const h = fnv(feat);
      v[h % dims] += (fnv(feat, 99991) & 1 ? 1 : -1) * w;
    };
    for (const raw of words(text)) {
      const w = stem(raw);
      add(`w:${w}`, 1);
      const p = `^${w}$`;
      for (let i = 0; i + 3 <= p.length; i++) add(`t:${p.slice(i, i + 3)}`, 0.35);
    }
    let n = 0;
    for (let i = 0; i < dims; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dims; i++) v[i] /= n;
    return v;
  };
  return { id: `hash-${dims}-v1`, dims, embed: async (texts) => texts.map(embedOne) };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export const encodeVec = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

export function decodeVec(b: unknown): Float32Array | null {
  if (!(b instanceof Uint8Array) || b.byteLength === 0 || b.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(b); // aligned copy
  return new Float32Array(copy.buffer);
}
