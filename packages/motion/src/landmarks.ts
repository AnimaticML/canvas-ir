// What a tracker reports, by name: MediaPipe's 33 body landmarks and 21 hand landmarks, and the lines drawn between them.
// Other trackers map their points onto these names.

/** One tracked point. In the image: x and y from 0 to 1 across and down it, z a relative depth. In the world: meters. */
export interface Landmark {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** How likely the point is in view and not hidden, 0 to 1, where the tracker says. */
  readonly visibility?: number;
}

export const POSE = [
  "nose", "leftEyeInner", "leftEye", "leftEyeOuter", "rightEyeInner", "rightEye", "rightEyeOuter", "leftEar", "rightEar",
  "mouthLeft", "mouthRight", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist",
  "leftPinky", "rightPinky", "leftIndex", "rightIndex", "leftThumb", "rightThumb", "leftHip", "rightHip", "leftKnee",
  "rightKnee", "leftAnkle", "rightAnkle", "leftHeel", "rightHeel", "leftFootIndex", "rightFootIndex",
] as const;
export type PoseName = (typeof POSE)[number];
export const P = Object.fromEntries(POSE.map((n, i) => [n, i])) as Record<PoseName, number>;

export const HAND = [
  "wrist", "thumbCmc", "thumbMcp", "thumbIp", "thumbTip", "indexMcp", "indexPip", "indexDip", "indexTip", "middleMcp",
  "middlePip", "middleDip", "middleTip", "ringMcp", "ringPip", "ringDip", "ringTip", "pinkyMcp", "pinkyPip", "pinkyDip", "pinkyTip",
] as const;
export type HandName = (typeof HAND)[number];
export const H = Object.fromEntries(HAND.map((n, i) => [n, i])) as Record<HandName, number>;

/** The lines of the body's stick figure, by landmark index. */
export const POSE_LINES: readonly (readonly [number, number])[] = [
  [P.leftShoulder, P.rightShoulder], [P.leftShoulder, P.leftElbow], [P.leftElbow, P.leftWrist], [P.rightShoulder, P.rightElbow],
  [P.rightElbow, P.rightWrist], [P.leftShoulder, P.leftHip], [P.rightShoulder, P.rightHip], [P.leftHip, P.rightHip],
  [P.leftHip, P.leftKnee], [P.leftKnee, P.leftAnkle], [P.leftAnkle, P.leftHeel], [P.leftHeel, P.leftFootIndex], [P.leftAnkle, P.leftFootIndex],
  [P.rightHip, P.rightKnee], [P.rightKnee, P.rightAnkle], [P.rightAnkle, P.rightHeel], [P.rightHeel, P.rightFootIndex], [P.rightAnkle, P.rightFootIndex],
  [P.leftWrist, P.leftIndex], [P.leftWrist, P.leftPinky], [P.leftWrist, P.leftThumb], [P.rightWrist, P.rightIndex], [P.rightWrist, P.rightPinky], [P.rightWrist, P.rightThumb],
  [P.leftEar, P.leftEye], [P.leftEye, P.nose], [P.nose, P.rightEye], [P.rightEye, P.rightEar], [P.mouthLeft, P.mouthRight],
];

/** The lines of a hand, by landmark index. */
export const HAND_LINES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** The fingers, each from its base joint to its tip, by landmark index. */
export const FINGERS = {
  thumb: [H.thumbCmc, H.thumbMcp, H.thumbIp, H.thumbTip],
  index: [H.indexMcp, H.indexPip, H.indexDip, H.indexTip],
  middle: [H.middleMcp, H.middlePip, H.middleDip, H.middleTip],
  ring: [H.ringMcp, H.ringPip, H.ringDip, H.ringTip],
  pinky: [H.pinkyMcp, H.pinkyPip, H.pinkyDip, H.pinkyTip],
} as const;
export type Finger = keyof typeof FINGERS;
