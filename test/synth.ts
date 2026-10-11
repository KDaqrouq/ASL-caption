/**
 * Synthetic signer for tests: a kinematic hand model driven by simple per-sign scripts
 * (handshape, palm orientation and wrist path relative to the face), with per-take
 * variation in speed, distance to camera, placement and landmark jitter.
 * The scripts are loose approximations of the nine phrases, not linguistic references.
 */
import type { Frame, HandFrame } from '../src/recognition/types';

export type Rng = () => number;

export function rng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: Rng): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Curl per finger (thumb, index, middle, ring, pinky): 0 = straight, 1 = fist. */
type Curl = [number, number, number, number, number];
type HandPose = { curl: Curl; pitch: number; yaw: number; roll: number; x: number; y: number };
type SignScript = { duration: number; dominant: (u: number) => HandPose; other?: (u: number) => HandPose };

const FLAT: Curl = [0, 0, 0, 0, 0];
const FIST: Curl = [1, 1, 1, 1, 1];
const A_HAND: Curl = [0, 1, 1, 1, 1];
const BENT: Curl = [0.2, 0.5, 0.5, 0.5, 0.5];
const MIDDLE: Curl = [0.1, 0, 0.6, 0, 0];
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerpCurl = (a: Curl, b: Curl, u: number) => a.map((v, i) => lerp(v, b[i], u)) as Curl;
const pose = (curl: Curl, x: number, y: number, pitch = 0, yaw = 0, roll = 0): HandPose => ({ curl, x, y, pitch, yaw, roll });

/** Positions are in face widths relative to the face centre (x right in the image, y down). */
export const SIGNS: SignScript[] = [
  // P1 "again": bent hand arcs over and lands in the other palm.
  {
    duration: 900,
    dominant: (u) => pose(BENT, lerp(-1.2, -0.2, u), 2.2 - Math.sin(Math.PI * u) * 0.8, lerp(0, 2.2, u)),
    other: () => pose(FLAT, 0.3, 2.6, 1.5, 0, 1.5),
  },
  // P2 "technical": middle finger taps the side of the other hand twice.
  {
    duration: 1000,
    dominant: (u) => pose(MIDDLE, -0.3, 2.2 - 0.25 * Math.abs(Math.sin(2 * Math.PI * u)), 1.2),
    other: () => pose(FLAT, 0.2, 2.5, 0, 0, 1.5),
  },
  // P3 "break": two fists together, twist and pull apart.
  {
    duration: 800,
    dominant: (u) => pose(FIST, lerp(-0.3, -1.0, u), 2.2, 0, 0, lerp(0, -1.2, u)),
    other: (u) => pose(FIST, lerp(0.3, 1.0, u), 2.2, 0, 0, lerp(0, 1.2, u)),
  },
  // P4 "slow": flat hand slides slowly up the back of the other hand.
  {
    duration: 1400,
    dominant: (u) => pose(FLAT, lerp(0.2, -0.4, u), lerp(2.6, 2.3, u), 1.4),
    other: () => pose(FLAT, 0.0, 2.6, 1.4, 0, 0.3),
  },
  // P5 "goodbye": open hand by the shoulder, fingers fold up and down.
  {
    duration: 1100,
    dominant: (u) => {
      const c = 0.5 - 0.5 * Math.cos(4 * Math.PI * u);
      return pose([0.1, c, c, c, c], -1.4, 0.6, 0);
    },
  },
  // P6 "thank you": flat hand from the chin forward and down.
  { duration: 800, dominant: (u) => pose(FLAT, lerp(-0.1, -0.6, u), lerp(0.7, 1.8, u), lerp(-0.3, 0.9, u)) },
  // P7 "bless you": A-hand at the mouth drops and opens.
  {
    duration: 1000,
    dominant: (u) => pose(lerpCurl(A_HAND, FLAT, Math.min(1, u * 1.4)), lerp(-0.1, -0.5, u), lerp(0.4, 2.0, u), 0.4, 0.4),
  },
  // P8 "yes": fist nodding at the wrist.
  { duration: 900, dominant: (u) => pose(FIST, -0.7, 2.0, 0.8 * Math.abs(Math.sin(2 * Math.PI * u))) },
  // P9 "no": index and middle snap onto the thumb twice.
  {
    duration: 800,
    dominant: (u) => {
      const c = Math.abs(Math.sin(2 * Math.PI * u));
      return pose([0.3, 0.15 + 0.55 * c, 0.15 + 0.55 * c, 1, 1], -0.9, 1.0, 0, 0, -0.4);
    },
  },
];

const FINGER_BASES: [number, number, number][] = [
  [0.035, -0.02, 0.0],
  [0.025, -0.09, 0.0],
  [0.0, -0.095, 0.0],
  [-0.022, -0.088, 0.0],
  [-0.04, -0.078, 0.0],
];
const SEGMENTS = [
  [0.035, 0.032, 0.028],
  [0.04, 0.025, 0.022],
  [0.044, 0.028, 0.024],
  [0.04, 0.026, 0.022],
  [0.032, 0.02, 0.018],
];

