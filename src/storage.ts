import { resample, trimToHands } from './recognition/features';
import type { Frame, Sample } from './recognition/types';

const SAMPLES_KEY = 'asl_samples_v1';
const SETTINGS_KEY = 'asl_settings_v1';
/** Oldest examples are dropped beyond this, so corrections keep the model current. */
export const MAX_SAMPLES_PER_PHRASE = 20;
/** Stored resolution of each example; recognition resamples to fewer steps anyway. */
const STORED_FRAMES = 48;

export type Settings = { autoCaption: boolean };
const DEFAULT_SETTINGS: Settings = { autoCaption: false };

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Shrinks a captured sign for storage: trims, resamples and rounds the numbers. */
export function compactFrames(frames: Frame[]): Frame[] {
  const trimmed = trimToHands(frames);
  const t0 = trimmed[0]?.t ?? 0;
  return resample(trimmed, STORED_FRAMES).map((f) => ({
    t: Math.round(f.t - t0),
    hands: f.hands.map((h) => ({ label: h.label, wx: round(h.wx), wy: round(h.wy), s: round(h.s), world: h.world.map(round) })),
    face: f.face && { cx: round(f.face.cx), cy: round(f.face.cy), w: round(f.face.w) },
  }));
}

function isSample(x: unknown): x is Sample {
  const s = x as Sample;
  return !!s && Number.isInteger(s.phrase) && Array.isArray(s.frames) && s.frames.every((f) => Array.isArray(f?.hands));
}

export async function loadSamples(): Promise<Sample[]> {
  const got = await chrome.storage.local.get(SAMPLES_KEY);
  const list = got[SAMPLES_KEY];
  return Array.isArray(list) ? list.filter(isSample) : [];
}

export async function saveSamples(samples: Sample[]): Promise<void> {
  await chrome.storage.local.set({ [SAMPLES_KEY]: samples });
}

/** Adds an example, dropping the phrase's oldest ones beyond the cap. */
export function withSample(samples: Sample[], phrase: number, frames: Frame[]): Sample[] {
  const next = [...samples, { phrase, frames: compactFrames(frames), createdAt: Date.now() }];
  const mine = next.filter((s) => s.phrase === phrase);
  const drop = new Set(mine.slice(0, Math.max(0, mine.length - MAX_SAMPLES_PER_PHRASE)));
  return next.filter((s) => !drop.has(s));
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function exportJson(samples: Sample[]): string {
  return JSON.stringify({ format: 'asl-meet-captions-samples', version: 1, samples });
}

export function importJson(text: string): Sample[] {
  const data = JSON.parse(text) as { samples?: unknown };
  const list = Array.isArray(data) ? data : data.samples;
  if (!Array.isArray(list)) throw new Error('No samples in file');
  return list.filter(isSample);
}
