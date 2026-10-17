/** A decoration line's top edge relative to the baseline (down is positive) and its thickness, in px. */
export interface DecorationLine {
  readonly offset: number;
  readonly thickness: number;
}

export interface DecorationMetrics {
  readonly underline: DecorationLine;
  readonly strikethrough: DecorationLine;
  readonly overline: DecorationLine;
}

/**
 * Where Chromium draws `text-decoration` lines for a font of `size` px whose
 * ascent (`fontBoundingBoxAscent`) is `ascent`, when it can't use the font's
 * own values: Canvas has no way to ask the font for them. The thickness is a
 * tenth of the size in whole pixels. The underline sits about 0.106 em below
 * the baseline (the common `post` table value), the line-through is centered a
 * third of the ascent above it, and the overline sits on the ascent. The pixel
 * check holds these to within a pixel of Chromium's DOM for the fixture fonts.
 */
export const decorationMetrics = (size: number, ascent = size * 0.9): DecorationMetrics => {
  const thickness = Math.max(1, Math.floor(size / 10));
  return {
    underline: { offset: Math.max(1, Math.round(0.106 * size - thickness / 2)), thickness },
    strikethrough: { offset: -Math.round(ascent / 3 + thickness / 2), thickness },
    overline: { offset: -Math.round(ascent + thickness), thickness },
  };
};
