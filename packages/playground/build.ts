// Builds the playground and the game into self-contained files, dist/index.html and dist/game.html, with the
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
