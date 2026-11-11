/**
 * Measured line wrapping for the lens (moved from the pre-Aristo `ui/stream.ts`, SC-9500).
 *
 * The firmware font is proportional, so wrapping is by PIXEL width via pretext's measurements, never by
 * character count. Explicit `\n` is a hard break; a word wider than the line is split by glyph.
 */
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';

/** A full-width text container's inner width: 576 px minus 4 px padding each side. */
export const FULL_WIDTH = 576 - 2 * 4;

export function wrapTextLines(text: string, maxWidth = FULL_WIDTH): string[] {
  const lines = text.split('\n').flatMap((line) => wrapExplicitLine(line, maxWidth));
  return lines.length ? lines : [''];
}

function wrapExplicitLine(line: string, maxWidth: number): string[] {
  if (line === '') return [''];
  if (fitsOneLine(line, maxWidth)) return [line];

  const tokens = line.match(/\S+\s*/g) ?? [line];
  const wrapped: string[] = [];
  let current = '';

  for (const token of tokens) {
    const candidate = current + token;
    if (current && !fitsOneLine(candidate.trimEnd(), maxWidth)) {
      wrapped.push(current.trimEnd());
      current = '';
    }
    if (!fitsOneLine(token.trimEnd(), maxWidth)) {
      const split = splitLongToken(token.trimEnd(), maxWidth);
      if (current) wrapped.push(current.trimEnd());
      wrapped.push(...split.slice(0, -1));
      current = split[split.length - 1] ?? '';
      continue;
    }
    current += token;
  }

  if (current || wrapped.length === 0) wrapped.push(current.trimEnd());
  return wrapped;
}

function fitsOneLine(text: string, maxWidth: number): boolean {
  return measureTextWrap(text, maxWidth).lineCount <= 1;
}

function splitLongToken(token: string, maxWidth: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of Array.from(token)) {
    const candidate = current + char;
    if (current && getTextWidth(candidate) > maxWidth) {
      parts.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}
