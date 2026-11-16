// Camera setups. Where the camera is and what it sees changes what can be known and what has to be assumed: a webcam on
// a desk sees a seated person from the chest up, a phone propped on a shelf sees all of someone standing, a selfie
// camera moves with the hand holding it, and a phone's rear camera looks at someone else, a hand or a table. A setup
// says what to expect, so the solver knows what a missing part most likely is doing and what the ground is.

export type SetupId = "desk" | "phone-stand" | "selfie" | "rear-person" | "rear-hand" | "rear-table";

export interface Setup {
  readonly id: SetupId;
  readonly label: string;
  /** Which way the camera faces. */
  readonly facing: "user" | "environment";
  /** Whether the camera itself moves while tracking. */
  readonly cameraMoves: boolean;
  /** What is usually in view. */
  readonly sees: "face" | "upper-body" | "full-body" | "hand";
  /** How the person is most likely placed when their legs aren't seen. */
  readonly stance: "seated" | "standing";
  /** What the body rests on or touches: the floor under the feet, a table under the hands, or nothing to go by. */
  readonly ground: "floor" | "table" | "none";
  /** The field of view across the image, in degrees, when nothing better is known. */
  readonly fov: number;
  /** How far from the camera the person usually is, in meters. */
  readonly distance: number;
}

export const SETUPS: Record<SetupId, Setup> = {
  desk: { id: "desk", label: "Desktop webcam", facing: "user", cameraMoves: false, sees: "upper-body", stance: "seated", ground: "none", fov: 63, distance: 0.8 },
  "phone-stand": { id: "phone-stand", label: "Phone on a stand", facing: "user", cameraMoves: false, sees: "full-body", stance: "standing", ground: "floor", fov: 65, distance: 2.5 },
  selfie: { id: "selfie", label: "Handheld selfie", facing: "user", cameraMoves: true, sees: "upper-body", stance: "standing", ground: "none", fov: 70, distance: 0.5 },
  "rear-person": { id: "rear-person", label: "Rear camera on another person", facing: "environment", cameraMoves: true, sees: "full-body", stance: "standing", ground: "floor", fov: 68, distance: 3 },
  "rear-hand": { id: "rear-hand", label: "Rear camera on a hand", facing: "environment", cameraMoves: true, sees: "hand", stance: "standing", ground: "none", fov: 68, distance: 0.35 },
  "rear-table": { id: "rear-table", label: "Rear camera on a table", facing: "environment", cameraMoves: true, sees: "hand", stance: "seated", ground: "table", fov: 68, distance: 0.5 },
};
