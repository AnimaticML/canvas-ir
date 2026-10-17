// Builds the playground and the game into self-contained files: dist/index.html and dist/game.html.
const page = async (entry: string, html: string, out: string, tag: string): Promise<void> => {
  const result = await Bun.build({
    entrypoints: [new URL(`./src/${entry}`, import.meta.url).pathname],
    target: "browser",
    minify: process.env.NO_MINIFY ? false : true,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const script = (await result.outputs[0]!.text()).replace(/<\/script/gi, "<\\/script");
  const source = await Bun.file(new URL(`./src/${html}`, import.meta.url)).text();
  const built = source.replace(tag, () => `<script type="module">${script}</script>`);
  if (built === source) throw new Error(`${html} has no ${entry} script tag to inline`);
  await Bun.write(new URL(`./dist/${out}`, import.meta.url), built);
  console.log(`dist/${out}, ${Math.round(built.length / 1024)} KB`);
};
await page("main.ts", "index.html", "index.html", '<script type="module" src="./main.ts"></script>');
await page("game-main.ts", "game.html", "game.html", '<script type="module" src="./game-main.ts"></script>');
