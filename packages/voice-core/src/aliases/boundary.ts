/** Hermes-safe word-boundary scanner used if Unicode lookbehind is unavailable. */
export function supportsUnicodeLookaround(): boolean {
  try {
    void new RegExp("(?<![\\p{L}\\p{N}])x(?![\\p{L}\\p{N}])", "u");
    return true;
  } catch {
    return false;
  }
}

export function isNoSpaceScript(value: string): boolean {
  return /[\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u.test(value);
}

function isUncasedLetterOrDigit(code: number): boolean {
  return (
    (code >= 0x05d0 && code <= 0x05ea) ||
    (code >= 0x05f0 && code <= 0x05f2) ||
    (code >= 0x0620 && code <= 0x064a) ||
    (code >= 0x0660 && code <= 0x0669) ||
    (code >= 0x06f0 && code <= 0x06f9) ||
    (code >= 0x0904 && code <= 0x0939) ||
    (code >= 0x0966 && code <= 0x096f) ||
    (code >= 0x0e01 && code <= 0x0e3a) ||
    (code >= 0x0e40 && code <= 0x0e4e) ||
    (code >= 0x0e50 && code <= 0x0e59) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff10 && code <= 0xff19)
  );
}

function isWordCodePoint(value: string | undefined): boolean {
  if (value === undefined) return false;
  const code = value.codePointAt(0);
  if (code === undefined) return false;
  const lower = value.toLocaleLowerCase();
  const upper = value.toLocaleUpperCase();
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    lower !== upper ||
    isUncasedLetterOrDigit(code)
  );
}

function previousCodePoint(value: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const first = value.charCodeAt(offset - 1);
  const start = first >= 0xdc00 && first <= 0xdfff ? offset - 2 : offset - 1;
  return value.slice(Math.max(0, start), offset);
}

function nextCodePoint(value: string, offset: number): string | undefined {
  if (offset >= value.length) return undefined;
  const first = value.charCodeAt(offset);
  return value.slice(offset, first >= 0xd800 && first <= 0xdbff ? offset + 2 : offset + 1);
}

export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

export interface WordRange extends MatchRange {
  readonly value: string;
}

export function findWordRanges(text: string): ReadonlyArray<WordRange> {
  const ranges: WordRange[] = [];
  let offset = 0;
  while (offset < text.length) {
    const point = nextCodePoint(text, offset);
    if (point === undefined) break;
    if (!isWordCodePoint(point)) {
      offset += point.length;
      continue;
    }
    const start = offset;
    offset += point.length;
    while (offset < text.length) {
      const next = nextCodePoint(text, offset);
      if (next === undefined || !isWordCodePoint(next)) break;
      offset += next.length;
    }
    ranges.push({ start, end: offset, value: text.slice(start, offset) });
  }
  return ranges;
}

export function findBoundaryMatches(
  text: string,
  needle: string,
  caseSensitive: boolean,
  unbounded = false,
): ReadonlyArray<MatchRange> {
  if (needle.length === 0) return [];
  const query = caseSensitive ? needle : needle.toLocaleLowerCase();
  const matches: Array<MatchRange> = [];
  let from = 0;
  while (from < text.length) {
    const first = nextCodePoint(text, from);
    if (first === undefined) break;
    const start = from;
    let end = start;
    let matchedEnd: number | undefined;
    while (end < text.length) {
      const point = nextCodePoint(text, end);
      if (point === undefined) break;
      end += point.length;
      const candidate = text.slice(start, end);
      const normalized = caseSensitive ? candidate : candidate.toLocaleLowerCase();
      if (normalized === query) {
        matchedEnd = end;
        break;
      }
      if (normalized.length > query.length + 1) break;
    }
    if (matchedEnd !== undefined) {
      const end = matchedEnd;
      if (
        unbounded ||
        (!isWordCodePoint(previousCodePoint(text, start)) &&
          !isWordCodePoint(nextCodePoint(text, end)))
      ) {
        matches.push({ start, end });
      }
      from = Math.max(end, start + first.length);
      continue;
    }
    from += first.length;
  }
  return matches;
}
