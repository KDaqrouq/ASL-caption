import type { FaceFrame, Frame, HandFrame } from './types';

/** Every sign is resampled to this many time steps before comparison. */
export const SEQ_LEN = 32;

/** Per-hand feature block: presence flag, wrist position (2), handshape (20 joints x 3). */
export const HAND_DIM = 63;
export const FRAME_DIM = 2 * HAND_DIM;
const SHAPE_OFFSET = 3;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Drops leading and trailing frames in which no hand is visible. */
export function trimToHands(frames: Frame[]): Frame[] {
  let a = 0;
  let b = frames.length - 1;
  while (a <= b && frames[a].hands.length === 0) a++;
  while (b >= a && frames[b].hands.length === 0) b--;
  return frames.slice(a, b + 1);
}

/** Resamples a sequence to `n` frames evenly spaced in time (nearest neighbour). */
export function resample(frames: Frame[], n = SEQ_LEN): Frame[] {
  if (frames.length === 0) return [];
  const t0 = frames[0].t;
  const t1 = frames[frames.length - 1].t;
  const out: Frame[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = n === 1 ? t0 : t0 + ((t1 - t0) * i) / (n - 1);
    while (j + 1 < frames.length && Math.abs(frames[j + 1].t - target) <= Math.abs(frames[j].t - target)) j++;
    out.push(frames[j]);
  }
  return out;
}

/**
 * Signing-space anchor for a sequence: the median face box when a face was seen,
 * otherwise a box derived from the hands so that relative motion still counts.
 */
export function anchorFor(frames: Frame[]): FaceFrame {
  const faces = frames.map((f) => f.face).filter((f): f is FaceFrame => f !== null);
  if (faces.length > 0) {
    return { cx: median(faces.map((f) => f.cx)), cy: median(faces.map((f) => f.cy)), w: median(faces.map((f) => f.w)) };
  }
  const hands = frames.flatMap((f) => f.hands);
  if (hands.length === 0) return { cx: 0.5, cy: 0.5, w: 0.2 };
  const s = median(hands.map((h) => h.s));
  return { cx: median(hands.map((h) => h.wx)), cy: median(hands.map((h) => h.wy)) - 2 * s, w: Math.max(2 * s, 1e-3) };
}

/** The label of the hand that appears most often: the signer's dominant hand. */
function dominantLabel(frames: Frame[]): HandFrame['label'] {
  let left = 0;
  let right = 0;
  for (const f of frames) for (const h of f.hands) h.label === 'Left' ? left++ : right++;
  return right > left ? 'Right' : 'Left';
}

/**
 * Puts each hand into a stable slot: 0 = dominant, 1 = other hand. For one-handed signs
 * the visible hand always goes to slot 0, which absorbs MediaPipe handedness flicker.
 */
function assignSlots(
  hands: HandFrame[],
  dominant: HandFrame['label'],
  twoHanded: boolean,
  prevDominant: HandFrame | null,
): [HandFrame | null, HandFrame | null] {
  if (hands.length === 0) return [null, null];
  if (hands.length === 1) {
    const h = hands[0];
    return !twoHanded || h.label === dominant ? [h, null] : [null, h];
  }
  const [a, b] = hands;
  if (a.label !== b.label) return a.label === dominant ? [a, b] : [b, a];
  if (prevDominant) {
    const da = Math.hypot(a.wx - prevDominant.wx, a.wy - prevDominant.wy);
    const db = Math.hypot(b.wx - prevDominant.wx, b.wy - prevDominant.wy);
    return da <= db ? [a, b] : [b, a];
  }
  return [a, b];
}

function writeHand(out: Float32Array, offset: number, h: HandFrame, anchor: FaceFrame): void {
  out[offset] = 1;
  out[offset + 1] = (h.wx - anchor.cx) / anchor.w;
  out[offset + 2] = (h.wy - anchor.cy) / anchor.w;
  const w = h.world;
  let palm = Math.hypot(w[27] - w[0], w[28] - w[1], w[29] - w[2]);
  if (!(palm > 1e-4)) palm = 0.09;
  for (let i = 1; i < 21; i++) {
    const o = offset + SHAPE_OFFSET + (i - 1) * 3;
    out[o] = (w[i * 3] - w[0]) / palm;
    out[o + 1] = (w[i * 3 + 1] - w[1]) / palm;
    out[o + 2] = (w[i * 3 + 2] - w[2]) / palm;
  }
}

/** Converts a (resampled) frame sequence into per-frame feature vectors. */
export function featurize(frames: Frame[]): Float32Array[] {
  const anchor = anchorFor(frames);
  const dominant = dominantLabel(frames);
  const twoHanded = frames.some((f) => f.hands.length >= 2);
  let prev: HandFrame | null = null;
  return frames.map((f) => {
    const v = new Float32Array(FRAME_DIM);
    const [d, o] = assignSlots(f.hands, dominant, twoHanded, prev);
    if (d) {
      writeHand(v, 0, d, anchor);
      prev = d;
    }
    if (o) writeHand(v, HAND_DIM, o, anchor);
    return v;
  });
}

/** Full preprocessing used for both training samples and live queries. */
export function prepare(frames: Frame[]): Float32Array[] {
  return featurize(resample(trimToHands(frames)));
}
