// Wikipedia, read live: the articles about places in a box of the map, from
// the GeoData extension's geosearch, and an article's text and links, from
// its parsed HTML, split into a reader's sections. Both ask the English
// Wikipedia's API, which answers any page that asks with origin=*.
import type { Entry, Link, ReaderDocument, SectionSource } from "./reader";

const API = "https://en.wikipedia.org/w/api.php";

/** An article about a place: where it is, and what kind of place Wikipedia says it is. */
export interface Pin {
  readonly id: number;
  readonly title: string;
  readonly lat: number;
  readonly lon: number;
  /** "city", "landmark", "mountain", "river", "airport", ... or "" when Wikipedia doesn't say. */
  readonly type: string;
}

export interface Article {
  readonly title: string;
  readonly doc: ReaderDocument;
  /** Where the article's subject is, when it has a place. */
  readonly at: { readonly lat: number; readonly lon: number } | null;
}

const ask = async (params: Record<string, string>, signal?: AbortSignal): Promise<unknown> => {
  const url = `${API}?${new URLSearchParams({ ...params, format: "json", formatversion: "2", origin: "*" })}`;
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Wikipedia answered ${response.status}`);
  const body = (await response.json()) as { error?: { info?: string } };
  if (body.error) throw new Error(body.error.info ?? "Wikipedia refused the request");
  return body;
};

/** The articles in a box, up to 500: the most Wikipedia gives at once. The box can be at most about 20 km across. */
export const articlesIn = async (box: { north: number; west: number; south: number; east: number }, signal?: AbortSignal): Promise<Pin[]> => {
  const body = (await ask(
    { action: "query", list: "geosearch", gsbbox: `${box.north}|${box.west}|${box.south}|${box.east}`, gslimit: "500", gsprop: "type" },
    signal,
  )) as { query?: { geosearch?: { pageid: number; title: string; lat: number; lon: number; type?: string }[] } };
  return (body.query?.geosearch ?? []).map((g) => ({ id: g.pageid, title: g.title, lat: g.lat, lon: g.lon, type: g.type ?? "" }));
};

/** An article, by title, with where its subject is. */
export const article = async (title: string, signal?: AbortSignal): Promise<Article> => {
  const [parsed, place] = await Promise.all([
    ask({ action: "parse", page: title, prop: "text", redirects: "1", disableeditsection: "1", disabletoc: "1" }, signal) as Promise<{ parse: { title: string; text: string } }>,
    ask({ action: "query", prop: "coordinates", titles: title, redirects: "1" }, signal) as Promise<{ query?: { pages?: { coordinates?: { lat: number; lon: number }[] }[] } }>,
  ]);
  const at = place.query?.pages?.[0]?.coordinates?.[0];
  return { title: parsed.parse.title, doc: fromHtml(parsed.parse.title, parsed.parse.text), at: at ? { lat: at.lat, lon: at.lon } : null };
};

/** What an article's link points at: another article's title, or null for a file, a category, a citation or another site. */
export const linkTitle = (href: string): string | null => {
  const m = /^(?:\.\/|\/wiki\/)([^#?]+)/.exec(href);
  if (!m) return null;
  const title = decodeURIComponent(m[1]!).replace(/_/g, " ");
  // Namespaces: File:, Category:, Help:, Special:...
  return /^[A-Za-z ]+:/.test(title) ? null : title;
};

/** Sections after which an article holds only sources and links elsewhere. */
const END = new Set(["references", "notes", "citations", "sources", "bibliography", "external links", "further reading", "footnotes", "works cited", "notes and references", "references and notes"]);
/** What a reader needn't see: tables, boxes, figures, citations, maintenance notices. */
const SKIP =
  "table, style, script, link, figure, sup.reference, .reference, .mw-editsection, .reflist, .mw-references-wrap, .navbox, .infobox, .sidebar, .hatnote, .shortdescription, .noprint, .metadata, .thumb, .gallery, .mw-empty-elt, .toc, .ambox, .side-box, .portalbox, .mw-cite-backlink, .mwe-math-mathml-inline, .mwe-math-mathml-display";

/** An article's HTML as sections: the lead under the article's title, then one per top-level heading, with subheadings in them. */
export const fromHtml = (title: string, html: string): ReaderDocument => {
  const page = new DOMParser().parseFromString(html, "text/html");
  const root = page.querySelector(".mw-parser-output") ?? page.body;
  for (const e of Array.from(root.querySelectorAll(SKIP))) e.remove();
  // Formulas read as their source.
  for (const img of Array.from(root.querySelectorAll("img.mwe-math-fallback-image-inline, img.mwe-math-fallback-image-display"))) img.replaceWith(img.getAttribute("alt") ?? "");

  const paragraphs: string[] = [];
  const levels: number[] = [];
  const links = new Map<number, Link[]>();
  const sections: SectionSource[] = [];
  const entries: Entry[] = [];
  const start = (head: string, level: 1 | 2): void => {
    entries.push({ section: sections.length, text: head, group: false });
    sections.push({ heads: [{ text: head, level }], first: paragraphs.length, count: 0, chars: 0, direction: "auto" });
  };
  const push = (text: string, spans: Link[], level: number): void => {
    // Spaces collapse as a browser collapses them, and the links' offsets move with them.
    let out = "";
    const map: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      const space = c === " " || c === "\n" || c === "\t" || c === "\r";
      map.push(out.length);
      if (space && (out === "" || out.endsWith(" "))) continue;
      out += space ? " " : c;
    }
    map.push(out.length);
    out = out.trimEnd();
    if (out === "") return;
    const s = sections[sections.length - 1]!;
    sections[sections.length - 1] = { ...s, count: s.count + 1, chars: s.chars + out.length };
    const moved = spans.map((l) => ({ start: map[l.start]!, end: Math.min(out.length, map[l.end]!), href: l.href })).filter((l) => l.end > l.start);
    if (moved.length > 0) links.set(paragraphs.length, moved);
    paragraphs.push(out);
    levels.push(level);
  };
  /** An element's text, with its links, leaving out lists inside it. */
  const inline = (node: Node, into: { text: string; links: Link[] }): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) into.text += child.textContent ?? "";
      else if (child instanceof Element) {
        const tag = child.tagName;
        if (tag === "UL" || tag === "OL" || tag === "DL") continue;
        if (tag === "BR") {
          into.text += " ";
          continue;
        }
        const href = tag === "A" ? child.getAttribute("href") : null;
        const target = href ? linkTitle(href) : null;
        const from = into.text.length;
        inline(child, into);
        if (target && into.text.length > from) into.links.push({ start: from, end: into.text.length, href: target });
      }
    }
  };
  let ended = false;
  const walk = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName;
      const heading = /^H([2-6])$/.exec(tag);
      if (heading) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
        const level = Number(heading[1]);
        if (level === 2) {
          ended = END.has(text.toLowerCase());
          if (!ended) start(text, 2);
        } else if (!ended) push(text, [], level);
        continue;
      }
      if (ended) continue;
      if (tag === "P" || tag === "DT" || tag === "DD" || tag === "LI") {
        const into = { text: tag === "LI" ? "• " : "", links: [] as Link[] };
        inline(child, into);
        push(into.text, into.links, 0);
        // Lists in an item follow it.
        for (const list of Array.from(child.children)) if (list.tagName === "UL" || list.tagName === "OL" || list.tagName === "DL") walk(list);
      } else walk(child);
    }
  };
  start(title, 1);
  walk(root);
  return { paragraphs, levels: Uint8Array.from(levels), links, sections, entries };
};
