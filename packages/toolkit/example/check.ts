// Builds the example, opens it in Chromium and drives it as a person would: drags a card, presses buttons with the
// pointer and with the keyboard on the accessibility mirror, pans, zooms with the wheel and with two fingers, lets a
// second finger cancel a drag, undoes, and uses the controls card over the board. Run with `bun run --cwd packages/toolkit check`.
import { chromium } from "playwright-core";

const out = new URL("./dist/", import.meta.url).pathname;
const built = await Bun.build({ entrypoints: [new URL("./index.html", import.meta.url).pathname, new URL("./board.html", import.meta.url).pathname], outdir: out, minify: false });
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

// The first ambiguous burst pans immediately, then the learned wheel zooms around the pointer.
const anchor = { x: 450, y: 300 };
const beforeWheel = after.view;
await page.evaluate(({ x, y }) => {
  const board = document.getElementById("board")!;
  for (let i = 0; i < 3; i++) board.dispatchEvent(new WheelEvent("wheel", { clientX: x, clientY: y, deltaY: -100 }));
}, anchor);
after = await state();
expect(after.view.zoom === beforeWheel.zoom && after.view.y === beforeWheel.y + 300, "the ambiguous wheel burst pans immediately");
await page.waitForTimeout(120);
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

// The controls card: a layer over the board whose widgets call back into the page, which commits.
type More = { cards: number; bend: number; controls: { x: number; y: number }; at: { x: number; y: number }; link: { x: number; y: number; width: number; height: number } | null };
const more = (): Promise<More> =>
  page.evaluate(() => {
    const e = (window as any).example;
    return { cards: e.doc.cards.length, bend: e.doc.bend, controls: e.doc.controls, at: e.controls.position, link: e.scene.bounds("board/link:idea-sketch") };
  });
const click = async (x: number, y: number) => {
  const q = await screen(x, y);
  await page.mouse.click(q.x, q.y);
};
// Back to where the view started, so the card is on screen.
await page.evaluate(() => (window as any).example.viewport.set({ zoom: 1, x: 40, y: 40 }));
await page.waitForTimeout(50);
let m = await more();
const h1 = (await state()).history;
// "Add a card" is 12 px into the card's content, under its 38 px title.
await click(m.controls.x + 110, m.controls.y + 38 + 27);
let m2 = await more();
expect(m2.cards === m.cards + 1 && (await state()).history === h1 + 1, "a button on the controls card adds a card through the page's commit");

// Dragging the bend slider across is one step to undo, and the connectors are drawn again bowed the other way.
const track = { x0: m.controls.x + 12 + 72, x1: m.controls.x + 12 + 196 - 52 };
let q = await screen(track.x0 + 2, m.controls.y + 38 + 68);
await page.mouse.move(q.x, q.y);
await page.mouse.down();
const end = await screen(track.x1 + 20, m.controls.y + 38 + 68);
await page.mouse.move(end.x, end.y, { steps: 6 });
await page.mouse.up();
m2 = await more();
expect(m2.bend === 0.5 && (await state()).history === h1 + 2, "the bend slider sets the document's bend, as one step");
expect(JSON.stringify(m2.link) !== JSON.stringify(m.link), "the connectors are drawn again for the new bend");

// The card's frame drags it over the board; the move is committed when the drag ends, and undo puts it back.
q = await screen(m.controls.x + 60, m.controls.y + 18);
await page.mouse.move(q.x, q.y);
await page.mouse.down();
await page.mouse.move(q.x + 60, q.y + 40, { steps: 5 });
await page.mouse.up();
m2 = await more();
expect(m2.controls.x > m.controls.x + 20 && m2.at.x === m2.controls.x && (await state()).history === h1 + 3, "dragging the controls card commits its new place once");
await page.keyboard.press("Control+z");
m2 = await more();
expect(m2.controls.x === m.controls.x && m2.at.x === m.controls.x && m2.at.y === m.controls.y, "undo puts the controls card back");

// A connector holds on to the cards it joins: when a card moves, the arrow is drawn edge to edge again.
const linkBefore = (await more()).link!;
const sk = await card("sketch");
q = await screen(sk.x + 60, sk.y + 14);
await page.mouse.move(q.x, q.y);
await page.mouse.down();
await page.mouse.move(q.x, q.y + 120, { steps: 5 });
await page.mouse.up();
const linkAfter = (await more()).link!;
expect(linkAfter.y + linkAfter.height > linkBefore.y + linkBefore.height + 40, "a connector follows the card it holds");

