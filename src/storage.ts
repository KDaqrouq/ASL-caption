import { DEFAULT_PHRASES, MAX_PHRASES, legacyPhraseId, type Phrase } from './phrases';
import { resample, trimToHands } from './recognition/features';
import type { Frame } from './recognition/types';

/** A recorded example as stored: tied to a phrase by id, not by position in the list. */
export type StoredSample = { phraseId: string; frames: Frame[]; createdAt: number };

const SAMPLES_KEY = 'asl_samples_v2';
/** v1 stored the phrase as an index into the fixed nine-phrase list. */
const LEGACY_SAMPLES_KEY = 'asl_samples_v1';
const PHRASES_KEY = 'asl_phrases_v1';
const SETTINGS_KEY = 'asl_settings_v1';
/** Oldest examples are dropped beyond this, so corrections keep the model current. */
export const MAX_SAMPLES_PER_PHRASE = 20;
/** Stored resolution of each example; recognition resamples to fewer steps anyway. */
const STORED_FRAMES = 48;

export type Settings = {
  autoCaption: boolean;
  /** Draw captions into the camera video sent to the other participants. */
  captionVideo: boolean;
  /** Panel position (top-left corner, px) once the signer has dragged it. */
  panel: { x: number; y: number } | null;
  collapsed: boolean;
};
const DEFAULT_SETTINGS: Settings = { autoCaption: false, captionVideo: true, panel: null, collapsed: false };

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

const validFrames = (frames: unknown): frames is Frame[] =>
  Array.isArray(frames) && frames.every((f) => Array.isArray((f as Frame)?.hands));

function isStoredSample(x: unknown): x is StoredSample {
  const s = x as StoredSample;
  return !!s && typeof s.phraseId === 'string' && validFrames(s.frames);
}

function isPhrase(x: unknown): x is Phrase {
  const p = x as Phrase;
  return !!p && typeof p.id === 'string' && typeof p.text === 'string' && p.text.length > 0;
}

/** Converts v1 examples (phrase = index into the original nine) to phrase ids. */
export function migrateLegacySamples(list: unknown[]): StoredSample[] {
  return list
    .filter((s): s is { phrase: number; frames: Frame[]; createdAt?: number } => {
      const x = s as { phrase: unknown; frames: unknown };
      return !!x && Number.isInteger(x.phrase) && (x.phrase as number) >= 0 && validFrames(x.frames);
    })
    .map((s) => ({ phraseId: legacyPhraseId(s.phrase), frames: s.frames, createdAt: s.createdAt ?? 0 }));
}

export async function loadSamples(): Promise<StoredSample[]> {
  const got = await chrome.storage.local.get([SAMPLES_KEY, LEGACY_SAMPLES_KEY]);
  if (Array.isArray(got[SAMPLES_KEY])) return got[SAMPLES_KEY].filter(isStoredSample);
  if (!Array.isArray(got[LEGACY_SAMPLES_KEY])) return [];
  const migrated = migrateLegacySamples(got[LEGACY_SAMPLES_KEY]);
  await saveSamples(migrated);
  await chrome.storage.local.remove(LEGACY_SAMPLES_KEY);
  return migrated;
}

export async function saveSamples(samples: StoredSample[]): Promise<void> {
  await chrome.storage.local.set({ [SAMPLES_KEY]: samples });
}

export async function loadPhrases(): Promise<Phrase[]> {
  const got = await chrome.storage.local.get(PHRASES_KEY);
  const list = got[PHRASES_KEY];
  return Array.isArray(list) ? list.filter(isPhrase) : DEFAULT_PHRASES.map((p) => ({ ...p }));
}

export async function savePhrases(phrases: Phrase[]): Promise<void> {
  await chrome.storage.local.set({ [PHRASES_KEY]: phrases });
}

/** Adds an example, dropping the phrase's oldest ones beyond the cap. */
export function withSample(samples: StoredSample[], phraseId: string, frames: Frame[]): StoredSample[] {
  const next = [...samples, { phraseId, frames: compactFrames(frames), createdAt: Date.now() }];
  const mine = next.filter((s) => s.phraseId === phraseId);
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

export type ExportData = { phrases: Phrase[]; samples: StoredSample[] };

export function exportJson(data: ExportData): string {
  return JSON.stringify({ format: 'asl-meet-captions-samples', version: 2, ...data });
}

/** Reads an export file; files from before custom phrases refer to the original nine. */
export function importJson(text: string): ExportData {
  const data = JSON.parse(text) as { version?: number; phrases?: unknown; samples?: unknown };
  const list = Array.isArray(data) ? data : data.samples;
  if (!Array.isArray(list)) throw new Error('No examples in file');
  if (!Array.isArray(data) && data.version === 2) {
    return {
      phrases: Array.isArray(data.phrases) ? data.phrases.filter(isPhrase) : [],
      samples: list.filter(isStoredSample),
    };
  }
  return { phrases: DEFAULT_PHRASES.map((p) => ({ ...p })), samples: migrateLegacySamples(list) };
}

/** Merges imported phrases (by id) and examples into the current ones. */
export function mergeImport(current: ExportData, imported: ExportData): ExportData & { added: number } {
  const phrases = [...current.phrases];
  for (const p of imported.phrases) {
    if (phrases.length < MAX_PHRASES && !phrases.some((q) => q.id === p.id)) phrases.push(p);
  }
  const known = new Set(phrases.map((p) => p.id));
  let samples = current.samples;
  let added = 0;
  for (const s of imported.samples) {
    if (!known.has(s.phraseId)) continue;
    samples = withSample(samples, s.phraseId, s.frames);
    added++;
  }
  return { phrases, samples, added };
}
