import { describe, expect, it } from "vite-plus/test";

import { fetchPaginatedJson, nextPageUrl, requireUniqueIds } from "./catalog-pagination.ts";

describe("catalog pagination", () => {
  it("finds the next relation among multiple Link values", () => {
    expect(
      nextPageUrl(
        '<https://hub.test/models?cursor=previous>; rel="prev", <https://hub.test/models?cursor=next>; rel="next"; type="application/json"',
      ),
    ).toBe("https://hub.test/models?cursor=next");
  });

  it("collects every page instead of truncating the catalog at the first limit", async () => {
    const requested: string[] = [];
    const pages = new Map([
      [
        "https://hub.test/models?limit=2",
        new Response(JSON.stringify([{ id: "one" }, { id: "two" }]), {
          headers: {
            link: '<https://hub.test/models?limit=2&cursor=next>; rel="next"',
          },
        }),
      ],
      [
        "https://hub.test/models?limit=2&cursor=next",
        new Response(JSON.stringify([{ id: "three" }])),
      ],
    ]);

    const values = await fetchPaginatedJson<{ readonly id: string }>(
      "https://hub.test/models?limit=2",
      async (input) => {
        const url = String(input);
        requested.push(url);
        const response = pages.get(url);
        if (response === undefined) throw new Error(`Unexpected request: ${url}`);
        return response;
      },
    );

    expect(values.map((value) => value.id)).toEqual(["one", "two", "three"]);
    expect(requested).toEqual([...pages.keys()]);
    expect(requireUniqueIds(values)).toHaveLength(3);
  });

  it("rejects duplicate model ids across page boundaries", () => {
    expect(() => requireUniqueIds([{ id: "one" }, { id: "one" }])).toThrow(
      "duplicate model id: one",
    );
  });
});
