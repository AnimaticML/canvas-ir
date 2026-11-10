# Hands on the board in 3D

The board in 3D (`packages/playground/src/babylon.ts`) takes hands the way it takes a mouse or fingers. Whatever tracks hands (the AR page's camera and MediaPipe, a replayed recording, a test) only says where each hand's joints are; what a hand does on the board is decided in `src/hands.ts`, so the tracker never reaches into the board, and the board's demos, windows, tablets, panel and physics need nothing of their own for hands.

## The contract

`startBabylon(...)` returns a `BabylonRuntime`. The parts for input:

- `runtime.hands.update(frames, time?)`: call once per tracked frame with every hand seen, `{ id, joints, pinch? }`.
  - `id` stays the same for the same hand while it is seen. A hand missing from a frame is gone: its press is cancelled and what it held is let go.
  - `joints` are MediaPipe's 21 hand joints, as `Vector3`s in **room coordinates** (the scene's units, y up, the table top at y = 0).
  - `pinch`, optional, is how closed the pinch is (thumb tip to index tip over the palm's width) when the tracker measures it better in the image than the 3D joints say.
  - `time` is in milliseconds, for telling a double pinch from two.
  - It returns each hand's `HandState`: `{ action: "hover" | "touch" | "pinch" | "hold" | "idle", target, gap, pinch }`, for a status line or a recording.
- `runtime.hands.configure(options)`: `metersPerUnit` (how many meters a room unit is; the AR page's scale), the pinch thresholds, the press and release distances, the grab reach, `route`, and switches for touching and for the solid hand. Defaults are in `HAND_DEFAULTS`.
- `runtime.press(phase, pixel, pointer?)` and `runtime.pressAt(phase, roomPoint, pointer?)`: one pointer event, at a canvas pixel or at a room point as the camera sees it, through the same handlers as the mouse and touch. Touch pointers pair up as two fingers. This is what hands use underneath, and what anything else that points (a controller, a test) can use.
- `runtime.toCanvas(roomPoint)`: where a room point is on the canvas, through the active camera.

The board uses `scene.activeCamera` for everything it projects and picks, so a tracker that sets its own camera (the AR page's `FreeCamera` from the camera's pose and intrinsics) gets the right rays.

## What a hand does

- **Fingertip touch, by contact in 3D.** The index tip presses the nearest surface it touches (the table, a tablet's face, the panel) when it comes within `pressAt` (12 mm) of it, and lets go past `releaseAt` (25 mm), so noise around the surface doesn't flicker. A finger pushed into the table still counts. Over a surface and not touching, it hovers, and things light up as under a mouse. With `route: "contact"` it presses exactly where the fingertip touches; with `route: "ray"` (the default) it presses where the camera sees the fingertip on that surface, which hides the depth error along the camera's line of sight. With a calibrated hand, `"contact"` is the experiment: a press decided and placed by real 3D contact.
- **Pinch to hold.** A pinch closing within `reach` (35 mm) of a crate or a ball takes hold of it; it follows the pinch, and is thrown with the hand's speed when the pinch opens.
- **Pinch to point.** A pinch anywhere else presses where it is seen, like a finger on a touch screen: a click, a drag, and two quick pinches a double click (which lifts a window off the table as a tablet, and lays it down again). Two pinching hands are two fingers: on a tablet's title bar they carry it and twist to turn it, on its face they zoom it, and on the table they slide, zoom and turn the view.
- **The open hand is solid.** The index tip, the thumb tip and the palm are kinematic bodies in Havok, so an open hand pushes crates and balls. A body that reappears jumps to the hand before it collides, so it never sweeps through things from where the hand was last seen.

## What the tracker does

Tracking stays on the tracker's side: finding the table and the camera's pose from the markers, the hand's joints in 3D, and calibrating the hand's size for depth. For that last part, `src/ar/flat-hand.ts` has `flatHandScale(cameraPoints, pixels, tablePose, intrinsics)`: with the whole hand laid flat on the table, each joint's pixel ray meets the table (raised by how thick the hand is there) where the joint really is, so one frame gives the scale that makes the tracked hand its true size from all 21 joints, and `spread` says whether the hand really lay flat. It multiplies the camera points the same way as the fingertip calibration in `src/ar/hand.ts` (`metricScale`), and can feed it.

For the AR page, moving onto this means: `hands.configure({ metersPerUnit: scale })` once the table is placed, then each frame `hands.update([{ id, joints: points.map(room), pinch }])`, and `hands.clear()` when the scene hides. Its own contact, pinch and hold code in `ar/scene.ts` then has nothing left to do.

## Looking with your head

`runtime.viewer.update(eye)` takes where the viewer's eye is, in meters from the middle of the screen (x right, y up, z toward the viewer), each frame it's known, and `null` when it's lost. The screen becomes a window onto the room: the navigation camera still decides what the window looks onto (across its view, through the point it turns around, at the size its field of view shows there), and a camera of its own stands at the eye with an off-axis projection through the window's edges (`throughWindow` in `src/viewer.ts`). An eye at the distance where the field of view is right for this screen sees what the navigation camera sees. A face lost for longer than a moment eases the view back. `runtime.viewer.screen` is the screen's size in meters, guessed from CSS pixels. The page's **Look with your head** button feeds it from the front camera through `src/face.ts`: MediaPipe's face landmarker, the eye's distance from how big the irises look (11.7 mm across, a 63° camera assumed), the camera taken to sit just above the middle of the screen, and a One Euro filter on each axis. It is for the 3D page on a computer or a phone held in front of you; in AR the rear camera is busy and the phone's own pose already moves the view.

## Tests

`packages/playground/test/hands.test.ts` runs the gestures against a stand-in board (presses, hovers, the gap between pressing and letting go, holding and letting go, a lost hand) and the flat-hand calibration against a synthetic camera. `test/viewer.test.ts` checks that the window's corners stay at the screen's corners from any eye, that what's behind the window moves against the eye, the eye's distance from the iris, and the filter.
