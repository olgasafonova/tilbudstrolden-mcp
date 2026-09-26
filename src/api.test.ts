import { afterEach, describe, expect, it, vi } from "vitest";
import { searchDeals, searchDealsBatch } from "./api.js";

// Records every requested URL and answers each with an empty offer list.
function stubFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response("[]", { status: 200 });
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchDeals dealer filter", () => {
  it("asks the API for the household's stores only when dealerIds are given", async () => {
    const urls = stubFetch();
    await searchDeals({ query: "kylling", country: "SE", dealerIds: ["9ba51", "71c90"] });
    const search = new URL(urls[0]);
    expect(search.searchParams.get("dealer_ids")).toBe("9ba51,71c90");
  });

  it("searches every store when no dealerIds are given", async () => {
    const urls = stubFetch();
    await searchDeals({ query: "kylling", country: "SE" });
    expect(new URL(urls[0]).searchParams.has("dealer_ids")).toBe(false);
  });

  it("passes dealerIds through a batch search", async () => {
    const urls = stubFetch();
    await searchDealsBatch({ queries: ["løg", "kylling"], country: "SE", dealerIds: ["11deC"] });
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(new URL(u).searchParams.get("dealer_ids")).toBe("11deC");
  });
});

describe("listStores paging", () => {
  it("reads every page of dealers, not just the first 100", async () => {
    const page = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `d${start + i}`,
        name: `Store ${start + i}`,
        website: null,
        logo: null,
        country: { id: "DK" },
      }));
    const pages = [page(0, 100), page(100, 100), page(200, 3)];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const offset = Number(new URL(url).searchParams.get("offset"));
        return new Response(JSON.stringify(pages[offset / 100] ?? []), { status: 200 });
      }),
    );
    const { listStores } = await import("./api.js");
    const stores = await listStores({ country: "DK" });
    expect(stores).toHaveLength(203);
    expect(stores.at(-1)?.id).toBe("d202");
    expect(urls).toHaveLength(3);
  });
});
