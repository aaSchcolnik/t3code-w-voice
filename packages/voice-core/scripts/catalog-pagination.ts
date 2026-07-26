export const nextPageUrl = (link: string | null): string | undefined =>
  link
    ?.split(",")
    .map((value) => value.trim())
    .map((value) => /^<([^>]+)>;.*\brel="next"(?:;|$)/u.exec(value))
    .find((match) => match !== null)?.[1];

export async function fetchPaginatedJson<T>(
  initialUrl: string,
  request: typeof fetch = fetch,
): Promise<ReadonlyArray<T>> {
  const values: T[] = [];
  const visited = new Set<string>();
  let url: string | undefined = initialUrl;
  while (url !== undefined) {
    if (visited.has(url)) throw new Error(`Pagination cursor repeated: ${url}`);
    visited.add(url);
    const response = await request(url);
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    values.push(...((await response.json()) as ReadonlyArray<T>));
    url = nextPageUrl(response.headers.get("link"));
  }
  return values;
}

export function requireUniqueIds<T extends { readonly id: string }>(
  values: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new Error(`Catalog discovery returned duplicate model id: ${value.id}`);
    }
    seen.add(value.id);
  }
  return values;
}
