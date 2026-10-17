// Decoration check: for each font family the text fixtures use and a range of
// sizes, Chromium's DOM draws `text-decoration` lines where decorationMetrics
// says, to within a pixel, measured from the baseline. Canvas can't read the
// font's own underline position, so this holds the fallback to the browser.
import { decorationMetrics } from "@canvas-ir/text";
import type { Browser } from "playwright-core";
import { textFixtures } from "../../text/test/fixtures";

export interface DecorationResult {
  readonly family: string;
  readonly size: number;
  readonly kind: "underline" | "strikethrough" | "overline";
  /** Top row and thickness of the DOM's line, relative to the baseline; null when it drew nothing. */
  readonly dom: { top: number; thickness: number } | null;
  readonly ours: { top: number; thickness: number };
  /** The font's ascent as Canvas reports it, which overlines and line-throughs follow. */
  readonly ascent: number;
}

const CSS = { underline: "underline", strikethrough: "line-through", overline: "overline" } as const;
export const DECORATION_SIZES = [11, 12, 14, 15, 16, 17, 20, 24, 28, 32, 40, 48];

export const checkDecorations = async (browser: Browser): Promise<DecorationResult[]> => {
  const families = [...new Set(textFixtures.map((f) => f.theme?.fontFamily).filter((f): f is string => typeof f === "string"))];
  const page = await browser.newPage({ viewport: { width: 400, height: 240 }, deviceScaleFactor: 1 });
  const out: DecorationResult[] = [];
  try {
    for (const family of families) {
      for (const size of DECORATION_SIZES) {
        for (const kind of ["underline", "strikethrough", "overline"] as const) {
          // The line is drawn in black on transparent text, so every dark row is the line.
          const font = `${size}px ${family.replaceAll('"', "'")}`;
          await page.setContent(
            `<body style="margin:0;background:#fff"><div style="position:absolute;left:10px;top:100px;font:${font};line-height:1.5;color:transparent;text-decoration:${CSS[kind]};text-decoration-color:#000">MMMM<span id="b" style="display:inline-block;width:1px;height:0"></span></div></body>`,
          );
          await page.evaluate(() => document.fonts.ready);
          const baseline = await page.evaluate(() => document.getElementById("b")!.getBoundingClientRect().bottom);
          const png = await page.screenshot({ clip: { x: 0, y: 0, width: 300, height: 240 } });
          const rows = await page.evaluate(async (b64) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, img.width, img.height).data;
            const dark: number[] = [];
            for (let y = 0; y < img.height; y++) {
              let v = 0;
              for (let x = 0; x < img.width; x++) v = Math.max(v, 255 - d[(y * img.width + x) * 4]!);
              if (v > 20) dark.push(y);
            }
            return dark;
          }, png.toString("base64"));
          const ascent = await page.evaluate((f) => {
            const ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
            ctx.font = f;
            return ctx.measureText("").fontBoundingBoxAscent;
          }, font);
          const m = decorationMetrics(size, ascent)[kind];
          out.push({
            family,
            size,
            kind,
            dom: rows.length ? { top: rows[0]! - baseline, thickness: rows.length } : null,
            ours: { top: m.offset, thickness: m.thickness },
            ascent,
          });
        }
      }
    }
  } finally {
    await page.close();
  }
  return out;
};
