// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Build-time catalog generation intentionally consumes GitHub/Hugging Face HTTP and writes a reviewed artifact.
import * as NodeFSP from "node:fs/promises";

import { fetchPaginatedJson, requireUniqueIds } from "./catalog-pagination.ts";

const HUGGING_FACE_AUTHOR = "handy-computer";
const HUGGING_FACE_API = "https://huggingface.co/api";
const FEATURED = new Set([
  "parakeet-tdt-0.6b-v3",
  "parakeet-tdt_ctc-110m",
  "parakeet-unified-en-0.6b",
  "whisper-tiny",
  "whisper-base",
  "whisper-small",
  "whisper-large-v3-turbo",
  "nemotron-3.5-asr-streaming-0.6b",
]);

interface HubModel {
  readonly id: string;
  readonly tags?: ReadonlyArray<string>;
}

interface HubTreeEntry {
  readonly path: string;
  readonly size?: number;
  readonly lfs?: { readonly oid?: string; readonly size?: number };
}

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as T;
};

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
};

const frontMatterLanguages = (readme: string): ReadonlyArray<string> => {
  const block = /^language:\s*\n((?:\s*-\s*.+\n)+)/mu.exec(readme)?.[1];
  return block === undefined
    ? []
    : block
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/u, "").trim())
        .filter(Boolean);
};

const metadataBoolean = (readme: string, key: string): boolean =>
  new RegExp(`^\\s*${key}:\\s*true\\s*$`, "mu").test(readme);

const titleFromReadme = (readme: string, fallback: string): string =>
  /^#\s+(.+)$/mu
    .exec(readme)?.[1]
    ?.replace(/:\s*transcribe\.cpp GGUF$/u, "")
    .trim() ?? fallback;

const descriptionFromReadme = (readme: string): string => {
  const afterTitle = readme.slice(readme.search(/^#\s+/mu)).split("\n\n").slice(1);
  return (
    afterTitle
      .find(
        (paragraph) =>
          paragraph.trim().length > 0 &&
          !paragraph.trimStart().startsWith("#") &&
          !paragraph.trimStart().startsWith("<"),
      )
      ?.replace(/\s+/gu, " ")
      .trim() ?? ""
  );
};

const quantId = (path: string): string | undefined =>
  /-(F32|F16|Q\d+_[A-Z0-9](?:_[A-Z])?)\.gguf$/u.exec(path)?.[1];

const makeEntry = async (repository: string) => {
  const slug = repository.slice(`${HUGGING_FACE_AUTHOR}/`.length).replace(/-gguf$/iu, "");
  const encodedRepository = repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const [tree, readme] = await Promise.all([
    fetchJson<ReadonlyArray<HubTreeEntry>>(
      `${HUGGING_FACE_API}/models/${encodedRepository}/tree/main?recursive=true&expand=true`,
    ),
    fetchText(`https://huggingface.co/${encodedRepository}/raw/main/README.md`),
  ]);
  const quantizations = tree
    .flatMap((file) => {
      const id = quantId(file.path);
      const sha256 = file.lfs?.oid;
      const sizeBytes = file.lfs?.size ?? file.size;
      if (id === undefined || sha256 === undefined || sizeBytes === undefined) return [];
      return [
        {
          id,
          label: id,
          downloadUrl: `https://huggingface.co/${encodedRepository}/resolve/main/${encodeURIComponent(file.path)}`,
          sha256,
          sizeBytes,
          minRamMb: sizeBytes > 600_000_000 ? 4096 : sizeBytes > 250_000_000 ? 3072 : 2048,
          ...(sizeBytes > 600_000_000 || slug === "parakeet-tdt-0.6b-v3"
            ? { requiresGpuFamily: "apple7" }
            : {}),
        },
      ];
    })
    .sort((left, right) => left.sizeBytes - right.sizeBytes);
  if (quantizations.length === 0) return undefined;
  const languages = frontMatterLanguages(readme);
  return {
    id: slug,
    displayName: titleFromReadme(readme, slug),
    description: descriptionFromReadme(readme),
    capabilities: {
      languages,
      supportsLanguageDetect: metadataBoolean(readme, "lang_detect"),
      supportsInitialPrompt: slug.startsWith("whisper-"),
      supportsStreaming: metadataBoolean(readme, "streaming"),
    },
    quantizations,
    featured: FEATURED.has(slug),
  };
};

const mapConcurrent = async <A, B>(
  values: ReadonlyArray<A>,
  concurrency: number,
  f: (value: A) => Promise<B>,
): Promise<ReadonlyArray<B>> => {
  const result = Array.from<B>({ length: values.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        result[index] = await f(values[index] as A);
      }
    }),
  );
  return result;
};

const models = requireUniqueIds(
  await fetchPaginatedJson<HubModel>(
    `${HUGGING_FACE_API}/models?author=${HUGGING_FACE_AUTHOR}&limit=100&full=true`,
  ),
);
const repositories = [
  ...new Set(
    models
      .filter(
        (model) => model.tags?.includes("transcribe.cpp") === true && /-gguf$/iu.test(model.id),
      )
      .map((model) => model.id),
  ),
].sort();
const catalog = (await mapConcurrent(repositories, 8, makeEntry))
  .filter((entry) => entry !== undefined)
  .sort(
    (left, right) =>
      Number(right.featured) - Number(left.featured) ||
      left.displayName.localeCompare(right.displayName),
  );

await NodeFSP.writeFile(
  new URL("../src/catalog.json", import.meta.url),
  `${JSON.stringify(catalog, null, 2)}\n`,
);
