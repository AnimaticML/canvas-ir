// Motion IR: what a camera sees of a person, turned into a body, its movements and, later, its actions, for any engine.
//
// The layers, each usable on its own:
// - landmarks.ts: what trackers report, by name (MediaPipe's body and hand points).
// - take.ts: takes, everything a tracker saw over a stretch of time, saved and loaded, to replay and compare.
// - setups.ts: camera setups, what each sees and what it leaves to be assumed.
// - skeleton.ts: the body's joints, bones, rest pose and proportions.
// - solve.ts: landmarks fitted to the skeleton at the person's own proportions, filtered, held through misses, placed
//   in front of the camera.
// - compare.ts: measures for judging a solve.
// - synthetic.ts: scripted takes with a known truth, for tests and demos.
export * from "./vec";
export * from "./landmarks";
export * from "./take";
export * from "./setups";
export * from "./skeleton";
export * from "./filter";
export * from "./solve";
export * from "./compare";
export * from "./synthetic";