// The board example: a toolkit Board with a document of its own.
await page.goto(`http://localhost:${server.port}/board.html`);
await page.waitForFunction(() => "boardExample" in window);
await page.waitForTimeout(100);
type B = { changes: string[]; history: number; groups: string[]; tool: string; zoom: number };
const b = (): Promise<B> =>
  page.evaluate(() => {
    const e = (window as any).boardExample;
    return { changes: [...e.changes], history: e.history.length, groups: e.doc.map((d: any) => d.groups.find((g: any) => g.parent === undefined).id), tool: e.board.tools.current, zoom: e.board.viewport.zoom };
  });
const box = (id: string) => page.evaluate((id) => (window as any).boardExample.board.scene.bounds(id), id);
// The view is (240, 20) at zoom 1, under a 40 px header.
const at = (x: number, y: number) => ({ x: x + 240, y: y + 60 });
const drag = async (from: { x: number; y: number }, by: { x: number; y: number }, ctrl = false) => {
  if (ctrl) await page.keyboard.down("Control");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 6 });
  await page.mouse.up();
  if (ctrl) await page.keyboard.up("Control");
  await page.waitForTimeout(50);
};
const idea0 = await box("idea");
const link0 = await box("idea-sketch");
// Ctrl turns snapping off, so the shape moves by exactly the pointer.
await drag(at(150, 125), { x: 60, y: 120 }, true);
let idea1 = await box("idea");
let bs = await b();
expect(Math.abs(idea1.x - idea0.x - 60) < 0.01 && Math.abs(idea1.y - idea0.y - 120) < 0.01 && bs.changes.join() === "moved", "board: a drag moves a shape and the page commits it once");
expect(JSON.stringify(await box("idea-sketch")) !== JSON.stringify(link0), "board: the arrows on it are drawn again");
await page.keyboard.press("Control+z");
await page.waitForTimeout(50);
idea1 = await box("idea");
expect(Math.abs(idea1.x - idea0.x) < 0.01 && Math.abs(idea1.y - idea0.y) < 0.01 && JSON.stringify(await box("idea-sketch")) === JSON.stringify(link0), "board: undo loads the last document back, arrows and all");
// A tool from the card, then a rectangle on empty board.
const tb = await page.evaluate(() => (window as any).boardExample.board.cards.scene.bounds("card-tools:rect"));
await page.mouse.click(tb.x + 240 + tb.width / 2, tb.y + 60 + tb.height / 2);
bs = await b();
expect(bs.tool === "rect", "board: a button on the tools card picks a tool");
await drag(at(150, 330), { x: 120, y: 70 });
bs = await b();
const rect = bs.groups.find((g) => g.startsWith("drawn-rect"));
expect(!!rect && bs.changes.at(-1) === "drawn", "board: the rectangle tool draws, and the page commits it");
// An arrow from the new rectangle to the round shape holds on to both.
await page.keyboard.press("a");
const r = await box(rect!);
await drag(at(r.x + r.width / 2, r.y + r.height / 2), { x: 360 + 70 - (r.x + r.width / 2), y: 240 + 45 - (r.y + r.height / 2) });
bs = await b();
const made = bs.groups.find((g) => g.startsWith("drawn-arrow"));
expect(!!made && bs.changes.at(-1) === "connected", "board: the arrow tool joins two shapes, and the page commits it");
await page.keyboard.press("v");
const arrow0 = await box(made!);
await drag(at(360 + 70, 240 + 45), { x: 150, y: 60 }, true);
expect(JSON.stringify(await box(made!)) !== JSON.stringify(arrow0), "board: the new arrow follows the shape it holds");
// Delete what is selected (the shape just dragged), and undo puts it back.
await page.keyboard.press("Delete");
bs = await b();
expect(!bs.groups.includes("shot") && bs.changes.at(-1) === "removed", "board: Delete removes the selection, and the page commits it");
await page.keyboard.press("Control+z");
bs = await b();
expect(bs.groups.includes("shot"), "board: undo brings it back");
// Two fingers pinch the board.
const z = (await b()).zoom;
const t = (type: string, id: number, x: number, y: number) =>
  page.evaluate(([type, id, x, y]) => {
    document.getElementById("board")!.dispatchEvent(new PointerEvent(type as string, { pointerId: id as number, pointerType: "touch", clientX: x as number, clientY: y as number, bubbles: true }));
  }, [type, id, x, y] as const);
await t("pointerdown", 21, 700, 500);
await t("pointerdown", 22, 800, 500);
await t("pointermove", 22, 900, 500);
await t("pointerup", 22, 900, 500);
await t("pointerup", 21, 700, 500);
expect(Math.abs((await b()).zoom / z - 2) < 1e-6, "board: two fingers pinch it");

expect(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
await browser.close();
server.stop();
if (failures.length) process.exit(1);
