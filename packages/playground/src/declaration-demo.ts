// The Universal Declaration of Human Rights in 529 languages and 41 scripts,
// from the UDHR in XML project, packed by scripts/build-declaration.ts: one
// paragraph per line, "# " before a script, "## " before a language (with its
// direction and language tag after tabs) and "### " before a heading in the
// language itself. Read as one document, it puts right-to-left text, Indic
// and Southeast Asian shaping, CJK line breaking and rare scripts through the
// same layout as War and Peace.
import declarationUrl from "./declaration/udhr.txt" with { type: "file" };
import type { Entry, ReaderSpec, SectionSource } from "./reader";

export const DECLARATION_ID = "human-rights";
export const DECLARATION_AT = { x: 1300, y: 5400 };

export const declaration: ReaderSpec = {
  id: DECLARATION_ID,
  at: DECLARATION_AT,
  title: "Universal Declaration of Human Rights",
  subtitle: "in 529 languages, from the UDHR in XML project",
  url: declarationUrl,
  sections: "languages",
  font: "'Noto Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  parse: (source) => {
    const paragraphs: string[] = [];
    const levels: number[] = [];
    const sections: SectionSource[] = [];
    const entries: Entry[] = [];
    let script = "";
    let titled = false;
    for (const line of source.split("\n")) {
      if (line === "") continue;
      if (line.startsWith("# ")) {
        script = line.slice(2);
        entries.push({ section: sections.length, text: script, group: true });
      } else if (line.startsWith("## ")) {
        const [name = "", dir = "ltr"] = line.slice(3).split("\t");
        entries.push({ section: sections.length, text: name, group: false });
        sections.push({
          heads: [{ text: `${name} · ${script}`, level: 5, direction: "ltr" }],
          first: paragraphs.length,
          count: 0,
          chars: 0,
          direction: dir === "rtl" ? "rtl" : "ltr",
        });
        titled = false;
      } else {
        const heading = line.startsWith("### ");
        const text = heading ? line.slice(4) : line;
        // The declaration's own title is bigger than its articles'.
        levels.push(heading ? (titled ? 4 : 2) : 0);
        if (heading) titled = true;
        const s = sections[sections.length - 1]!;
        sections[sections.length - 1] = { ...s, count: s.count + 1, chars: s.chars + text.length };
        paragraphs.push(text);
      }
    }
    return { paragraphs, sections, entries, levels: Uint8Array.from(levels) };
  },
};
