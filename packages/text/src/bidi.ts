import bidiFactory from "bidi-js";

const bidi = bidiFactory();

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/** Whether the text has any right-to-left characters, so it needs reordering. */
export const hasRtl = (text: string): boolean => RTL_CHAR.test(text);

/** A paragraph's base direction: as given, or from its first strong character (UAX #9 P2, P3). */
export const baseDirection = (text: string, direction: "ltr" | "rtl" | "auto"): "ltr" | "rtl" => {
  if (direction !== "auto") return direction;
  const level = bidi.getEmbeddingLevels(text, "auto").paragraphs[0]?.level ?? 0;
  return level % 2 === 1 ? "rtl" : "ltr";
};

export interface VisualRun {
  /** Index of the logical piece the run came from. */
  readonly piece: number;
  /** UTF-16 offsets into that piece's text. */
  readonly start: number;
  readonly end: number;
  readonly rtl: boolean;
}

/**
 * Splits one line's logical pieces (fragments, in reading order) into runs of
 * one direction and orders them visually, left to right, per UAX #9 L2.
 */
export const visualRuns = (pieces: readonly string[], base: "ltr" | "rtl"): VisualRun[] => {
  const text = pieces.join("");
  if (text.length === 0) return [];
  const { levels } = bidi.getEmbeddingLevels(text, base);
  const runs: { piece: number; start: number; end: number; level: number }[] = [];
  let offset = 0;
  pieces.forEach((piece, index) => {
    for (let i = 0; i < piece.length; ) {
      const level = levels[offset + i]!;
      let j = i + 1;
      while (j < piece.length && levels[offset + j] === level) j++;
      runs.push({ piece: index, start: i, end: j, level });
      i = j;
    }
    offset += piece.length;
  });
  // L1: whitespace at the end of the line takes the paragraph's level.
  const baseLevel = base === "rtl" ? 1 : 0;
  for (let k = runs.length - 1; k >= 0; k--) {
    const run = runs[k]!;
    if (pieces[run.piece]!.slice(run.start, run.end).trim() !== "") break;
    run.level = baseLevel;
  }
  // L2: from the highest level down to the lowest odd one, reverse every sequence at that level or above.
  const max = Math.max(...runs.map((r) => r.level));
  const minOdd = Math.min(...runs.map((r) => (r.level % 2 === 1 ? r.level : r.level + 1)));
  for (let level = max; level >= minOdd; level--) {
    for (let i = 0; i < runs.length; ) {
      if (runs[i]!.level < level) {
        i++;
        continue;
      }
      let j = i;
      while (j < runs.length && runs[j]!.level >= level) j++;
      runs.splice(i, j - i, ...runs.slice(i, j).reverse());
      i = j;
    }
  }
  return runs.map(({ piece, start, end, level }) => ({ piece, start, end, rtl: level % 2 === 1 }));
};
