import { z } from "zod";
import type { ZoteroClient } from "../zotero-client.js";
import { resolveVersion } from "../zotero-client.js";

export const COLLECTIONS_TOOL = {
  name: "zotero_collections",
  description: [
    "Browse + manage collections (folders) in the Zotero library. Actions:",
    "• list — paginated list of all collections.",
    "• tree — nested structure (parent → children) for the whole library.",
    "• get — details for a single collection key.",
    "• items — items in a specific collection (paginated).",
    "• create — new collection under an optional parent.",
    "• delete — remove a collection (items are NOT deleted, just unfiled).",
  ].join(" "),
} as const;

export const CollectionsInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    limit: z.number().int().min(1).max(100).default(50),
    start: z.number().int().min(0).default(0),
  }),
  z.object({
    action: z.literal("tree"),
  }),
  z.object({
    action: z.literal("get"),
    key: z.string().length(8),
  }),
  z.object({
    action: z.literal("items"),
    key: z.string().length(8),
    limit: z.number().int().min(1).max(100).default(25),
    start: z.number().int().min(0).default(0),
    top_level_only: z.boolean().default(true).describe("If true, exclude attachments/notes."),
  }),
  z.object({
    action: z.literal("create"),
    name: z.string().min(1),
    parent_key: z.string().length(8).optional().describe("If set, create as a child of this collection."),
  }),
  z.object({
    action: z.literal("delete"),
    key: z.string().length(8),
    version: z.number().int().optional(),
  }),
]);

export async function handleCollections(client: ZoteroClient, input: z.infer<typeof CollectionsInput>) {
  switch (input.action) {
    case "list": {
      const params = new URLSearchParams({ limit: String(input.limit), start: String(input.start) });
      const { data, headers } = await client.get<any[]>(client.userPath(`/collections?${params}`));
      return {
        total: Number(headers.get("total-results") ?? data.length),
        count: data.length,
        collections: data.map(compact),
      };
    }
    case "tree": {
      const params = new URLSearchParams({ limit: "100" });
      const all: any[] = [];
      let start = 0;
      while (all.length < 1000) {
        params.set("start", String(start));
        const { data, headers } = await client.get<any[]>(client.userPath(`/collections?${params}`));
        all.push(...data);
        const total = Number(headers.get("total-results") ?? data.length);
        if (all.length >= total || data.length === 0) break;
        start += data.length;
      }
      // Build parent → children map
      const byKey = new Map<string, any>();
      for (const c of all) byKey.set(c.data.key, { ...compact(c), children: [] });
      const roots: any[] = [];
      for (const c of all) {
        const node = byKey.get(c.data.key)!;
        const parent = c.data.parentCollection;
        if (parent && byKey.has(parent)) {
          byKey.get(parent)!.children.push(node);
        } else {
          roots.push(node);
        }
      }
      return { count: all.length, tree: roots };
    }
    case "get": {
      const { data } = await client.get(client.userPath(`/collections/${input.key}`));
      return data;
    }
    case "items": {
      const params = new URLSearchParams({ limit: String(input.limit), start: String(input.start) });
      const suffix = input.top_level_only ? "/items/top" : "/items";
      const { data, headers } = await client.get<any[]>(client.userPath(`/collections/${input.key}${suffix}?${params}`));
      return {
        total: Number(headers.get("total-results") ?? data.length),
        count: data.length,
        items: data.map((item: any) => {
          const d = item.data ?? {};
          return {
            key: d.key,
            item_type: d.itemType,
            title: d.title,
            creators: (d.creators ?? []).map((c: any) => c.name ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()),
            date: d.date,
          };
        }),
      };
    }
    case "create": {
      const payload: any = { name: input.name };
      if (input.parent_key) payload.parentCollection = input.parent_key;
      const { data } = await client.post(client.userPath("/collections"), [payload]);
      return data;
    }
    case "delete": {
      // Zotero requires this header (or a real version — "*" and omitting
      // it both fail); fetch the current version when the caller didn't
      // supply one.
      const version = input.version !== undefined ? input.version : await resolveVersion(client, client.userPath(`/collections/${input.key}`));
      const headers = { "If-Unmodified-Since-Version": String(version) };
      await client.delete(client.userPath(`/collections/${input.key}`), headers);
      return { deleted: input.key };
    }
  }
}

function compact(c: any) {
  const d = c.data ?? {};
  return {
    key: d.key,
    version: d.version,
    name: d.name,
    parent: d.parentCollection || null,
    num_items: c.meta?.numItems ?? 0,
    num_collections: c.meta?.numCollections ?? 0,
  };
}
