# mannequin.glb

The v9 plain human mannequin, generated for this project and refined in Blender. This is the neutral, unanimated
GLB used by the motion bench; the bench's existing scripts supply its poses.

- 25,654 triangles and 60 bones, including the jaw, eyes, forearm twist bones and three bones per finger.
- Corrected hip and knee centres and leg weights from the accepted v8 rig.
- 51 facial morph targets on the skin and four tongue targets: `tongueOut`, `tongueUp`, `tongueLeft`, `tongueRight`.
- Two dental arches with 14 crowns each, gums, a deeper mouth cavity, and revised lip/jaw deformation.
- Up to six skin influences per vertex; consumers must retain the second set of joint indices and weights.

Bone names and their hierarchy are retained. Rest joint positions and inverse bind matrices differ from the earlier
asset: derive retargeting proportions and rest transforms from this file, rather than reusing measurements of the old
model. glTF uses metres and Y up.

The source is `assets/rigged_v9/mannequin.glb` in the mannequin project, SHA-256:
`6fb352f69b147bcee9b1257c69a4f21354f62c844f0d8f51f643210ef04826e8`.

Blender property drivers are not part of glTF. Facial and tongue morphs are available as targets; custom tongue controls,
conditional lip closure and other driver relationships must be evaluated by a consumer or baked into an animation.
Replacing the bench asset does not add live facial or tongue tracking. The existing body pose scripts are unchanged.
