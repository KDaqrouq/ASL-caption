import { describe, expect, it } from 'vitest';
import { Recognizer } from '../src/recognition/recognizer';
import { Segmenter } from '../src/recognition/segmenter';
import type { Frame, Sample } from '../src/recognition/types';
import { SIGNS, noHands, performSign, randomMotion, restingHands, rng } from './synth';

const N = SIGNS.length;

function trainingSet(perPhrase: number, seed: number): Sample[] {
  const r = rng(seed);
  const samples: Sample[] = [];
  for (let p = 0; p < N; p++) {
    for (let k = 0; k < perPhrase; k++) samples.push({ phrase: p, frames: performSign(p, r), createdAt: 0 });
  }
  return samples;
}

describe('Recognizer', () => {
  const model = new Recognizer(trainingSet(5, 1), N);

  it('recognises new takes of every phrase', () => {
    const r = rng(99);
    let correct = 0;
    let total = 0;
    for (let p = 0; p < N; p++) {
      for (let k = 0; k < 10; k++) {
        const pred = model.classify(performSign(p, r));
        total++;
        if (pred?.index === p) correct++;
      }
    }
    expect(correct / total).toBeGreaterThanOrEqual(0.95);
  });

  it('is confident on clear takes', () => {
    const r = rng(7);
    const confidences = Array.from({ length: N }, (_, p) => model.classify(performSign(p, r))!.confidence);
    const median = [...confidences].sort((a, b) => a - b)[N >> 1];
    expect(median).toBeGreaterThan(0.66);
  });

  it('copes with signing much faster or slower than the examples', () => {
    const r = rng(11);
    for (let p = 0; p < N; p++) {
      expect(model.classify(performSign(p, r, 0, { speed: 0.6 }))?.index).toBe(p);
      expect(model.classify(performSign(p, r, 0, { speed: 1.6 }))?.index).toBe(p);
    }
  });

  it('copes with MediaPipe labelling the hands the other way round', () => {
    const r = rng(12);
    for (const p of [4, 5, 6, 7, 8]) {
      expect(model.classify(performSign(p, r, 0, { label: 'Right' }))?.index).toBe(p);
    }
  });

  it('gives low confidence to movements that are not a taught sign', () => {
    const r = rng(5);
    const confidences = Array.from({ length: 20 }, () => model.classify(randomMotion(r))?.confidence ?? 0);
    const rejected = confidences.filter((c) => c < 0.66).length;
    expect(rejected).toBeGreaterThanOrEqual(16);
  });

  it('reports leave-one-out accuracy', () => {
    const ev = model.evaluate();
    expect(ev.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(ev.perPhrase.every((p) => p.total === 5)).toBe(true);
  });

  it('works with only some phrases taught', () => {
    const partial = new Recognizer(trainingSet(3, 2).filter((s) => s.phrase === 5 || s.phrase === 7), N);
    expect(partial.trainedPhrases).toEqual([5, 7]);
    expect(partial.classify(performSign(5, rng(3)))?.index).toBe(5);
    expect(new Recognizer([], N).classify(performSign(5, rng(3)))).toBeNull();
  });
});

describe('Segmenter', () => {
  function run(frames: Frame[], seg = new Segmenter()): Frame[][] {
    const out: Frame[][] = [];
    for (const f of frames) {
      const s = seg.push(f);
      if (s) out.push(s);
    }
    return out;
  }

  it('splits a stream into the signs it contains', () => {
    const r = rng(21);
    const stream: Frame[] = [];
    const add = (frames: Frame[]) => stream.push(...frames);
    const next = () => (stream.length ? stream[stream.length - 1].t + 1000 / 30 : 0);
    add(noHands(next(), 800));
    add(performSign(5, r, next()));
    add(noHands(next(), 800));
    add(performSign(2, r, next()));
    add(noHands(next(), 800));
    add(performSign(7, r, next()));
    add(restingHands(r, next(), 1500));

    const segments = run(stream);
    expect(segments).toHaveLength(3);
    const model = new Recognizer(trainingSet(5, 1), N);
    expect(segments.map((s) => model.classify(s)?.index)).toEqual([5, 2, 7]);
  });

  it('ignores hands resting in view', () => {
    expect(run([...noHands(0, 500), ...restingHands(rng(4), 533, 3000)])).toHaveLength(0);
  });

  it('records a sign on demand even if the hand starts still', () => {
    const r = rng(8);
    const seg = new Segmenter();
    const rest = restingHands(r, 0, 1000);
    run(rest, seg);
    seg.arm();
    const segments = run([...restingHands(r, 1033, 800), ...performSign(7, r, 1866), ...noHands(3000, 600)], seg);
    expect(segments).toHaveLength(1);
  });
});
