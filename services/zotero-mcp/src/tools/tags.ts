import { z } from "zod";
import type { ZoteroClient } from "../zotero-client.js";
import { runBounded } from "../zotero-client.js";

// Library-wide tag management, as opposed to per-item tagging (which lives
// on zotero_items: add_tags / remove_tags / bulk_tag_*).

export const TAGS_TOOL = {
  name: "zotero_tags",
  description: [
    "Library-wide tag operations (vs per-item tags on zotero_items). Actions:",
    "• list — every distinct tag in the library with usage counts.",
    "• search — find tags matching a query.",
    "• delete — remove a tag from ALL items that have it (tag vanishes from the library).",
    "• rename — rename a tag across ALL items (no native endpoint; the MCP does the read-modify-write per item).",
    "For per-item tag changes use zotero_items add_tags / remove_tags / bulk_tag_*.",
  ].join(" "),
} as const;

export const TagsInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    limit: z.number().int().min(1).max(200).default(100),
    start: z.number().int().min(0).default(0),
  }),
  z.object({
    action: z.literal("search"),
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  z.object({
    action: z.literal("delete"),
    tag: z.string().min(1),
  }),
  z.object({
    action: z.literal("rename"),
    from: z.string().min(1),
    to: z.string().min(1),
    max_items: z.number().int().min(1).max(500).default(200).describe("Safety cap — rename will refuse if more items carry the tag than this."),
  }),
]);

export async function handleTags(client: ZoteroClient, input: z.infer<typeof TagsInput>) {
  switch (input.action) {
    case "list": {
      const params = new URLSearchParams({
        limit: String(input.limit),
        start: String(input.start),
      });
      const { data, headers } = await client.get<any[]>(client.userPath(`/tags?${params}`));
      return {
        total: Number(headers.get("total-results") ?? data.length),
        count: data.length,
        tags: data.map((t: any) => ({
          tag: t.tag,
          type: t.meta?.type ?? 0,
          num_items: t.meta?.numItems ?? 0,
        })),
      };
    }

    case "search": {
      const params = new URLSearchParams({
        q: input.query,
        limit: String(input.limit),
      });
      const { data } = await client.get<any[]>(client.userPath(`/tags?${params}`));
      return {
        count: data.length,
        tags: data.map((t: any) => ({
          tag: t.tag,
          num_items: t.meta?.numItems ?? 0,
        })),
      };
    }

    case "delete": {
      // DELETE /users/<id>/tags?tag=X — removes the tag from every item.
      // No per-tag version to check, so no header needed. An earlier
      // version sent "*", which Zotero's API rejects with a 400 — found by
      // actually calling it.
      const params = new URLSearchParams({ tag: input.tag });
      await client.delete(client.userPath(`/tags?${params}`));
      return { deleted_tag: input.tag };
    }

    case "rename": {
      // Zotero has no native rename. Find all items with the old tag,
      // then per-item: remove old + add new.
      const params = new URLSearchParams({
        tag: input.from,
        limit: String(input.max_items),
      });
      const { data: items, headers } = await client.get<any[]>(client.userPath(`/items?${params}`));
      const total = Number(headers.get("total-results") ?? items.length);
      if (total > input.max_items) {
        throw new Error(
          `rename refused: ${total} items carry tag '${input.from}', max_items=${input.max_items}. Raise max_items or do this in two batches.`,
        );
      }
      const results = await runBounded(items, 4, async (it: any) => {
        const k = it.data.key;
        const version = it.data.version;
        const existing: Array<{ tag: string }> = it.data.tags ?? [];
        const next = existing
          .filter((t) => t.tag !== input.from)
          .concat([{ tag: input.to }]);
        // Dedupe if 'to' already present
        const seen = new Set<string>();
        const deduped = next.filter((t) => (seen.has(t.tag) ? false : (seen.add(t.tag), true)));
        await client.patch(
          client.userPath(`/items/${k}`),
          { tags: deduped },
          { "If-Unmodified-Since-Version": String(version) },
        );
        return { key: k };
      });
      const ok = results.filter((r) => r.ok);
      const bad = results.filter((r) => !r.ok);
      return {
        from: input.from,
        to: input.to,
        total_items: total,
        succeeded: ok.length,
        failed: bad.length,
        failures: bad.map((r) => ({ item: r.item?.data?.key, error: r.error })),
      };
    }
  }
}
