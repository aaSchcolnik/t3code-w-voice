import {
  findBoundaryMatches,
  findWordRanges,
  isNoSpaceScript,
  supportsUnicodeLookaround,
} from "./boundary.ts";
import { fuzzyScore } from "./fuzzy.ts";

export interface VoiceDictionaryEntry {
  readonly id: string;
  readonly type: "term" | "alias";
  readonly originals: ReadonlyArray<string>;
  readonly replacement?: string;
  readonly caseSensitive?: boolean;
  readonly fuzzy?: boolean;
  readonly enabled?: boolean;
}

export interface AliasEngineOptions {
  /** Lets tests exercise the Hermes fallback without mutating global RegExp support. */
  readonly supportsUnicodeBoundaries?: boolean;
  readonly fuzzyThreshold?: number;
  /** Terms already supplied to the recognizer as prompt biasing. */
  readonly promptedTerms?: ReadonlyArray<string>;
}

interface ExactRule {
  readonly original: string;
  readonly replacement: string;
  readonly caseSensitive: boolean;
  readonly unbounded: boolean;
  readonly fuzzy: boolean;
}

interface ReplacementRange {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly matchedText: string;
  readonly score: number;
  readonly rule: ExactRule;
}

interface ProtectedReplacementRange {
  readonly start: number;
  readonly end: number;
  readonly rule: ExactRule;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isCapitalized(value: string): boolean {
  const first = Array.from(value)[0];
  return (
    first !== undefined &&
    first !== first.toLocaleLowerCase() &&
    first === first.toLocaleUpperCase()
  );
}

function replacementFor(match: string, replacement: string): string {
  if (replacement !== replacement.toLocaleLowerCase()) return replacement;
  if (match === match.toLocaleUpperCase() && match !== match.toLocaleLowerCase()) {
    return replacement.toLocaleUpperCase();
  }
  return isCapitalized(match)
    ? `${Array.from(replacement)[0]?.toLocaleUpperCase() ?? ""}${Array.from(replacement).slice(1).join("")}`
    : replacement;
}

function exactRules(entries: ReadonlyArray<VoiceDictionaryEntry>): ReadonlyArray<ExactRule> {
  return entries
    .filter(
      (entry) =>
        entry.type === "alias" && entry.enabled !== false && entry.replacement !== undefined,
    )
    .flatMap((entry) =>
      entry.originals
        .filter((original) => original.trim().length > 0)
        .map((original) => ({
          original,
          replacement: entry.replacement as string,
          caseSensitive: entry.caseSensitive === true,
          unbounded: isNoSpaceScript(original),
          fuzzy: entry.fuzzy === true,
        })),
    )
    .sort((left, right) => right.original.length - left.original.length);
}

function exactMatchRanges(
  text: string,
  rule: ExactRule,
  useRegex: boolean,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  if (useRegex && !rule.unbounded) {
    const flags = rule.caseSensitive ? "gu" : "giu";
    const expression = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegex(rule.original)}(?![\\p{L}\\p{N}])`,
      flags,
    );
    return [...text.matchAll(expression)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
  }
  return findBoundaryMatches(text, rule.original, rule.caseSensitive, rule.unbounded);
}

const overlaps = (
  left: { readonly start: number; readonly end: number },
  right: { readonly start: number; readonly end: number },
): boolean => left.start < right.end && right.start < left.end;

function protectedReplacementRanges(
  text: string,
  rules: ReadonlyArray<ExactRule>,
): ReadonlyArray<ProtectedReplacementRange> {
  return rules.flatMap((rule) =>
    findBoundaryMatches(text, rule.replacement, false, isNoSpaceScript(rule.replacement)).map(
      (range) => ({ ...range, rule }),
    ),
  );
}

function selectNonOverlapping(
  candidates: ReadonlyArray<ReplacementRange>,
  protectedRanges: ReadonlyArray<ProtectedReplacementRange>,
): ReadonlyArray<ReplacementRange> {
  const selected: Array<ReplacementRange> = [];
  for (const candidate of [...candidates].sort(
    (left, right) =>
      left.start - right.start ||
      left.score - right.score ||
      right.end - right.start - (left.end - left.start),
  )) {
    if (
      protectedRanges.some(
        (range) => range.rule === candidate.rule && overlaps(candidate, range),
      ) ||
      selected.some((range) => overlaps(candidate, range))
    ) {
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}

function applyReplacementRanges(text: string, ranges: ReadonlyArray<ReplacementRange>): string {
  return [...ranges]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, range) =>
        `${current.slice(0, range.start)}${replacementFor(range.matchedText, range.replacement)}${current.slice(range.end)}`,
      text,
    );
}

function applyExact(text: string, rules: ReadonlyArray<ExactRule>, useRegex: boolean): string {
  const protectedRanges = protectedReplacementRanges(text, rules);
  const candidates = rules.flatMap((rule) =>
    exactMatchRanges(text, rule, useRegex).map((range) => ({
      ...range,
      replacement: rule.replacement,
      matchedText: text.slice(range.start, range.end),
      score: 0,
      rule,
    })),
  );
  return applyReplacementRanges(text, selectNonOverlapping(candidates, protectedRanges));
}

function applyFuzzy(
  text: string,
  entries: ReadonlyArray<VoiceDictionaryEntry>,
  threshold: number,
  promptedTerms: ReadonlySet<string>,
): string {
  const allRules = exactRules(entries);
  const rules = allRules.filter(
    (rule) =>
      rule.fuzzy &&
      !promptedTerms.has(rule.original.toLocaleLowerCase()) &&
      !promptedTerms.has(rule.replacement.toLocaleLowerCase()),
  );
  if (rules.length === 0) return text;
  const tokens = findWordRanges(text);
  const candidates: Array<ReplacementRange> = [];
  for (const rule of rules) {
    const wordCount = Math.max(1, rule.original.trim().split(/\s+/u).length);
    if (wordCount > 3) continue;
    for (let index = 0; index <= tokens.length - wordCount; index += 1) {
      const first = tokens[index];
      const last = tokens[index + wordCount - 1];
      if (first === undefined || last === undefined) continue;
      const candidate = text.slice(first.start, last.end);
      if (
        Math.abs(candidate.length - rule.original.length) > Math.max(2, rule.original.length * 0.3)
      )
        continue;
      const score = fuzzyScore(rule.original, candidate);
      if (score >= threshold) continue;
      candidates.push({
        start: first.start,
        end: last.end,
        replacement: rule.replacement,
        matchedText: candidate,
        score,
        rule,
      });
    }
  }
  return applyReplacementRanges(
    text,
    selectNonOverlapping(candidates, protectedReplacementRanges(text, allRules)),
  );
}

/** Never let a user dictionary error destroy a transcription. */
export function applyAliases(
  text: string,
  entries: ReadonlyArray<VoiceDictionaryEntry>,
  options: AliasEngineOptions = {},
): string {
  try {
    const useRegex = options.supportsUnicodeBoundaries ?? supportsUnicodeLookaround();
    const exact = applyExact(text, exactRules(entries), useRegex);
    const promptedTerms = new Set(
      (options.promptedTerms ?? [])
        .map((term) => term.trim().toLocaleLowerCase())
        .filter((term) => term.length > 0),
    );
    return applyFuzzy(exact, entries, options.fuzzyThreshold ?? 0.18, promptedTerms);
  } catch {
    return text;
  }
}

export function voicePromptTerms(
  entries: ReadonlyArray<VoiceDictionaryEntry>,
): ReadonlyArray<string> {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.enabled !== false)
        .flatMap((entry) =>
          entry.type === "term"
            ? entry.originals
            : entry.replacement === undefined
              ? []
              : [entry.replacement],
        )
        .map((term) => term.trim())
        .filter((term) => term.length > 0),
    ),
  ];
}
