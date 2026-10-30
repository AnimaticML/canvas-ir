// War and Peace, 566,000 words in the Maude translation, from Project
// Gutenberg's plain text, packed by scripts/build-book.ts into a paragraph
// per line with "# " before a book's title and "## " before a chapter's.
import bookUrl from "./book/war-and-peace.txt" with { type: "file" };
import type { Entry, ReaderSpec, SectionSource } from "./reader";

export const BOOK_ID = "war-and-peace";
export const BOOK_AT = { x: 1300, y: 4350 };

const roman = (s: string): string => s.replace(/^CHAPTER /, "Chapter ");
const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s:])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

export const warAndPeace: ReaderSpec = {
  id: BOOK_ID,
  at: BOOK_AT,
  title: "War and Peace, by Leo Tolstoy",
  subtitle: "translated by Louise and Aylmer Maude",
  url: bookUrl,
  sections: "chapters",
  font: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  parse: (source) => {
    const paragraphs: string[] = [];
    const sections: SectionSource[] = [];
    const entries: Entry[] = [];
    let title: string | null = null;
    for (const line of source.split("\n")) {
      if (line === "") continue;
      if (line.startsWith("# ")) {
        title = titleCase(line.slice(2));
        entries.push({ section: sections.length, text: title, group: true });
      } else if (line.startsWith("## ")) {
        const chapter = roman(line.slice(3));
        entries.push({ section: sections.length, text: chapter, group: false });
        sections.push({
          heads: [...(title ? [{ text: title, level: 1, align: "center" } as const] : []), { text: chapter, level: 3, align: "center", italic: true }],
          first: paragraphs.length,
          count: 0,
          chars: 0,
          direction: "ltr",
        });
        title = null;
      } else {
        const s = sections[sections.length - 1]!;
        sections[sections.length - 1] = { ...s, count: s.count + 1, chars: s.chars + line.length };
        paragraphs.push(line);
      }
    }
    return { paragraphs, sections, entries };
  },
};
