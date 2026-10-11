import { trimToHands } from './features';
import type { Frame, HandFrame } from './types';

/**
 * Splits the live frame stream into individual signs. A sign starts when a hand moves
 * (or comes into view) and ends when the hands drop out of view or hold still.
 * Speeds are measured in palm lengths per second, so they do not depend on how far
 * the signer sits from the camera.
 */
export const SEGMENTER_DEFAULTS = {
  startSpeed: 1.5,
  stillSpeed: 0.6,
  stillMs: 500,
  lostMs: 300,
  maxMs: 4000,
  minMs: 300,
  minHandFrames: 6,
  preRollMs: 200,
  /** Speed is measured over this baseline so that landmark jitter does not read as motion. */
  speedWindowMs: 150,
  bufferMs: 5000,
};

export type SegmenterOptions = typeof SEGMENTER_DEFAULTS;

function shapeDelta(a: HandFrame, b: HandFrame): number {
  const wa = a.world;
  const wb = b.world;
  const palm = Math.max(Math.hypot(wa[27] - wa[0], wa[28] - wa[1], wa[29] - wa[2]), 1e-3);
  let ss = 0;
  for (let i = 1; i < 21; i++) {
    for (let k = 0; k < 3; k++) {
      const d = wa[i * 3 + k] - wa[k] - (wb[i * 3 + k] - wb[k]);
      ss += d * d;
    }
  }
  return Math.sqrt(ss / 20) / palm;
}

/** Fastest hand movement between two frames, in palm lengths per second. */
export function handSpeed(a: Frame, b: Frame): number {
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0 || a.hands.length === 0 || b.hands.length === 0) return 0;
  let max = 0;
  for (const hb of b.hands) {
    let ha = a.hands.find((h) => h.label === hb.label);
    if (!ha || a.hands.length !== b.hands.length) {
      ha = a.hands.reduce((p, c) =>
        Math.hypot(c.wx - hb.wx, c.wy - hb.wy) < Math.hypot(p.wx - hb.wx, p.wy - hb.wy) ? c : p,
      );
    }
    const trans = Math.hypot(hb.wx - ha.wx, hb.wy - ha.wy) / Math.max(hb.s, 1e-3);
    max = Math.max(max, (trans + shapeDelta(ha, hb)) / dt);
  }
  return max;
}

export class Segmenter {
  private readonly opts: SegmenterOptions;
  private buffer: Frame[] = [];
  private seg: Frame[] | null = null;
  private segPeak = 0;
  private forced = false;
  private armed = false;
  private prev: Frame | null = null;
  private speed = 0;
  private stillSince: number | null = null;
  private lostSince: number | null = null;

  constructor(opts: Partial<SegmenterOptions> = {}) {
    this.opts = { ...SEGMENTER_DEFAULTS, ...opts };
  }

  /** True while a sign is being captured. */
  get active(): boolean {
    return this.seg !== null;
  }

  /** Smoothed hand speed of the latest frame. */
  get currentSpeed(): number {
    return this.speed;
  }

  /** Forces the next frame with a visible hand to start a sign (used when recording examples). */
  arm(): void {
    this.seg = null;
    this.armed = true;
  }

  /** Frames from the last `ms` milliseconds. */
  recent(ms: number): Frame[] {
    const last = this.buffer[this.buffer.length - 1];
    if (!last) return [];
    return this.buffer.filter((f) => last.t - f.t <= ms);
  }

  /** Feeds one frame; returns the frames of a sign when one has just ended. */
  push(f: Frame): Frame[] | null {
    const o = this.opts;
    this.buffer.push(f);
    while (this.buffer.length > 0 && f.t - this.buffer[0].t > o.bufferMs) this.buffer.shift();

    let ref: Frame | null = null;
    for (const b of this.buffer) {
      if (f.t - b.t >= o.speedWindowMs && b.hands.length > 0) ref = b;
    }
    const instant = ref && f.t - ref.t <= 2 * o.speedWindowMs ? handSpeed(ref, f) : 0;
    this.speed = f.hands.length === 0 ? 0 : 0.6 * this.speed + 0.4 * instant;
    const present = f.hands.length > 0;
    const appeared = present && this.prev !== null && this.prev.hands.length === 0;
    this.prev = f;

    if (!this.seg) {
      if (present && (this.armed || appeared || this.speed > o.startSpeed)) {
        this.seg = this.buffer.filter((b) => f.t - b.t <= o.preRollMs);
        this.segPeak = this.speed;
        this.forced = this.armed;
        this.armed = false;
        this.stillSince = null;
        this.lostSince = null;
      }
      return null;
    }

    this.seg.push(f);
    this.segPeak = Math.max(this.segPeak, this.speed);

    if (!present) {
      this.lostSince ??= f.t;
      if (f.t - this.lostSince >= o.lostMs) return this.finish(this.lostSince);
    } else {
      this.lostSince = null;
    }

    // While recording, a hand held still before the sign has begun must not end it.
    const moved = this.segPeak >= o.startSpeed || !this.forced;
    if (present && moved && this.speed < o.stillSpeed) {
      this.stillSince ??= f.t;
      if (f.t - this.stillSince >= o.stillMs) return this.finish(this.stillSince + 100);
    } else {
      this.stillSince = null;
    }

    if (f.t - this.seg[0].t >= o.maxMs) return this.finish(f.t);
    return null;
  }

  /** Ends the sign in progress now, e.g. when the user asks for a translation mid-sign. */
  flush(): Frame[] | null {
    const last = this.seg?.[this.seg.length - 1];
    return last ? this.finish(last.t) : null;
  }

  private finish(cutoff: number): Frame[] | null {
    const frames = trimToHands((this.seg ?? []).filter((x) => x.t <= cutoff));
    const forced = this.forced;
    const peak = this.segPeak;
    this.seg = null;
    this.forced = false;
    this.stillSince = null;
    this.lostSince = null;
    if (frames.length === 0) return null;
    const o = this.opts;
    const duration = frames[frames.length - 1].t - frames[0].t;
    const handFrames = frames.filter((x) => x.hands.length > 0).length;
    // A hand that only rested in view is not a sign, unless we were explicitly recording.
    if (duration < o.minMs || handFrames < o.minHandFrames || (!forced && peak < o.startSpeed)) return null;
    return frames;
  }
}
