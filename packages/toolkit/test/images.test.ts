import { describe, expect, test } from "bun:test";
import { RecordingContext } from "canvas-ir";
import { ImageRegistry } from "../src/index";

const picture = (src = "") => ({ src, naturalWidth: 40, naturalHeight: 20 }) as unknown as CanvasImageSource;

describe("image registry", () => {
  test("a URL loads once however many ask, and the change is said", async () => {
    let loads = 0;
    const img = picture();
    const images = new ImageRegistry({ trace: false, load: async () => (loads++, img) });
    const changed: string[] = [];
    images.onChange((k) => changed.push(k));
    const [a, b] = await Promise.all([images.load("cat", "/cat.png"), images.load("cat", "/cat.png")]);
    expect(a).toBe(img);
    expect(b).toBe(img);
    expect(await images.load("cat")).toBe(img);
    expect(loads).toBe(1);
    expect(changed).toEqual(["cat"]);
    expect(images.resolve("cat")).toBe(img);
  });

  test("a failed load can be tried again", async () => {
    let tries = 0;
    const images = new ImageRegistry({ trace: false, load: async () => (++tries === 1 ? Promise.reject(new Error("offline")) : picture()) });
    await expect(images.load("x")).rejects.toThrow("offline");
    expect(images.has("x")).toBe(false);
    await images.load("x");
    expect(images.has("x")).toBe(true);
  });

  test("recording keeps an added image by its key, and others by their src or a new key", () => {
    const images = new ImageRegistry({ trace: false });
    const cat = picture("/cat.png");
    images.add("cat", cat);
    const loose = picture("/dog.png");
    const bitmap = picture();
    const ctx = new RecordingContext({ describeImage: images.describe });
    ctx.drawImage(cat, 0, 0);
    ctx.drawImage(loose, 0, 0);
    ctx.drawImage(bitmap, 0, 0);
    const srcs = ctx.getDocument().ops.map((o) => (o.kind === "image" ? o.image.src : ""));
    expect(srcs).toEqual(["cat", "/dog.png", "image-0"]);
    expect(images.resolve("/dog.png")).toBe(loose);
    expect(images.resolve("image-0")).toBe(bitmap);
  });

  test("drawing by key starts the load and draws nothing until it is here", async () => {
    const img = picture();
    const images = new ImageRegistry({ trace: false, load: async () => img });
    const ctx = new RecordingContext({ describeImage: images.describe });
    expect(images.draw(ctx, "cat", 0, 0, 40, 20, "/cat.png")).toBe(false);
    await images.load("cat");
    expect(images.draw(ctx, "cat", 0, 0, 40, 20)).toBe(true);
    expect(ctx.getDocument().ops).toHaveLength(1);
  });
});
