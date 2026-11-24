// Builds the example, opens it in Chromium and drives it as a person would: drags a card, presses buttons with the
// pointer and with the keyboard on the accessibility mirror, pans, zooms with the wheel and with two fingers, lets a
// second finger cancel a drag, and undoes. Run with `bun run --cwd packages/toolkit check`.
import { chromium } from "playwright-core";

const out = new URL("./dist/", import.meta.url).pathname;
const built = await Bun.build({ entrypoints: [new URL("./index.html", import.meta.url).pathname], outdir: out, minify: false });
if (!built.success) throw new AggregateError(built.logs, "build failed");
const server = Bun.serve({
  port: 0,
  fetch: async (r) => {
    const path = new URL(r.url).pathname;
    const f = Bun.file(out + (path === "/" ? "index.html" : path.slice(1)));
    return (await f.exists()) ? new Response(f) : new Response("", { status: 404 });
  },
});
const executablePath = process.env["CHROMIUM_PATH"];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`http://localhost:${server.port}/`);
await page.waitForFunction(() => "example" in window);

type State = { cards: { id: string; x: number; y: number; count: number }[]; history: number; view: { zoom: number; x: number; y: number } };
const state = (): Promise<State> =>
  page.evaluate(() => {
    const e = (window as any).example;
    return { cards: e.doc.cards, history: e.history.length, view: e.viewport.view };
  });
const card = async (id: string) => (await state()).cards.find((c) => c.id === id)!;
const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};
// The board's canvas starts 40px down; the view starts at (40, 40), zoom 1.
const screen = async (x: number, y: number) => {
  const v = (await state()).view;
  return { x: x * v.zoom + v.x, y: y * v.zoom + v.y + 40 };
};

// A title bar dragged by (100, 50) moves its card by that, committed once.
let p = await screen(300 + 60, 30 + 14);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
for (let i = 1; i <= 5; i++) await page.mouse.move(p.x + 20 * i, p.y + 10 * i);
await page.mouse.up();
let s = await card("sketch");
expect(s.x === 400 && s.y === 80 && (await state()).history === 1, "dragging a title bar moves the card and commits once");

// A press on a button runs its action; a tiny wobble is still a tap.
p = await screen(40 + 40, 60 + 110 - 22);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
await page.mouse.move(p.x + 3, p.y + 2);
await page.mouse.up();
expect((await card("idea")).count === 1, "a tap on a button runs its action");

// The accessibility mirror's button runs the same action from the keyboard.
await page.waitForSelector('[aria-label="Press Shot"]');
await page.focus('[aria-label="Press Shot"]');
await page.keyboard.press("Enter");
expect((await card("shot")).count === 1, "Enter on the mirrored button runs the same action");

// Dragging empty board pans without touching the document.
const before = await state();
await page.mouse.move(700, 500);
await page.mouse.down();
await page.mouse.move(650, 470, { steps: 4 });
await page.mouse.up();
let after = await state();
expect(after.view.x === before.view.x - 50 && after.view.y === before.view.y - 30 && after.history === before.history, "dragging empty board pans and changes nothing else");

// The wheel zooms around the pointer: the world point under it stays put.
const anchor = { x: 450, y: 300 };
const worldBefore = { x: (anchor.x - after.view.x) / after.view.zoom, y: (anchor.y - 40 - after.view.y) / after.view.zoom };
await page.mouse.move(anchor.x, anchor.y);
await page.mouse.wheel(0, -300);
await page.waitForTimeout(50);
after = await state();
const worldAfter = { x: (anchor.x - after.view.x) / after.view.zoom, y: (anchor.y - 40 - after.view.y) / after.view.zoom };
expect(after.view.zoom > 1.2 && Math.abs(worldAfter.x - worldBefore.x) < 1e-6 && Math.abs(worldAfter.y - worldBefore.y) < 1e-6, "the wheel zooms around the pointer");

// Touch: two fingers spreading zoom in; a second finger during a card drag puts the card back uncommitted.
const touch = (type: string, id: number, x: number, y: number) =>
  page.evaluate(([type, id, x, y]) => {
    const c = document.getElementById("board")!;
    c.dispatchEvent(new PointerEvent(type as string, { pointerId: id as number, pointerType: "touch", clientX: x as number, clientY: y as number, bubbles: true, isPrimary: id === 1 }));
  }, [type, id, x, y] as const);
const z0 = (await state()).view.zoom;
await touch("pointerdown", 1, 300, 300);
await touch("pointerdown", 2, 400, 300);
await touch("pointermove", 2, 450, 300);
await touch("pointerup", 2, 450, 300);
await touch("pointermove", 1, 200, 300);
await touch("pointerup", 1, 200, 300);
after = await state();
expect(Math.abs(after.view.zoom / z0 - 1.5) < 1e-6, "two fingers spreading by half again zoom by half again");
expect(after.cards.find((c) => c.id === "idea")!.count === 1, "the finger left after a pinch neither taps nor drags");

const h0 = (await state()).history;
const sketch0 = await card("sketch");
p = await screen(sketch0.x + 60, sketch0.y + 14);
await touch("pointerdown", 1, p.x, p.y);
await touch("pointermove", 1, p.x + 40, p.y);
await touch("pointermove", 1, p.x + 80, p.y);
await touch("pointerdown", 2, p.x + 200, p.y + 100);
await touch("pointerup", 2, p.x + 200, p.y + 100);
await touch("pointerup", 1, p.x + 80, p.y);
s = await card("sketch");
expect(s.x === sketch0.x && s.y === sketch0.y && (await state()).history === h0, "a second finger cancels a card drag: it goes back and nothing is committed");

// Undo is the application's: it steps back through what was committed.
await page.keyboard.press("Control+z");
await page.keyboard.press("Control+z");
await page.keyboard.press("Control+z");
s = await card("sketch");
expect(s.x === 300 && s.y === 30 && (await state()).history === 0, "undo steps back through the application's own history");

expect(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
await browser.close();
server.stop();
if (failures.length) process.exit(1);
