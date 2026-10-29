// Packs a Project Gutenberg plain text of War and Peace (ebook 2600, the
// Maude translation, public domain) into the book the playground shows: one
// paragraph per line, with "# " before a book's title and "## " before a
// chapter's. Gutenberg's header, contents and license are left out.
//
//   bun scripts/build-book.ts <2600-0.txt>
const source = process.argv[2];
if (!source) throw new Error("usage: bun scripts/build-book.ts <2600-0.txt>");
const lines = (await Bun.file(source).text()).replace(/^﻿/, "").split(/\r?\n/);
const start = lines.findIndex((l, i) => l === "BOOK ONE: 1805" && lines.slice(i + 1, i + 8).some((n) => n === "CHAPTER I"));
const end = lines.findIndex((l) => l.startsWith("*** END OF"));
if (start < 0 || end < 0) throw new Error("not the Gutenberg text of War and Peace");
const out: string[] = [];
let paragraph: string[] = [];
const flush = (): void => {
  if (paragraph.length > 0) out.push(paragraph.join(" "));
  paragraph = [];
};
for (const raw of lines.slice(start, end)) {
  const line = raw.trim();
  if (line === "") flush();
  else if (/^(BOOK [A-Z]+: .*|FIRST EPILOGUE: .*|SECOND EPILOGUE)$/.test(line)) {
    flush();
    out.push(`# ${line}`);
  } else if (/^CHAPTER [IVXLC]+$/.test(line)) {
    flush();
    out.push(`## ${line}`);
  } else if (/^End of the Project Gutenberg/i.test(line)) break;
  else paragraph.push(line);
}
flush();
const text = `${out.join("\n")}\n`;
await Bun.write(new URL("../src/book/war-and-peace.txt", import.meta.url), text);
console.log(`${out.filter((l) => l.startsWith("# ")).length} books, ${out.filter((l) => l.startsWith("## ")).length} chapters, ${out.filter((l) => !l.startsWith("#")).length} paragraphs, ${(text.length / 1e6).toFixed(2)} M characters`);
