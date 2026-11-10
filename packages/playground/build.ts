// Builds the playground, the game and the 3D page into self-contained files, dist/index.html, dist/game.html, dist/space.html and dist/babylon.html, with the
// files they fetch beside them (the world map's data, dist/world.bin; the novel, dist/war-and-peace.txt; the declaration, dist/udhr.txt).
const page = async (entry: string, html: string, out: string, tag: string): Promise<void> => {
  const result = await Bun.build({
    entrypoints: [new URL(`./src/${entry}`, import.meta.url).pathname],
    target: "browser",
    minify: process.env.NO_MINIFY ? false : true,
    // Files imported for their URL, such as the world map's data, keep their names beside the page.
    naming: { asset: "[name].[ext]" },
    publicPath: "./",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const script = (await result.outputs.find((o) => o.kind === "entry-point")!.text()).replace(/<\/script/gi, "<\\/script");
  for (const asset of result.outputs.filter((o) => o.kind === "asset")) {
    await Bun.write(new URL(`./dist/${asset.path.replace(/^\.\//, "")}`, import.meta.url), asset);
    console.log(`dist/${asset.path.replace(/^\.\//, "")}, ${Math.round(asset.size / 1024)} KB`);
  }
  const source = await Bun.file(new URL(`./src/${html}`, import.meta.url)).text();
  const built = source.replace(tag, () => `<script type="module">${script}</script>`);
  if (built === source) throw new Error(`${html} has no ${entry} script tag to inline`);
  await Bun.write(new URL(`./dist/${out}`, import.meta.url), built);
  console.log(`dist/${out}, ${Math.round(built.length / 1024)} KB`);
};
await page("main.ts", "index.html", "index.html", '<script type="module" src="./main.ts"></script>');
await page("game-main.ts", "game.html", "game.html", '<script type="module" src="./game-main.ts"></script>');
await page("space-main.ts", "space.html", "space.html", '<script type="module" src="./space-main.ts"></script>');
await page("babylon-main.ts", "babylon.html", "babylon.html", '<script type="module" src="./babylon-main.ts"></script>');
await page("ar-main.ts", "ar.html", "ar.html", '<script type="module" src="./ar-main.ts"></script>');
// Keep large vision runtimes outside the inline application bundle, at stable
// relative URLs so GitHub Pages works under any repository base path.
await Bun.write(new URL("./dist/ar-vendor/opencv.js", import.meta.url), Bun.file(import.meta.resolve("@techstark/opencv-js/dist/opencv.js").replace("file://", "")));
for (const name of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) {
  const root = new URL("./", import.meta.resolve("@mediapipe/tasks-vision"));
  await Bun.write(new URL(`./dist/ar-vendor/mediapipe/${name}`, import.meta.url), Bun.file(new URL(`wasm/${name}`, root)));
}
// Fetch the fixed, checksum-verified model at build time, so the deployed app
// needs only its own static origin (no Google requests from the user's camera page).
const handModelCache = new URL("./.ar-cache/hand_landmarker.task", import.meta.url);
const handModelFile = Bun.file(process.env.AR_HAND_MODEL_PATH || handModelCache);
const handModel = await handModelFile.exists()
  ? new Uint8Array(await handModelFile.arrayBuffer())
  : await (async () => {
      const response = await fetch("https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task");
      if (!response.ok) throw new Error(`Hand model download failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    })();
const handModelHash = new Bun.CryptoHasher("sha256").update(handModel).digest("hex");
if (handModelHash !== "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1") throw new Error("Hand model SHA-256 mismatch");
await Bun.write(handModelCache, handModel);
await Bun.write(new URL("./dist/ar-vendor/hand_landmarker.task", import.meta.url), handModel);
// The face model, for looking through the 3D page's screen with your head: fetched and checked the same way.
const faceModelCache = new URL("./.ar-cache/face_landmarker.task", import.meta.url);
const faceModelFile = Bun.file(process.env.AR_FACE_MODEL_PATH || faceModelCache);
const faceModel = await faceModelFile.exists()
  ? new Uint8Array(await faceModelFile.arrayBuffer())
  : await (async () => {
      const response = await fetch("https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task");
      if (!response.ok) throw new Error(`Face model download failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    })();
if (new Bun.CryptoHasher("sha256").update(faceModel).digest("hex") !== "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff") throw new Error("Face model SHA-256 mismatch");
await Bun.write(faceModelCache, faceModel);
await Bun.write(new URL("./dist/ar-vendor/face_landmarker.task", import.meta.url), faceModel);
