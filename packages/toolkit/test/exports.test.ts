import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import pkg from "../package.json";

const src = new URL("../src/", import.meta.url).pathname;

describe("subpath exports", () => {
  test("every module of the toolkit can be imported on its own, by its name", () => {
    const modules = readdirSync(src)
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .map((f) => f.slice(0, -3));
    const subpaths = Object.keys(pkg.exports)
      .filter((k) => k !== ".")
      .map((k) => k.slice(2));
    expect(subpaths.sort()).toEqual(modules.sort());
  });

  test("an app that imports only the playback gets none of the board", async () => {
    const entry = new URL("./fixtures/playback-only.ts", import.meta.url).pathname;
    const out = await Bun.build({ entrypoints: [entry], target: "browser", external: ["canvas-ir"] });
    expect(out.success).toBe(true);
    const code = await out.outputs[0]!.text();
    expect(code).toContain("class Playback");
    expect(code).not.toContain("class Board");
    expect(code).not.toContain("class CardLayer");
  });
});
