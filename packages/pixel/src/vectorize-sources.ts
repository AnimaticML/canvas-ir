// Sources for the vectorizer report: UI drawn by Chromium's own HTML and CSS,
// and SVG files from the corpus, screenshotted at device scale 1.
import type { Browser } from "playwright-core";

const ui: Record<string, string> = {
  "settings card": `<div style="width:340px;padding:20px;border:1px solid #e4e4e7;border-radius:12px;background:#fff;font:14px 'Liberation Sans',sans-serif;color:#18181b">
    <div style="font-weight:700;font-size:18px;margin-bottom:12px">Notifications</div>
    ${["Email digests", "Mentions", "Weekly report"]
      .map(
        (label, i) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid #f4f4f5">
      <span>${label}</span><span style="width:40px;height:22px;border-radius:11px;background:${i === 1 ? "#d4d4d8" : "#2563eb"};position:relative;display:inline-block">
      <span style="position:absolute;top:3px;${i === 1 ? "left" : "right"}:3px;width:16px;height:16px;border-radius:8px;background:#fff"></span></span></div>`,
      )
      .join("")}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <span style="padding:7px 14px;border:1px solid #d4d4d8;border-radius:8px">Cancel</span>
      <span style="padding:7px 14px;border-radius:8px;background:#16a34a;color:#fff;font-weight:700">Save</span>
    </div></div>`,
  toolbar: `<div style="display:flex;gap:6px;padding:8px;background:#27272a;border-radius:10px;width:max-content">
    ${["#f87171", "#fbbf24", "#34d399", "#60a5fa", "#c084fc"]
      .map((c, i) => `<span style="width:34px;height:34px;border-radius:8px;background:${i === 2 ? "#3f3f46" : "transparent"};display:flex;align-items:center;justify-content:center">
        <span style="width:16px;height:16px;background:${c};border-radius:${i % 2 ? "50%" : "3px"};transform:rotate(${i * 15}deg)"></span></span>`)
      .join("")}</div>`,
};

const CORPUS = ["icons.svg", "bar-chart.svg", "pie-chart.svg", "map.svg"];

export const vectorizeSources = async (browser: Browser, corpus: ReadonlyMap<string, string>): Promise<{ name: string; png: string }[]> => {
  const page = await browser.newPage({ viewport: { width: 520, height: 420 }, deviceScaleFactor: 1 });
  const out: { name: string; png: string }[] = [];
  try {
    const shoot = async (name: string, html: string): Promise<void> => {
      await page.setContent(`<body style="margin:0;background:#fff"><div id="x" style="display:inline-block;padding:10px">${html}</div></body>`);
      await page.evaluate(() => document.fonts.ready);
      const png = await page.locator("#x").screenshot();
      out.push({ name, png: png.toString("base64") });
    };
    for (const [name, html] of Object.entries(ui)) await shoot(name, html);
    for (const file of CORPUS) {
      const svg = corpus.get(file);
      if (svg) await shoot(file, `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`);
    }
  } finally {
    await page.close();
  }
  return out;
};
