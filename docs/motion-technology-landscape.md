# Motion capture and animation generation — commercial-use filter

*Checked 2026-11-24. [CanvasIR motion implementation](motion.md). This is a practical licensing screen, not legal advice. "Samples" means data intended for a **commercial** product's tests, benchmarks or model training—not a private, non-commercial academic experiment. Verify the exact versions, downloaded assets, upstream dependencies, input-video rights and applicable agreement before shipping.*

## A. Creating test fixtures, animations and training samples

**Candidates with commercial-use paths:**

| Technology | Use for commercial samples / AI training? | Conditions |
| --- | --- | --- |
| [MediaPipe Pose and Hands](https://github.com/google-ai-edge/mediapipe) | **Yes** | Code is Apache-2.0; Google's [BlazePose GHUM 3D model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf) also says Apache-2.0. May produce labels from owned/consented video; these are *estimates*, not ground-truth 3D. Check individual Hand/model bundles and input-data rights. |
| [Blender scripting](https://docs.blender.org/api/current/) + coding agent | **Yes** | Generate synthetic poses/animations with self-authored or commercially licensed rigs, meshes, textures and actions. Blender's GPL does not automatically impose GPL on rendered results. |
| [NVIDIA MotionBricks](https://github.com/NVlabs/motionbricks) | **Yes** | Code Apache-2.0; SOMA/G1 **weights and ONNX** use the [NVIDIA Open Model Agreement](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/), allowing commercial use, with NVIDIA claiming no ownership of outputs. Use **your own/licensed input poses and rigs**; the bundled Bones-derived BVH/CSV samples are **evaluation-only**, not a training or commercial animation library. |
| [MetaHuman Animator / Unreal Engine](https://www.unrealengine.com/ue-devs-can-now-choose-to-train-ai-models-on-their-projects) | **Yes, under the current Epic EULA** | On **2026-10-30** Epic removed the prohibition on using MetaHuman characters, animation curves and relevant output for AI training/testing. Explicitly covers MetaHuman Animator. Accept the updated EULA; check third-party/Fab content (including NoAI terms), recording consent and any seat/royalty obligations. This is a Windows/Unreal production workflow, not a portable model. |
| [SMPL-Body](https://smpl.is.tue.mpg.de/bodylicense.html) / [SMPL-X Body](https://smpl-x.is.tue.mpg.de/bodylicense.html) *assets* | **Conditional** | The **body-only** mesh/rig/animation interchange assets (no shape-generation model/tools) are CC BY 4.0, with attribution. This **does not** give a licence to run the research SMPL/SMPL-X *models* to create a commercial training set. Source the assets from a legitimately licensed pipeline and establish rights to the actual dataset. |

**Exclude for commercial sample generation without separate written permission:** [FlowHMR](https://huggingface.co/fafsaf1/flowhmr-0.46B) (model **weights** non-commercial despite Apache-2.0 code), [ExMR](https://github.com/twehrbein/ExMR/blob/main/LICENSE) and its [GVHMR](https://github.com/zju3dv/GVHMR) base (non-profit/research restrictions), [FAB](https://github.com/noahcao/FAB/blob/main/WEIGHTS_LICENSE) (all released weights non-commercial; trained on restricted data/SMPL), [MAMMA](https://github.com/cuevhv/mamma/blob/main/LICENSE) (explicitly forbids commercial artifacts and training commercial algorithms). Research-only output is **not** automatically safe to use later for a commercial model.

## B. Running inside or alongside a commercial application

| Technology | Decision | Practical role |
| --- | --- | --- |
| **MediaPipe** | **Use** | Cross-platform web/mobile/desktop live tracker; current `@canvas-ir/motion` baseline. Keep CanvasIR's own pose solving and retargeting independent of the tracker. |
| **Our own two-camera calibration + triangulation + solver** | **Use** | No restricted mocap model needed beyond the commercially licensed tracker; own calibration/geometry implementation, with independent camera/rig assets. |
| **Blender-generated animations** | **Use as exported assets** | Blender itself is an authoring tool, not the mobile/browser runtime. |
| **MotionBricks** | **Use if GPU/runtime and model terms fit** | Commercially licensed motion generation, primarily offline/server or NVIDIA GPU runtime; commercial-use status does not imply mobile feasibility. |
| **MetaHuman Animator** | **Use as an authoring/export workflow** | Commercial creation of clips; engine EULA governs its usage. **Do not treat** the closed Animator plugin as an embeddable independent browser/mobile SDK. An Unreal product has separate distribution/fee rules. |
| **SMPL / SMPL+H / SMPL-X full parametric model** | **Not under the free research licence** | Obtain [commercial rights from Max Planck / Meshcapade](https://smpl.is.tue.mpg.de/modellicense.html) before using model binaries, body fitting, shape blendshapes or SMPL-based synthetic training data commercially. |
| **FlowHMR, ExMR/GVHMR, FAB, MAMMA pretrained pipelines** | **Exclude** | Published code, model weights and/or required body models prohibit commercial use; replacing just the UI or exporting to FBX does not fix the restriction. |
| **[toyxyz RGB MoCap](https://github.com/toyxyz/toyxyz_RGBMocap/blob/main/LICENSE)** | **Original post-processing code only, after dependency audit** | Its **own** contact correction/retargeting/export glue is MIT; integrated third-party estimators/weights/body models remain independently restricted. Not a licence-cleared turnkey commercial mocap stack. |

## C. SMPL is two different licensing questions

1. **The parametric *model*** (SMPL, SMPL+H / SMPL-H, SMPL-X): the publicly downloadable research models are **non-commercial**. Their licences expressly prohibit using them to **train commercial neural networks**, or to produce commercial artifacts. Paying for commercial rights via [Meshcapade](https://github.com/Meshcapade/wiki/blob/main/wiki/SMPL.md) / Max Planck is an option. See [SMPL model terms](https://smpl.is.tue.mpg.de/modellicense.html) and [SMPL-X model terms](https://smpl-x.is.tue.mpg.de/modellicense.html).
2. **The static/animated *body* representation** (mesh, skeleton, pose/dynamic blendshapes, excluding shape blendshapes and body-generation tools): [SMPL-Body](https://smpl.is.tue.mpg.de/bodylicense.html) and [SMPL-X Body](https://smpl-x.is.tue.mpg.de/bodylicense.html) are **CC BY 4.0**. They may be redistributed/used commercially *within their scope*, with attribution. This body-only permission **does not override restrictions on the model or on how training data was produced**.

In particular, **MediaPipe BlazePose uses GHUM-derived training data but its released tracker is Apache-2.0**; using the tracker does not mean that CanvasIR downloads or runs an SMPL/GHUM generative body model.

## Design consequence

Keep three separate paths: **(1) real-time MediaPipe + own solver** for camera control; **(2) licensed Blender/Unreal + MotionBricks** for synthesizing samples or production animations; **(3) optional commercially licensed offline mocap**, only after individual model, weights, dataset and body-model rights are cleared. Treat FAB/FlowHMR/ExMR/MAMMA as *research references only* for now. Never use outputs from a restricted research model as commercial training labels merely because the output was retargeted or converted to FBX.

Licensing sources: [MediaPipe model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf) · [NVIDIA model/sample terms](https://github.com/NVlabs/motionbricks/blob/main/README.md) · [Epic October 2026 EULA change and FAQ](https://www.unrealengine.com/ue-devs-can-now-choose-to-train-ai-models-on-their-projects) · [FlowHMR weights](https://huggingface.co/fafsaf1/flowhmr-0.46B) · [ExMR](https://github.com/twehrbein/ExMR/blob/main/LICENSE) · [FAB](https://github.com/noahcao/FAB/blob/main/WEIGHTS_LICENSE) · [MAMMA](https://github.com/cuevhv/mamma/blob/main/LICENSE) · [SMPL](https://smpl.is.tue.mpg.de/modellicense.html) / [SMPL-X](https://smpl-x.is.tue.mpg.de/modellicense.html).
