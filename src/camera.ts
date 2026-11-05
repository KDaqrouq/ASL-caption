import { HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CONNECT, type CameraMessage, type ControlMessage } from './messages';
import { Vision } from './vision';

/**
 * Camera frame, embedded by the content script inside the overlay panel.
 *
 * Running the webcam and MediaPipe here instead of in the content script matters:
 * a content script shares the Meet page's CSP (which can forbid compiling WASM) and
 * MediaPipe's loader injects a <script> tag that would run in the page's world. This
 * extension page has its own CSP, loads MediaPipe normally, and runs in a separate
 * process, so hand tracking does not compete with Meet's main thread.
 */

const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('skeleton') as HTMLCanvasElement;
const vision = new Vision();

let port: MessagePort | null = null;
let recording = false;
/** Latest status of each kind, replayed when the content script connects. */
const latest = new Map<string, CameraMessage>();

function send(msg: CameraMessage): void {
  if (msg.type !== 'frame') latest.set(msg.type, msg);
  port?.postMessage(msg);
}

window.addEventListener('message', (e) => {
  if (port || e.source !== window.parent || e.data !== CONNECT || !e.ports[0]) return;
  port = e.ports[0];
  port.onmessage = (m: MessageEvent<ControlMessage>) => {
    if (m.data?.type === 'recording') recording = m.data.on;
  };
  latest.forEach((msg) => port?.postMessage(msg));
});

function drawSkeleton(hands: NormalizedLandmark[][]): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = Math.max(2, w / 200);
  ctx.strokeStyle = recording ? '#f28b82' : '#8ab4f8';
  ctx.fillStyle = '#ffffff';
  for (const lm of hands) {
    ctx.beginPath();
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      ctx.moveTo(lm[start].x * w, lm[start].y * h);
      ctx.lineTo(lm[end].x * w, lm[end].y * h);
    }
    ctx.stroke();
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, ctx.lineWidth, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

function startLoop(): void {
  const tick = () => {
    try {
      const obs = vision.detect(video);
      if (obs) {
        drawSkeleton(obs.landmarks);
        send({ type: 'frame', frame: obs.frame });
      }
    } catch (e) {
      console.warn('[ASL captions] Frame skipped:', e);
    }
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
}

async function main(): Promise<void> {
  send({ type: 'status', tracking: 'loading' });
  const visionReady = vision.init();

  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    await video.play();
    send({ type: 'camera', ok: true });
  } catch (e) {
    send({ type: 'camera', ok: false, error: e instanceof Error ? e.message : String(e) });
  }

  await visionReady;
  if (vision.initError) {
    console.error('[ASL captions] Hand tracking failed to start:', vision.initError);
    send({ type: 'status', tracking: 'error', error: vision.initError });
    return;
  }
  send({ type: 'status', tracking: 'ready' });
  startLoop();
}

void main();