function rotate(p: [number, number, number], pitch: number, yaw: number, roll: number): [number, number, number] {
  let [x, y, z] = p;
  [y, z] = [y * Math.cos(pitch) - z * Math.sin(pitch), y * Math.sin(pitch) + z * Math.cos(pitch)];
  [x, z] = [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
  [x, y] = [x * Math.cos(roll) - y * Math.sin(roll), x * Math.sin(roll) + y * Math.cos(roll)];
  return [x, y, z];
}

/** 21 world landmarks (metres) for a handshape and orientation. */
export function handWorld(curl: Curl, pitch: number, yaw: number, roll: number): number[] {
  const pts: [number, number, number][] = [[0, 0, 0]];
  FINGER_BASES.forEach((base, f) => {
    let [x, y, z] = base;
    let angle = 0;
    const dirX = f === 0 ? 0.7 : 0;
    pts.push([x, y, z]);
    for (let s = 0; s < 3; s++) {
      angle += curl[f] * (f === 0 ? 0.6 : 1.3);
      const len = SEGMENTS[f][s];
      x += len * dirX * Math.cos(angle);
      y += -len * Math.cos(angle) * (f === 0 ? 0.7 : 1);
      z += -len * Math.sin(angle);
      pts.push([x, y, z]);
    }
  });
  // pts: wrist + 5 fingers x 4 joints = 21.
  return pts.flatMap((p) => rotate(p, pitch, yaw, roll));
}

export type TakeOptions = { speed?: number; noise?: number; label?: HandFrame['label'] };

/** One performance of a sign, as the frames the vision pipeline would produce. */
export function performSign(sign: number, r: Rng, startT = 0, opts: TakeOptions = {}): Frame[] {
  const script = SIGNS[sign];
  const speed = opts.speed ?? 0.8 + 0.45 * r();
  const noise = opts.noise ?? 1;
  const duration = script.duration / speed;
  const faceW = 0.17 + 0.06 * r();
  const face = { cx: 0.6 + 0.25 * r(), cy: 0.3 + 0.1 * r(), w: faceW };
  const palmImage = 0.55 * faceW;
  const placement = { x: 0.15 * gauss(r), y: 0.15 * gauss(r) };
  const label = opts.label ?? 'Left';
  const frames: Frame[] = [];
  for (let t = 0; t <= duration; t += 1000 / 30) {
    const u = Math.min(1, t / duration);
    const hands: HandFrame[] = [];
    const add = (p: HandPose, lab: HandFrame['label']) => {
      const world = handWorld(p.curl, p.pitch, p.yaw, p.roll).map((v) => v + 0.002 * noise * gauss(r));
      hands.push({
        label: lab,
        wx: face.cx + (p.x + placement.x + 0.03 * noise * gauss(r)) * faceW,
        wy: face.cy + (p.y + placement.y + 0.03 * noise * gauss(r)) * faceW,
        s: palmImage,
        world,
      });
    };
    add(script.dominant(u), label);
    if (script.other) add(script.other(u), label === 'Left' ? 'Right' : 'Left');
    frames.push({ t: startT + t, hands, face: { ...face } });
  }
  return frames;
}

/** Hands visible but resting (small jitter only). */
export function restingHands(r: Rng, startT: number, ms: number): Frame[] {
  const frames: Frame[] = [];
  const world = handWorld(FLAT, 1.4, 0, 0);
  for (let t = 0; t <= ms; t += 1000 / 30) {
    frames.push({
      t: startT + t,
      hands: [{ label: 'Left', wx: 0.7 + 0.002 * gauss(r), wy: 0.9 + 0.002 * gauss(r), s: 0.1, world: world.map((v) => v + 0.001 * gauss(r)) }],
      face: { cx: 0.7, cy: 0.35, w: 0.18 },
    });
  }
  return frames;
}

export function noHands(startT: number, ms: number): Frame[] {
  const frames: Frame[] = [];
  for (let t = 0; t <= ms; t += 1000 / 30) frames.push({ t: startT + t, hands: [], face: { cx: 0.7, cy: 0.35, w: 0.18 } });
  return frames;
}

/** Random flailing that matches none of the scripted signs. */
export function randomMotion(r: Rng, startT = 0): Frame[] {
  const frames: Frame[] = [];
  const c1: Curl = [r(), r(), r(), r(), r()];
  const c2: Curl = [r(), r(), r(), r(), r()];
  const x0 = 3 * r() - 1.5;
  const y0 = 3 * r();
  const ax = 2 * r() - 1;
  const ay = 2 * r() - 1;
  const rot = 3 * r();
  for (let t = 0; t <= 1000; t += 1000 / 30) {
    const u = t / 1000;
    const world = handWorld(lerpCurl(c1, c2, u), rot * u, rot * (1 - u), -rot * u);
    frames.push({
      t: startT + t,
      hands: [{ label: 'Left', wx: 0.7 + (x0 + ax * u) * 0.18, wy: 0.35 + (y0 + ay * Math.sin(3 * u)) * 0.18, s: 0.1, world }],
      face: { cx: 0.7, cy: 0.35, w: 0.18 },
    });
  }
  return frames;
}
