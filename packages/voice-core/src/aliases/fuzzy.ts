export function normalizedLevenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0 || right.length === 0) return 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return (previous[right.length] ?? 0) / Math.max(left.length, right.length);
}

export function normalizeAliasToken(value: string): string {
  return findWordRanges(value)
    .map((range) => range.value)
    .join("")
    .toLocaleLowerCase();
}

/** A deliberately conservative Soundex-style key; mismatched phonetics never fuzzy-match. */
export function phoneticKey(value: string): string {
  const normalized = normalizeAliasToken(value).replace(/[^a-z]/g, "");
  if (normalized.length === 0) return "";
  const groups: Record<string, string> = {
    b: "1",
    f: "1",
    p: "1",
    v: "1",
    c: "2",
    g: "2",
    j: "2",
    k: "2",
    q: "2",
    s: "2",
    x: "2",
    z: "2",
    d: "3",
    t: "3",
    l: "4",
    m: "5",
    n: "5",
    r: "6",
  };
  const first = normalized[0] ?? "";
  let result = first.toUpperCase();
  let previous = groups[first] ?? "";
  for (const letter of normalized.slice(1)) {
    const code = groups[letter] ?? "";
    if (code !== "" && code !== previous) result += code;
    previous = code;
  }
  return `${result}000`.slice(0, 4);
}

export function fuzzyScore(spoken: string, candidate: string): number {
  const distance = normalizedLevenshtein(
    normalizeAliasToken(spoken),
    normalizeAliasToken(candidate),
  );
  return phoneticKey(spoken) === phoneticKey(candidate) ? distance * 0.3 : distance;
}
import { findWordRanges } from "./boundary.ts";
