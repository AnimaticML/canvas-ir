// Builds the playground into one self-contained file, dist/index.html.
const result = await Bun.build({
  entrypoints: [new URL("./src/main.ts", import.meta.url).pathname],
  target: "browser",
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const script = (await result.outputs[0]!.text()).replace(/<\/script/gi, "<\\/script");
const html = await Bun.file(new URL("./src/index.html", import.meta.url)).text();
const out = html.replace(/<script type="module" src="\.\/main\.ts"><\/script>/, () => `<script type="module">${script}</script>`);
if (out === html) throw new Error("index.html has no main.ts script tag to inline");
await Bun.write(new URL("./dist/index.html", import.meta.url), out);
console.log(`dist/index.html, ${Math.round(out.length / 1024)} KB`);
