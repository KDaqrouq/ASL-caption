import { describe, expect, it } from 'vitest';
import { DEFAULT_PHRASES, MAX_PHRASES, cleanPhraseText } from '../src/phrases';
import {
  MAX_SAMPLES_PER_PHRASE,
  exportJson,
  importJson,
  mergeImport,
  migrateLegacySamples,
  withSample,
  type StoredSample,
} from '../src/storage';
import { performSign, rng } from './synth';

const r = rng(1);
const take = (p = 5) => performSign(p, r);

describe('phrases', () => {
  it('cleans typed phrase text', () => {
    expect(cleanPhraseText('  Hello   everyone ')).toBe('Hello everyone');
    expect(cleanPhraseText('ASL Speaker: Hi')).toBe('Hi');
    expect(cleanPhraseText('   ')).toBeNull();
    expect(cleanPhraseText('x'.repeat(200))).toHaveLength(80);
  });
});

describe('storage', () => {
  it('migrates examples saved before custom phrases existed', () => {
    const legacy = [
      { phrase: 0, frames: take(), createdAt: 1 },
      { phrase: 8, frames: take(), createdAt: 2 },
      { phrase: 'bad', frames: [] },
    ];
    const migrated = migrateLegacySamples(legacy);
    expect(migrated.map((s) => s.phraseId)).toEqual(['p1', 'p9']);
    expect(DEFAULT_PHRASES.map((p) => p.id)).toContain('p9');
  });

  it('caps examples per phrase, dropping the oldest', () => {
    let samples: StoredSample[] = [];
    for (let i = 0; i < MAX_SAMPLES_PER_PHRASE + 3; i++) samples = withSample(samples, 'p1', take());
    samples = withSample(samples, 'p2', take());
    expect(samples.filter((s) => s.phraseId === 'p1')).toHaveLength(MAX_SAMPLES_PER_PHRASE);
    expect(samples.filter((s) => s.phraseId === 'p2')).toHaveLength(1);
  });

  it('round-trips phrases and examples through export and import', () => {
    const phrases = [...DEFAULT_PHRASES, { id: 'c1', text: 'Hello everyone' }];
    const samples = withSample(withSample([], 'c1', take(2)), 'p6', take(5));
    const imported = importJson(exportJson({ phrases, samples }));
    expect(imported.phrases.map((p) => p.id)).toEqual(phrases.map((p) => p.id));
    expect(imported.samples.map((s) => s.phraseId)).toEqual(['c1', 'p6']);
  });

  it('reads export files from before custom phrases existed', () => {
    const old = JSON.stringify({ format: 'asl-meet-captions-samples', version: 1, samples: [{ phrase: 5, frames: take() }] });
    const imported = importJson(old);
    expect(imported.samples.map((s) => s.phraseId)).toEqual(['p6']);
  });

  it('merges imports: adds missing phrases, keeps existing ones, skips unknown examples', () => {
    const current = { phrases: [{ id: 'p6', text: 'Thanks!' }], samples: [] };
    const imported = {
      phrases: [{ id: 'p6', text: 'Thank you.' }, { id: 'c1', text: 'Hello everyone' }],
      samples: [
        { phraseId: 'c1', frames: take(), createdAt: 0 },
        { phraseId: 'gone', frames: take(), createdAt: 0 },
      ],
    };
    const merged = mergeImport(current, imported);
    expect(merged.phrases).toEqual([{ id: 'p6', text: 'Thanks!' }, { id: 'c1', text: 'Hello everyone' }]);
    expect(merged.added).toBe(1);
    expect(merged.samples.map((s) => s.phraseId)).toEqual(['c1']);
  });

  it('never grows the phrase list past the limit', () => {
    const many = Array.from({ length: MAX_PHRASES }, (_, i) => ({ id: `c${i}`, text: `Phrase ${i}` }));
    const merged = mergeImport({ phrases: many, samples: [] }, { phrases: [{ id: 'extra', text: 'Extra' }], samples: [] });
    expect(merged.phrases).toHaveLength(MAX_PHRASES);
  });
});
