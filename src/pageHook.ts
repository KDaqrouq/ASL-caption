import { OUTGOING_EVENT, type OutgoingMessage } from './messages';

/**
 * Burns captions into the camera video that Meet sends to the other participants.
 *
 * Runs in the Meet page's own JavaScript world (manifest `"world": "MAIN"`, at
 * document_start) because only there can it see Meet's WebRTC objects. It wraps the
 * points where a camera track is handed to a peer connection (addTrack, addTransceiver,
 * replaceTrack) and substitutes a copy of the track with the current caption drawn on
 * each frame. Hooking the send path rather than getUserMedia means Meet's self-view and
 * its background effects see the untouched camera, and only the outgoing video changes.
 *
 * The content script sends captions as JSON strings on a window event (strings cross
 * between the extension's isolated world and the page's world; objects do not).
 */

const SHOW_MS = 4000;
const FADE_MS = 500;

type Caption = { text: string; start: number };

let enabled = true;
let current: Caption | null = null;

window.addEventListener(OUTGOING_EVENT, (e) => {
  const detail = (e as CustomEvent).detail;
  if (typeof detail !== 'string') return;
  let msg: OutgoingMessage;
  try {
    msg = JSON.parse(detail) as OutgoingMessage;
  } catch {
    return;
  }
  if (msg.type === 'caption' && typeof msg.text === 'string') {
    current = { text: msg.text.slice(0, 200), start: performance.now() };
  } else if (msg.type === 'enabled') {
    enabled = !!msg.on;
    if (!enabled) current = null;
  }
});

/** Caption opacity right now: full while shown, then a short fade. */
function captionAlpha(now: number): number {
  if (!current || !enabled) return 0;
  const age = now - current.start;
  if (age < SHOW_MS) return 1;
  if (age < SHOW_MS + FADE_MS) return 1 - (age - SHOW_MS) / FADE_MS;
  current = null;
  return 0;
}

function wrapLines(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function drawCaption(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, text: string, alpha: number): void {
  const size = Math.max(14, Math.round(h / 15));
  ctx.font = `600 ${size}px system-ui, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, text, w * 0.86);
  const lineH = size * 1.3;
  const padX = size * 0.7;
  const padY = size * 0.45;
  const boxW = Math.min(w * 0.94, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 2 * padX);
  const boxH = lines.length * lineH + 2 * padY;
  const x = (w - boxW) / 2;
  const y = h - boxH - h * 0.05;

  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, size * 0.4);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  lines.forEach((l, i) => ctx.fillText(l, w / 2, y + padY + lineH * (i + 0.5)));
  ctx.globalAlpha = 1;
}

type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
type TrackGeneratorCtor = new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
const Processor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
const Generator = (globalThis as { MediaStreamTrackGenerator?: TrackGeneratorCtor }).MediaStreamTrackGenerator;

/** Original camera track -> captioned copy, and back. */
const captioned = new WeakMap<MediaStreamTrack, MediaStreamTrack>();
const originals = new WeakMap<MediaStreamTrack, MediaStreamTrack>();

function isCamera(track: MediaStreamTrack): boolean {
  // Screen shares report a displaySurface; leave them alone.
  return track.kind === 'video' && !('displaySurface' in track.getSettings());
}

function captionTrack(source: MediaStreamTrack): MediaStreamTrack {
  const existing = captioned.get(source);
  if (existing && existing.readyState === 'live') return existing;

  const generator = new Generator!({ kind: 'video' });
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;

  const transform = new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, controller) {
      const alpha = captionAlpha(performance.now());
      if (alpha <= 0 || !current) {
        controller.enqueue(frame);
        return;
      }
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext('2d');
      }
      if (!ctx) {
        controller.enqueue(frame);
        return;
      }
      ctx.drawImage(frame, 0, 0, w, h);
      drawCaption(ctx, w, h, current.text, alpha);
      const out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
      frame.close();
      controller.enqueue(out);
    },
  });
  new Processor!({ track: source }).readable
    .pipeThrough(transform)
    .pipeTo(generator.writable)
    .catch(() => {
      /* track ended */
    });

  // Keep the copy behaving like the camera track for anything Meet asks of it.
  const stopCopy = generator.stop.bind(generator);
  Object.defineProperty(generator, 'label', { get: () => source.label });
  generator.getSettings = () => source.getSettings();
  generator.getCapabilities = () => source.getCapabilities();
  generator.getConstraints = () => source.getConstraints();
  generator.applyConstraints = (c?: MediaTrackConstraints) => source.applyConstraints(c);
  generator.stop = () => {
    stopCopy();
    captioned.delete(source);
  };
  source.addEventListener('ended', () => stopCopy());

  captioned.set(source, generator);
  originals.set(generator, source);
  return generator;
}

function substitute(track: MediaStreamTrack | null | undefined): MediaStreamTrack | null | undefined {
  if (!track || !isCamera(track) || originals.has(track)) return track;
  try {
    return captionTrack(track);
  } catch (e) {
    console.warn('[ASL captions] Could not add captions to the outgoing video:', e);
    return track;
  }
}

function install(): void {
  if (!Processor || !Generator || typeof RTCPeerConnection === 'undefined') return;

  const pc = RTCPeerConnection.prototype;
  const addTrack = pc.addTrack;
  pc.addTrack = function (this: RTCPeerConnection, track: MediaStreamTrack, ...streams: MediaStream[]) {
    return addTrack.call(this, substitute(track) ?? track, ...streams);
  };
  const addTransceiver = pc.addTransceiver;
  pc.addTransceiver = function (this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
    const arg = typeof trackOrKind === 'string' ? trackOrKind : (substitute(trackOrKind) ?? trackOrKind);
    return addTransceiver.call(this, arg, init);
  };

  const sender = RTCRtpSender.prototype;
  const replaceTrack = sender.replaceTrack;
  sender.replaceTrack = function (this: RTCRtpSender, track: MediaStreamTrack | null) {
    return replaceTrack.call(this, substitute(track) ?? null);
  };
  // Meet reads sender.track back; give it the camera track it handed over.
  const trackGetter = Object.getOwnPropertyDescriptor(sender, 'track')?.get;
  if (trackGetter) {
    Object.defineProperty(sender, 'track', {
      configurable: true,
      enumerable: true,
      get(this: RTCRtpSender) {
        const t = trackGetter.call(this) as MediaStreamTrack | null;
        return (t && originals.get(t)) ?? t;
      },
    });
  }
}

install();
