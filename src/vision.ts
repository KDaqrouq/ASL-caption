import { FaceDetector, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { FaceFrame, Frame, HandFrame } from './recognition/types';

type Fileset = Parameters<typeof HandLandmarker.createFromOptions>[0];

/** Raw landmarks of the latest frame, for drawing the skeleton preview. */
export type Observation = { frame: Frame; landmarks: NormalizedLandmark[][] };

/** Run face detection on every Nth frame; the face barely moves while signing. */
const FACE_EVERY = 3;

/**
 * MediaPipe hand landmarks (two hands) plus a face detector for the signing-space anchor.
 * Runs in the extension's camera frame (camera.html), never in the Meet page itself.
 */
export class Vision {
  private hands: HandLandmarker | null = null;
  private face: FaceDetector | null = null;
  private lastTs = 0;
  private frameCount = 0;
  private lastFace: FaceFrame | null = null;
  initError: string | null = null;

  get ready(): boolean {
    return this.hands !== null;
  }

  async init(): Promise<void> {
    const fileset: Fileset = {
      wasmLoaderPath: chrome.runtime.getURL('wasm/vision_wasm_internal.js'),
      wasmBinaryPath: chrome.runtime.getURL('wasm/vision_wasm_internal.wasm'),
    };
    try {
      this.hands = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: chrome.runtime.getURL('wasm/hand_landmarker.task'), delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch (e) {
      this.initError = e instanceof Error ? e.message : String(e);
      return;
    }
    try {
      this.face = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: chrome.runtime.getURL('wasm/blaze_face_short_range.tflite'), delegate: 'CPU' },
        runningMode: 'VIDEO',
      });
    } catch (e) {
      // Recognition still works without the face anchor, just less robust to sitting position.
      console.warn('[ASL captions] Face detector unavailable:', e);
    }
  }

  detect(video: HTMLVideoElement): Observation | null {
    if (!this.hands || video.readyState < 2 || video.videoWidth === 0) return null;
    const ts = Math.max(Math.round(performance.now()), this.lastTs + 1);
    this.lastTs = ts;
    const aspect = video.videoWidth / video.videoHeight;

    const result = this.hands.detectForVideo(video, ts);
    const hands: HandFrame[] = [];
    result.landmarks.forEach((lm, i) => {
      const world = result.worldLandmarks[i];
      if (lm.length !== 21 || world?.length !== 21) return;
      hands.push({
        label: result.handedness[i]?.[0]?.categoryName === 'Right' ? 'Right' : 'Left',
        wx: lm[0].x * aspect,
        wy: lm[0].y,
        s: Math.hypot((lm[9].x - lm[0].x) * aspect, lm[9].y - lm[0].y),
        world: world.flatMap((p) => [p.x, p.y, p.z]),
      });
    });

    if (this.face && this.frameCount++ % FACE_EVERY === 0) {
      const box = this.face.detectForVideo(video, ts).detections[0]?.boundingBox;
      this.lastFace = box
        ? {
            cx: ((box.originX + box.width / 2) / video.videoWidth) * aspect,
            cy: (box.originY + box.height / 2) / video.videoHeight,
            w: (box.width / video.videoWidth) * aspect,
          }
        : null;
    }

    return { frame: { t: ts, hands, face: this.lastFace }, landmarks: result.landmarks };
  }

  close(): void {
    this.hands?.close();
    this.face?.close();
    this.hands = null;
    this.face = null;
  }
}
