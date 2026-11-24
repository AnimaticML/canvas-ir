# Motion capture and animation generation: technology references

*Snapshot: 2026-11-24. Examples of existing techniques, not a ranking or an adoption decision. Related implementation: [motion.md](motion.md).*

| Task | Example | What it contributes | Main limitation |
| --- | --- | --- | --- |
| **Live camera → pose** | [Google MediaPipe Pose/Hands](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) | Lightweight 2D/estimated-3D landmarks on web and mobile; already the baseline of `@canvas-ir/motion`. Two calibrated, synchronized cameras could triangulate landmarks, but that is a separate pipeline we would build. | One-camera depth, occlusion and bone rotations need solving; not production-grade motion capture by itself. |
| **One video → 3D motion** | [FlowHMR](https://github.com/flowhmr/flowhmr) | Generative, temporally coherent SMPL-H motion recovery with a physics-based training reward; NPZ/optional FBX. | Offline GPU pipeline; physical plausibility is not measurement accuracy. |
| **One video → articulated extremities** | [ExMR](https://github.com/twehrbein/ExMR) | SMPL-X body motion with explicit hand/foot refinement and world-space export. | Offline, NVIDIA/CUDA-oriented. |
| **Fast body reconstruction, including multiview** | [FAB](https://github.com/noahcao/FAB) | 2D/3D and dense body points, contact predictions, scene/world recovery, and calibrated multi-camera fusion. FAB-L reports ~39 FPS for *single-person body estimation* on an RTX 4070 Ti SUPER, not for the full scene pipeline. | Full video/world processing is heavier; released weights are **research/non-commercial only**. |
| **Several videos → 3D motion** | [MAMMA](https://github.com/cuevhv/mamma) | Dense multiview fitting to SMPL-X, including interacting people and occlusions. | Requires synchronized views and substantial offline computation; research licence. |
| **Video → Unreal character animation** | [MetaHuman Animator markerless capture](https://dev.epicgames.com/documentation/metahuman/metahuman-animation-from-mono-video-capture-in-unreal-engine) | Offline body or combined body/face capture from one video, integrated with Unreal/MetaHuman workflows. | UE 5.8+; experimental markerless plugin, Windows-only for body capture. |
| **Sparse poses → new motion** | [NVIDIA MotionBricks](https://github.com/NVlabs/motionbricks) | Learned inbetweening from four recent poses and 1–4 target poses; can chain transitions and scene interactions. | Synthesizes motion rather than measuring it; reference runtime uses NVIDIA GPU/TensorRT. |
| **Description → authored animation** | [Coding agent + Blender Python](https://docs.blender.org/api/current/) | Scripted keyframes, IK, constraints and simulation without manual modelling/posing. | Natural complex motion is difficult without a specialized motion model. |

## Integration example, not a new estimator

[toyxyz RGB MoCap](https://github.com/toyxyz/toyxyz_RGBMocap) **is worth mentioning**, but only as a systems reference: it integrates FlowHMR, ExMR, GVHMR, MAMMA and others with **contact/foot-lock correction, character retargeting, FBX/BVH export, Blender and Unreal streaming**. Those post-processing and interchange components are substantive; the underlying pose estimators are upstream models. Its PEAR mode is an experimental **live preview only**, without recording or animation export. It is chiefly a Windows/NVIDIA desktop workflow, not a browser/phone runtime or a documented general-purpose CLI API.

## Implication for CanvasIR

Keep three distinct lanes: **low-latency interaction** (MediaPipe/current motion solver), **offline reconstruction of recorded takes** (FAB, FlowHMR, ExMR, MAMMA, MetaHuman), and **generation of otherwise unavailable motion** (MotionBricks or scripted Blender). Compare reconstructions on the **same saved takes**, in a **common rig, coordinate system and timeline**, tracking joint error, root trajectory, occlusions, contacts, foot sliding, latency and automation. Monocular reconstructions are estimates, not ground truth; check every model/asset licence before integration.
