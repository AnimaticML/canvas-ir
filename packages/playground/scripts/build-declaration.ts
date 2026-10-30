// Packs the Universal Declaration of Human Rights in every language the UDHR
// in XML project (efele.net/udhr, from the translations the UN's human rights
// office collects) has finished, into the document the playground shows. One
// paragraph per line: "# " before a script's name, "## " before a language's
// (with its direction and language tag after tabs), "### " before a heading
// in the language itself.
//
//   bun scripts/build-declaration.ts <folder of udhr_*.xml>
import { readdirSync } from "node:fs";

const folder = process.argv[2];
if (!folder) throw new Error("usage: bun scripts/build-declaration.ts <folder of udhr_*.xml>");

const SCRIPTS: Record<string, string> = {
  Adlm: "Adlam", Arab: "Arabic", Armn: "Armenian", Beng: "Bengali", Cakm: "Chakma", Cans: "Canadian syllabics", Cher: "Cherokee",
  Cyrl: "Cyrillic", Deva: "Devanagari", Ethi: "Ethiopic", Geor: "Georgian", Gran: "Grantha", Grek: "Greek", Gujr: "Gujarati", Guru: "Gurmukhi",
  Hang: "Hangul", Hani: "Han", Hans: "Han, simplified", Hant: "Han, traditional", Hebr: "Hebrew", Java: "Javanese", Jpan: "Japanese",
  Khmr: "Khmer", Knda: "Kannada", Kore: "Korean", Lana: "Tai Tham", Laoo: "Lao", Latn: "Latin", Mlym: "Malayalam", Mong: "Mongolian",
  Mymr: "Myanmar", Orya: "Odia", Sinh: "Sinhala", Syrc: "Syriac", Taml: "Tamil", Tavt: "Tai Viet", Telu: "Telugu", Tfng: "Tifinagh",
  Tglg: "Tagalog", Thaa: "Thaana", Thai: "Thai", Tibt: "Tibetan", Vaii: "Vai", Yiii: "Yi",
};

const decode = (s: string): string =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

interface Language {
  readonly name: string;
  readonly script: string;
  readonly dir: string;
  readonly lang: string;
  readonly lines: string[];
}

const languages: Language[] = [];
for (const file of readdirSync(folder).filter((f) => /^udhr_.*\.xml$/.test(f)).sort()) {
  const xml = (await Bun.file(`${folder}/${file}`).text()).replace(/<!--[\s\S]*?-->/g, "");
  const root = /<udhr\s([^>]*)>/.exec(xml)?.[1] ?? "";
  const attr = (name: string): string => new RegExp(`${name}=['"]([^'"]*)['"]`).exec(root)?.[1] ?? "";
  const lines: string[] = [];
  let tag = "";
  // Titles, paragraphs and list items' tags, in document order.
  for (const m of xml.matchAll(/<(title|para)>([\s\S]*?)<\/\1>|<listitem(?:\s+tag=["']([^"']*)["'])?>/g)) {
    if (m[1] === undefined) {
      tag = m[3] ? `${decode(m[3])} ` : "";
      continue;
    }
    const text = decode(m[2]!);
    if (text === "") continue;
    lines.push(m[1] === "title" ? `### ${text}` : `${tag}${text}`);
    tag = "";
  }
  if (lines.length > 0) languages.push({ name: attr("n"), script: SCRIPTS[attr("iso15924")] ?? attr("iso15924"), dir: attr("dir") || "ltr", lang: attr("xml:lang") || attr("iso639-3"), lines });
}

// Scripts with the most languages first, and the languages in each by name, those the project names only in parentheses last.
const order = (a: Language, b: Language): number => Number(a.name.startsWith("(")) - Number(b.name.startsWith("(")) || a.name.localeCompare(b.name);
const byScript = new Map<string, Language[]>();
for (const l of languages) (byScript.get(l.script) ?? (byScript.set(l.script, []), byScript.get(l.script)!)).push(l);
const out: string[] = [];
for (const [script, list] of [...byScript].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
  out.push(`# ${script}`);
  for (const l of list.sort(order)) out.push(`## ${l.name}\t${l.dir}\t${l.lang}`, ...l.lines);
}
const text = `${out.join("\n")}\n`;
await Bun.write(new URL("../src/declaration/udhr.txt", import.meta.url), text);
console.log(`${languages.length} languages in ${byScript.size} scripts, ${(text.length / 1e6).toFixed(2)} M characters`);
