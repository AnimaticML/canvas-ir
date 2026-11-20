# Motion

`@canvas-ir/motion` turns what a camera sees of a person into movements an application can use, without each game, animation tool or interface having to read raw tracking data or rebuild motion control for every character and setup. The playground's **Motion lab** (`motion.html`) is where it is tried, measured and tuned.

The aim is a reusable foundation for the whole range of motion input:

- forgiving interface gestures: point, click, grab, move, rotate, scale;
- skill-based gameplay, such as couching a lance and bracing in a joust;
- expressive capture for animation and film, and posing 3D models.

It is meant to work with these camera setups:

- a desktop webcam showing the face, the upper body or all of a person;
- a phone on a stand;
- a selfie camera held in the hand;
- a phone's rear camera on another person, a hand, or a table.

Across those, it has to cope with different angles and distances, parts out of view, different body proportions, and contact with floors and tables.

It is built in layers, each usable on its own, and it depends on no engine. The lab draws with Babylon.js and CanvasIR, but the package is plain math.

## Layers

1. **Landmarks** (`landmarks.ts`). Trackers report points by name: MediaPipe's 33 body landmarks and 21 per hand. Another tracker maps its points onto these names.
2. **Takes** (`take.ts`). A take is everything a tracker reported over a stretch of time, frame by frame, plus the camera it came from (image size, facing, field of view, mirroring) and the setup. It saves to compact JSON, with the video as a file beside it.
   - A take also keeps small pictures of the camera (320 px JPEGs, four a second), so it can be judged without its video: by a person scrubbing it, or by a model that looks at the pictures.
   - **Labels** say what was being done from a moment on, by the person (typed while recording) or by a watcher. **Marks** are boxes, lines, arrows and notes drawn on the picture over a stretch of time, in image units. A watcher, person or model, uses them to show what a movement was meant to be, beside what the solver measured. Takes are what experiments run on: recorded once, then replayed through the solver as it changes and compared. That way a change is judged on the same movements every time.
3. **Setups** (`setups.ts`). A setup describes the camera arrangement: whether the camera moves, what is usually in view, whether a person is likely seated or standing, and what the ground is (floor, table or nothing).
   - The presets are desk webcam, phone on a stand, handheld selfie, and rear camera on a person, a hand or a table.
   - The solver uses the setup to decide what a part out of view is most likely doing. At a desk, legs are assumed seated.
4. **Skeleton** (`skeleton.ts`). A small fixed skeleton defines the joints, the bones between them, a rest pose and the proportions.
   - Body space is meters from the middle of the hips: y up, z toward the camera, x to the camera's right.
5. **Solve** (`solve.ts`). The `Solver` fits each frame to the skeleton:
   - It filters the landmarks with a One Euro filter whose two knobs trade steadiness against lag.
   - It learns this person's proportions as the take goes, from the median length of each bone seen clearly.
   - It rebuilds the body by forward kinematics, so bones keep their length from frame to frame.
   - It holds a part that goes out of sight where it was for a moment, then eases it to where the setup says it likely is. Every joint is marked seen, held or assumed, with a confidence.
   - It places the body in front of the camera. A small least-squares solve finds the translation that lays the metric body over where the image saw it.
   - It gives every bone's orientation, its rotation from the rest pose, and its rotation relative to its parent. A character is driven from these.
   - It hangs each hand's 21 points from the wrist at the person's hand size, with a pinch measure and a curl per finger.
   - The twist of each limb comes from its hinge (elbow or knee). When the limb is straight, the twist comes from the knuckles' line if the hand was seen, or from the chest otherwise.
6. **Compare** (`compare.ts`). Measures for judging a solve:
   - the angle between two takes' bones, frame by frame;
   - how much each joint shakes (mean acceleration while seen);
   - the share of frames each part was seen;
   - the lag between two takes.
7. **Retarget** (`retarget.ts`). Drives a rigged character from the body. A rig is its bones' rest placement in its own world; a map says which character bones each body bone turns, where the body's joints are on the character, and its finger bones.
   - Each mapped bone's rest frame is measured the way the solver measures the body's, so a character in a T, an A or any rest pose takes the same turn: world_new = frame_now · frame_rest⁻¹ · world_rest, made local to its parent.
   - Nothing in it knows an engine. The lab's Babylon adapter (`motion/character.ts`) reads a glTF's skeleton into a rig and sets the rotations it gives.
8. **Synthetic takes** (`synthetic.ts`). Scripted movements of a known body, seen through a pinhole camera with tracker-like noise, misses and parts leaving the frame. The truth is known for them, so the tests hold the solver to it. They are test fixtures and stay out of the lab.
   - The scripts are Wave, Reach and pinch, Joust, Squat, and Out of frame.

## The lab

