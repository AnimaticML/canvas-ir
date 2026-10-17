import type { JsonValue } from "canvas-ir";

/**
 * The rich text this package lays out: blocks of inline runs, in the shape an
 * HTML editor's document maps onto (paragraphs, headings, lists, marks).
 */

export type TextAlign = "start" | "end" | "left" | "right" | "center";
export type Direction = "ltr" | "rtl" | "auto";

/** A run of text with its marks. Unset fields come from the block's style. */
export interface TextRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** Monospace, in the theme's code family. */
  readonly code?: boolean;
  readonly color?: string;
  /** Font size in px. */
  readonly size?: number;
  readonly family?: string;
  /** A link target. The run is drawn in the theme's link color, underlined, in a group whose meta carries it. */
  readonly href?: string;
  /** Anything the app wants back when the run is hit, kept in its group's meta. */
  readonly data?: { readonly [key: string]: JsonValue };
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly overline?: boolean;
}

/** A plain string is a run with no marks. */
export type Inline = string | TextRun;

export interface ParagraphBlock {
  readonly type: "paragraph";
  readonly content: readonly Inline[];
  readonly align?: TextAlign;
  readonly direction?: Direction;
}

export interface HeadingBlock {
  readonly type: "heading";
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly content: readonly Inline[];
  readonly align?: TextAlign;
  readonly direction?: Direction;
}

export interface ListBlock {
  readonly type: "list";
  readonly ordered?: boolean;
  /** The first item's number in an ordered list. Default 1. */
  readonly start?: number;
  /** Each item is a list of blocks; nested lists indent further. */
  readonly items: readonly (readonly Block[])[];
}

export type Block = ParagraphBlock | HeadingBlock | ListBlock;

export interface RichText {
  readonly blocks: readonly Block[];
}

export interface Theme {
  /** CSS font family list, e.g. `"Inter", sans-serif`. */
  readonly fontFamily: string;
  readonly codeFamily: string;
  /** Body font size in px. */
  readonly fontSize: number;
  /** Line height as a multiple of each run's font size, like unitless CSS `line-height`. */
  readonly lineHeight: number;
  readonly color: string;
  /** Font sizes of headings 1 to 6, in px. */
  readonly headingSizes: readonly [number, number, number, number, number, number];
  readonly headingWeight: number;
  readonly boldWeight: number;
  /** Space after a paragraph or list, in px. */
  readonly paragraphSpacing: number;
  /** Space before and after a heading, in px. */
  readonly headingSpacingBefore: number;
  readonly headingSpacingAfter: number;
  /** Indent of each list level, in px. Markers sit in the indent. */
  readonly listIndent: number;
  /** Gap between a list marker's end and its item's text, in px. */
  readonly listMarkerGap: number;
  readonly bullets: readonly string[];
  /** Color of runs with an `href` and no color of their own. */
  readonly linkColor: string;
  /** Whether links are underlined, as browsers draw them by default. */
  readonly linkUnderline: boolean;
}

export const DEFAULT_THEME: Theme = {
  fontFamily: "sans-serif",
  codeFamily: "monospace",
  fontSize: 16,
  lineHeight: 1.5,
  color: "#000000",
  headingSizes: [32, 24, 20, 18, 16, 14],
  headingWeight: 700,
  boldWeight: 700,
  paragraphSpacing: 12,
  headingSpacingBefore: 16,
  headingSpacingAfter: 8,
  listIndent: 28,
  listMarkerGap: 8,
  bullets: ["•", "◦", "▪"],
  linkColor: "#0b57d0",
  linkUnderline: true,
};

/** The canvas font shorthand for a run in a block. */
export const runFont = (run: TextRun, block: { size: number; weight: number }, theme: Theme): string => {
  const style = run.italic ? "italic " : "";
  const weight = run.bold ? theme.boldWeight : block.weight;
  const size = run.size ?? block.size;
  const family = run.family ?? (run.code ? theme.codeFamily : theme.fontFamily);
  return `${style}${weight === 400 ? "" : `${weight} `}${size}px ${family}`;
};

export const asRun = (inline: Inline): TextRun => (typeof inline === "string" ? { text: inline } : inline);
