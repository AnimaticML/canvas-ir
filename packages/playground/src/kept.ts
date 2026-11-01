// Answers kept in the browser's Cache Storage, so a map seen once comes back
// on the next visit without asking OpenFreeMap or Wikipedia again. Only
// answers that are sure not to change are kept: tiles of a named build, and
// the articles in a cell. Where Cache Storage isn't offered (a page opened
// from a file, a private window), nothing is kept and every answer is asked.
const NAME = "canvas-ir-map-1";

let opened: Promise<Cache | null> | null = null;
const open = (): Promise<Cache | null> => (opened ??= typeof caches === "undefined" ? Promise.resolve(null) : caches.open(NAME).catch(() => null));

/** A kept answer, or null. */
export const kept = async (url: string): Promise<Response | null> => {
  const cache = await open();
  return (await cache?.match(url).catch(() => undefined)) ?? null;
};

/** Keeps an answer, after the caller has checked it is one worth keeping. */
export const keep = (url: string, body: BodyInit, type: string): void => {
  void open().then((cache) => cache?.put(url, new Response(body, { headers: { "content-type": type } })).catch(() => {}));
};