- **Left: what the tracker found.** The camera, or the replayed take's video (or its pictures, when there is no video), with the landmarks drawn over it in CanvasIR, and the take's labels and marks in force. Points the tracker was unsure of are drawn faint red, and the hands are drawn in their side's color.
- **Middle: the character.** A rigged robot (RobotExpressive, CC0, by Quaternius) driven by the solved body through retargeting, scaled to the person, its head shrunk so it doesn't hide the arms.
  - **Rods** shows the solved body itself as plain rods and balls instead, and **Both** shows the two together. Blue is the left side, red the right. A rod is solid where seen, amber where held, and faint grey where assumed.
  - It stands where the solver placed it relative to the camera, which is drawn as a small frustum. The floor is under its feet, or where its stance says.
  - The views are **Orbit**, **Behind**, **Side** and **As the camera sees**. The last uses the camera's own field of view, so the mannequin should lie over the image.
  - A compared take is drawn as a violet ghost.
- **Right: what the solver knows.**
  - each part's source;
  - the estimated height and distance;
  - pinch and curl for each hand;
  - a selected joint's place and rotation (click it on the mannequin or the image);
  - over the take: how much was seen and how much the wrists shake;
  - against a compared take: the lag and the bones that differ most.
- **Bottom: the timeline**, drawn with CanvasIR components. It has a **Doing** lane for the labels, and a lane per part showing frame by frame whether it was seen, held or assumed. Drag to scrub, space to play or pause, and the arrow keys to step a frame.
- **Recording.** Choose **Camera, front** or **Camera, rear**, press **Record**, then **Stop**. The take opens for replay with its video.
  - While recording, type what you are doing under the character and press Enter. The label starts at that moment and lasts until the next one. Labels can be added the same way while replaying, and removed from the list on the right.
  - **Save take** downloads the JSON and the video. **Open take…** takes both back.
- **Settings.** The setup, the person's height, the smoothing (**still** and **speed**) and how long a missed part is **hold**-ed all solve the take again as they change.
  - **Compare** sets the take against itself unsmoothed, to see what the smoothing costs, or against another saved take.

MediaPipe's pose (full) and hand models run in the browser. The build fetches them once, checks their checksums and serves them beside the page, so the camera page needs only its own origin.

## The bench

`motion-bench.html` tests the whole chain against a known truth. A rigged human model (opened from a file; the mannequin used so far is not in the repo) is posed by each scripted movement through retargeting, rendered through the camera of a setup (desk webcam, phone on a stand, selfie), and every rendered frame goes through MediaPipe and the solver.

- **The truth is what was rendered.** The character's joints are measured the way the solver measures a body, so the score doesn't depend on how well the character matched the script. How far the character was from the script is shown too, as the bench's own error.
- **The score** is the angle between each solved bone and the true one, where the bone's end was seen and over every frame, with the share of frames each part was seen. **Run all** gives the table for every movement under every camera.
- Each run is a take, with pictures, that can be saved and opened in the lab.

A plain clay mannequin with no clothes or texture tracks well: MediaPipe finds the body and both hands as long as the head is in view.

## Calibrating with a watcher

A take with pictures and labels can be checked by a multimodal model as well as a person. The model looks at the pictures, writes its own labels (`by: "watcher"`) and marks (a box round the hand that should be forward, an arrow for where the arm went), and sets them beside the solved body. Where the watcher and the solver disagree is what to fix next.

## What the tests hold

`packages/motion/test/solve.test.ts` runs every script through the solver against its truth:

- **Accuracy.** Bones that were seen come within a few degrees of the truth, smoothed or not.
- **Proportions.** They are learned within 3% for a person of 1.9 m when the defaults assume 1.72 m.
- **Fixed lengths.** Bones keep their length exactly, seen or not.
- **Parts out of frame.** A hand that leaves the frame is held, then assumed, then seen again when it returns. The legs at a desk are assumed seated.
- **Smoothing.** It removes at least two thirds of the shake for at most two frames of lag.
- **Placement.** The body is placed within 5 cm of where it stands. A noiseless frame comes out exact.
- **Hands.** A pinch and a fist are told from an open hand.

`packages/motion/test/retarget.test.ts` poses a rig twice the body's size, with every bone turned an odd way at rest, and checks each of its bones points the way the body's bone points.

## Next

1. **Real takes.** Record each setup, with poses, gestures, occlusions and table and floor contacts, and keep them as a regression set beside the synthetic ones.
2. **The torso at a desk.** A desk webcam rarely sees the hips, so leaning in and turning are not measured yet. They can come from the shoulders' depth and the head.
3. **Contacts.** Feet planted on the floor, hands resting on a table, and the floor and table found from them, so a planted foot doesn't slide.
4. **More characters.** A human rig and a Kenney one beside the robot, then a knight and a horse.
5. **Actions.** Point, click, grab, move, rotate and scale, plus gameplay actions, each with a profile from forgiving to strict. The hand code on the board in 3D (`hands.ts`) becomes one of these.
6. **Calibration.** True scale from a known height or the iris (as the head tracking in `face.ts` does), and the camera's field of view measured instead of assumed.
7. **Latency.** Measure end to end, and add a short prediction tuned per action.
