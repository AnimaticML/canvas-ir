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
- **Pinch to hold.** A pinch closing within `reach` (35 mm) of a crate or a ball takes hold of it. A pinch closed outside the zone can enter it later; any prior pointer drag is cancelled before the hold starts. The object follows the pinch and the palm’s orientation, keeping the original grab offset and relative rotation. It is thrown with its current linear/angular velocity when the pinch opens.
- **Pinch to point.** A pinch anywhere else presses where it is seen, like a finger on a touch screen: a click, a drag, and two quick pinches a double click (which lifts a window off the table as a tablet, and lays it down again). Two pinching hands are two fingers: on a tablet's title bar they carry it and twist to turn it, on its face they zoom it, and on the table they slide, zoom and turn the view.
- **The open hand is solid.** The index tip, the thumb tip and the palm are kinematic bodies in Havok, so an open hand pushes crates and balls. A body that reappears jumps to the hand before it collides, so it never sweeps through things from where the hand was last seen.

## What the tracker does

Tracking stays on the tracker's side: finding the table and the camera's pose from the markers, the hand's joints in 3D, and calibrating the hand's size for depth. For that last part, `src/ar/flat-hand.ts` has `flatHandScale(cameraPoints, pixels, tablePose, intrinsics)`: with the whole hand laid flat on the table, each joint's pixel ray meets the table (raised by how thick the hand is there) where the joint really is, so one frame gives the scale that makes the tracked hand its true size from all 21 joints, and `spread` says whether the hand really lay flat. It multiplies the camera points the same way as the fingertip calibration in `src/ar/hand.ts` (`metricScale`), and can feed it.

For the AR page, moving onto this means: `hands.configure({ metersPerUnit: scale })` once the table is placed, then each frame `hands.update([{ id, joints: points.map(room), pinch }])`, and `hands.clear()` when the scene hides. `ar/scene.ts` now does this: its own contact, pinch, hold and physics-hand implementation has been removed. It keeps coordinate conversion, the visual cursor, field bounds/edit gating, and a bounded tracking-loss grace period. An inference pass skipped by the tracker is not `update([])`; explicit stop, field edits and sustained tracking loss call `hands.clear()`. AR configures its physical scale and its existing 22/45 mm contact hysteresis. Buttons follow the same press/release semantics as a touch pointer.

## Looking with your head

`runtime.viewer.update(eye)` takes where the viewer's eye is, in meters from the middle of the screen (x right, y up, z toward the viewer), each frame it's known, and `null` when it's lost. The screen becomes a window onto the room: the navigation camera still decides what the window looks onto (across its view, through the point it turns around, at the size its field of view shows there), and a camera of its own stands at the eye with an off-axis projection through the window's edges (`throughWindow` in `src/viewer.ts`). It follows the head from where the view is when it starts, like any other control: the first eye seen stands for the navigation's own view, and the head's moves from there move the view, scaled by how far away the viewer sat (leaning in a tenth of the way comes a tenth of the way closer), times `runtime.viewer.strength`. A face that leaves the camera leaves the view where it is, and one that comes back carries on from there; `runtime.viewer.release()` eases back to the navigation's view. Because only those relative moves count, the screen's real size doesn't matter. Once the screen's diagonal is known it's a true window instead: the screen's real size, where the canvas is on it (from the browser window's place on the screen), the webcam above the middle of its top edge, and the eye where it really is, so the rendered view's angles are the angles the screen really makes at your eye (a dolly zoom from the navigation's wider view as it starts, with what lies in the window's plane staying put). `runtime.viewer.screen` is the screen's size in meters, guessed from CSS pixels. The page's **Look with your head** button feeds it from the front camera through `src/face.ts`: MediaPipe's face landmarker, the eye's distance from how big the irises look (11.7 mm across), the webcam's angle measured once with the eyes held an A4 sheet's length (29.7 cm) from the screen, which also takes in the viewer's own iris size, and 63° until then; the panel shown while it's on asks for the screen's diagonal and runs the measurement, and remembers both, the camera taken to sit just above the middle of the screen, and a One Euro filter on each axis. The eye's place is the middle between the eyes' corners, which stays put when the eyes look around, blink or one closes; its distance is how far apart the outer corners look in 3D (so turning the head changes little), at a spacing learned for this face from the irises while both eyes are open. **Window view** puts the table behind the screen at a tenth of its size, its near edge at the screen's bottom edge, looking down as far as the lid leans back (the panel asks the lid's angle), so the virtual table is level with the real desk. It is for the 3D page on a computer or a phone held in front of you; in AR the rear camera is busy and the phone's own pose already moves the view.

## Tests

`packages/playground/test/hands.test.ts` runs the gestures against a stand-in board (presses, hovers, the gap between pressing and letting go, holding and letting go, a lost hand) and the flat-hand calibration against a synthetic camera. `test/viewer.test.ts` checks that the window's corners stay at the screen's corners from any eye, that what's behind the window moves against the eye, the eye's distance from the iris, and the filter.


## Board host and diagnostics

`HandHost.hold(pointer, id, at?, orientation?)` receives a room-space palm quaternion
when the joints form a nondegenerate palm. Existing three-argument hosts remain
compatible. The Babylon host preserves the object's grab offset and relative
rotation, and drives the same dynamic Havok body with bounded linear/angular
velocity. Mouse holds retain their previous behavior. A degenerate palm retains
the previous orientation instead of generating NaNs. An object cannot be grabbed
by two hands at once.

`meshHandSurface` takes mesh-local width/height and room-space edge margins, so
scaled/rotated panel and tablet bounds match their visible geometry.
`hands.contacts` retains up to 60 actual Havok contacts (hand ID, body part, target,
impulse, room-space position/velocity and contact point). `runtime.events` also
records presses routed through the common entry point. The AR trace converts
contacts to table coordinates and retains its existing interaction result format.

Regression tests cover entering a grab zone with an already closed pinch, palm
rotation delivery and degenerate geometry, and scaled/rotated surface bounds.
The AR Chromium scenario exercises the common API with the real Babylon/Havok
scene; camera/hand accuracy on a physical phone still requires device testing.
