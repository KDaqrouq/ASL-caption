import { HAND_DIM, SEQ_LEN, prepare } from './features';
import type { Frame, Prediction, Sample } from './types';

/**
 * Few-shot sign recognizer: nearest-neighbour search with dynamic time warping (DTW)
 * over per-frame hand features. DTW lets a sign be performed faster or slower than the
 * recorded examples, and a handful of examples per phrase is enough to train it.
 */

const POS_WEIGHT = 0.7;
const SHAPE_WEIGHT = 1;
/** Cost when a hand is visible in one sequence but not the other. */
const MISSING_HAND = 1.5;
const SLOT_WEIGHT = [1, 0.6];
const BAND = Math.ceil(SEQ_LEN * 0.25);
/** Typical same-phrase distance before any examples have been compared. */
const DEFAULT_TAU = 0.5;
/** Queries farther than this multiple of a phrase's typical distance lose confidence. */
const OUTLIER_RATIO = 2;

export function frameDistance(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let slot = 0; slot < 2; slot++) {
    const o = slot * HAND_DIM;
    const pa = a[o] > 0;
    const pb = b[o] > 0;
    if (!pa && !pb) continue;
    if (pa !== pb) {
      d += SLOT_WEIGHT[slot] * MISSING_HAND;
      continue;
    }
    const pos = Math.hypot(a[o + 1] - b[o + 1], a[o + 2] - b[o + 2]);
    let ss = 0;
    for (let k = o + 3; k < o + HAND_DIM; k++) {
      const diff = a[k] - b[k];
      ss += diff * diff;
    }
    // Root-mean-square joint displacement, in palm lengths.
    const shape = Math.sqrt(ss / 20);
    d += SLOT_WEIGHT[slot] * (POS_WEIGHT * pos + SHAPE_WEIGHT * shape);
  }
  return d;
}

/** Banded DTW distance, normalised by the longer sequence length. */
export function dtw(a: Float32Array[], b: Float32Array[], band = BAND): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return Infinity;
  const w = Math.max(band, Math.abs(n - m));
  let prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const lo = Math.max(1, i - w);
    const hi = Math.min(m, i + w);
    for (let j = lo; j <= hi; j++) {
      const best = Math.min(prev[j], cur[j - 1], prev[j - 1]);
      if (best === Infinity) continue;
      cur[j] = best + frameDistance(a[i - 1], b[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / Math.max(n, m);
}

function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

type Item = { phrase: number; feats: Float32Array[] };

export type Evaluation = {
  /** Leave-one-out accuracy over all samples, or null with fewer than two taught phrases. */
  accuracy: number | null;
  perPhrase: { correct: number; total: number }[];
};

export class Recognizer {
  private readonly items: Item[];
  /** Typical distance between examples of the same phrase, per phrase. */
  private readonly tau: number[];
  private readonly tauGlobal: number;

  constructor(
    samples: Sample[],
    private readonly numPhrases: number,
  ) {
    this.items = samples
      .filter((s) => s.phrase >= 0 && s.phrase < numPhrases)
      .map((s) => ({ phrase: s.phrase, feats: prepare(s.frames) }))
      .filter((it) => it.feats.length > 0);

    // Nearest same-phrase neighbour distance for every example.
    const nearest: number[][] = Array.from({ length: numPhrases }, () => []);
    for (let p = 0; p < numPhrases; p++) {
      const group = this.items.filter((it) => it.phrase === p);
      for (let i = 0; i < group.length; i++) {
        let best = Infinity;
        for (let j = 0; j < group.length; j++) {
          if (i !== j) best = Math.min(best, dtw(group[i].feats, group[j].feats));
        }
        if (best < Infinity) nearest[p].push(best);
      }
    }
    const all = nearest.flat();
    this.tauGlobal = all.length > 0 ? Math.max(median(all), 0.05) : DEFAULT_TAU;
    this.tau = nearest.map((d) => (d.length > 0 ? Math.max(median(d), 0.05) : this.tauGlobal));
  }

  get sampleCount(): number {
    return this.items.length;
  }

  get trainedPhrases(): number[] {
    return [...new Set(this.items.map((it) => it.phrase))].sort((a, b) => a - b);
  }

  /** Classifies a raw frame sequence (as captured by the segmenter). */
  classify(frames: Frame[]): Prediction | null {
    const feats = prepare(frames);
    return feats.length === 0 ? null : this.classifyFeatures(feats);
  }

  private classifyFeatures(feats: Float32Array[], exclude?: Item): Prediction | null {
    const distances = new Array<number>(this.numPhrases).fill(Infinity);
    for (const it of this.items) {
      if (it === exclude) continue;
      const d = dtw(feats, it.feats);
      if (d < distances[it.phrase]) distances[it.phrase] = d;
    }
    let index = -1;
    for (let p = 0; p < this.numPhrases; p++) {
      if (distances[p] < Infinity && (index < 0 || distances[p] < distances[index])) index = p;
    }
    if (index < 0) return null;

    // Softmax over phrases (how clearly the best phrase beats the rest) ...
    const best = distances[index];
    const temperature = 0.25 * this.tauGlobal;
    let sum = 0;
    for (const d of distances) if (d < Infinity) sum += Math.exp(-(d - best) / temperature);
    const margin = 1 / sum;
    // ... times how close the query is to that phrase's examples (rejects unknown signs).
    const ratio = best / this.tau[index];
    const familiarity = ratio <= OUTLIER_RATIO ? 1 : Math.exp(-1.5 * (ratio - OUTLIER_RATIO));
    return { index, confidence: margin * familiarity, distances };
  }

  /** Leave-one-out evaluation: each example is classified against all the others. */
  evaluate(): Evaluation {
    const perPhrase = Array.from({ length: this.numPhrases }, () => ({ correct: 0, total: 0 }));
    if (this.trainedPhrases.length < 2) return { accuracy: null, perPhrase };
    let correct = 0;
    let total = 0;
    for (const it of this.items) {
      const pred = this.classifyFeatures(it.feats, it);
      if (!pred) continue;
      const ok = pred.index === it.phrase;
      perPhrase[it.phrase].total++;
      total++;
      if (ok) {
        perPhrase[it.phrase].correct++;
        correct++;
      }
    }
    return { accuracy: total > 0 ? correct / total : null, perPhrase };
  }
}
