/**
 * One tracked hand in one video frame, reduced to what the recognizer needs.
 * Image-space values use isotropic units: x is scaled by the frame aspect ratio
 * (width / height) so that one unit is the same length horizontally and vertically.
 */
export type HandFrame = {
  /** MediaPipe handedness label (assumes a mirrored image, so it is flipped for raw webcam frames). */
  label: 'Left' | 'Right';
  /** Wrist position in the image (isotropic units, y down). */
  wx: number;
  wy: number;
  /** Palm length in the image (wrist to middle-finger knuckle), isotropic units. */
  s: number;
  /** 21 world landmarks (metres, hand-centred), flattened x,y,z. Encodes handshape and orientation. */
  world: number[];
};

/** Face box centre and width in isotropic image units; used as the signing-space anchor. */
export type FaceFrame = { cx: number; cy: number; w: number };

export type Frame = {
  /** Timestamp in milliseconds. */
  t: number;
  hands: HandFrame[];
  face: FaceFrame | null;
};

/** A recorded example of one phrase, stored as a time-resampled frame sequence. */
export type Sample = {
  phrase: number;
  frames: Frame[];
  createdAt: number;
};

export type Prediction = {
  index: number;
  confidence: number;
  /** Best DTW distance per phrase (Infinity for phrases with no samples). */
  distances: number[];
};
