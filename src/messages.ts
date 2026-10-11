import type { Frame } from './recognition/types';

/**
 * Protocol between the content script and the camera frame (camera.html).
 * The content script posts `CONNECT` with a MessagePort to the frame; everything else
 * travels over that private port, so the Meet page never sees the camera data.
 */
export const CONNECT = 'asl-captions-connect';

export type CameraMessage =
  | { type: 'status'; tracking: 'loading' | 'ready' | 'error'; error?: string }
  | { type: 'camera'; ok: boolean; error?: string }
  | { type: 'frame'; frame: Frame };

export type ControlMessage = { type: 'recording'; on: boolean };
