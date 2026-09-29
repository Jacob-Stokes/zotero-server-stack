import { z } from "zod";
import type { ZoteroClient } from "../zotero-client.js";
import { runBounded, resolveVersion } from "../zotero-client.js";

// Zotero item types per https://api.zotero.org/itemTypes — enumerating the
// common ones for agent UX. Less-common types can still be used via a
// freeform string in custom payloads.
const CommonItemType = z.enum([
  "journalArticle", "book", "bookSection", "conferencePaper",
  "thesis", "webpage", "report", "preprint", "magazineArticle",
  "newspaperArticle", "blogPost", "presentation", "document", "note",
]);

export const ITEMS_TOOL = {
  name: "zotero_items",
  description: [
    "CRUD on items in your Zotero library (synced via api.zotero.org). Actions:",
    "Read: search / list / top_level / get",
    "Write single: create / update / delete",
    "Write bulk: bulk_create / bulk_update / bulk_delete (each up to 50 items)",
    "Tag ops: add_tags / remove_tags (single) + bulk_tag_add / bulk_tag_remove (many items, same tags)",
    "Collection ops: add_to_collection / remove_from_collection / move_to_collection (single) + bulk_move_to_collection (many)",
    "Updates accept both schema'd fields (title, creators, DOI, tags, collections, etc.) AND arbitrary extras via `extra_fields` (for type-specific fields like ISBN, pages, publisher, volume, issue).",
    "Item keys are 8 chars. Versions are per-item monotonic counters for optimistic concurrency.",
  ].join(" "),
} as const;

const Creator = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  name: z.string().optional().describe("For single-name entities (e.g. organizations) use `name` instead of first/last."),
  creatorType: z.string().default("author").describe("e.g. 'author', 'editor', 'translator'"),
});

const ItemSpec = z.object({
  itemType: CommonItemType.or(z.string()).describe("Zotero item type (e.g. journalArticle, book, webpage)."),
  title: z.string(),
  creators: z.array(Creator).optional(),
  abstractNote: z.string().optional(),
  publicationTitle: z.string().optional().describe("Journal / book / site name."),
  date: z.string().optional().describe("Free-form date string, Zotero parses e.g. '2024-06-15' or 'June 2024'."),
  DOI: z.string().optional(),
  url: z.string().url().optional(),
  tags: z.array(z.string()).optional().describe("Tag names; Zotero creates them on demand."),
  collections: z.array(z.string()).optional().describe("Array of collection keys to assign."),
  extra: z.string().optional().describe("Free-form notes field (used for Citation Key, PMID, arXiv ID etc.)."),
});

// For partial updates — all base fields optional plus a catch-all for
// item-type-specific fields (ISBN, pages, volume, publisher, etc.).
const FieldsPatch = ItemSpec.partial().extend({
  extra_fields: z.record(z.any()).optional().describe("Any Zotero field not in the base schema (ISBN, volume, issue, pages, publisher, journalAbbreviation, etc.). Passed straight through to the API."),
});

export const ItemsInput = z.discriminatedUnion("action", [
  // ---- Read ----
  z.object({
    action: z.literal("search"),
    query: z.string().min(1),
    qmode: z.enum(["titleCreatorYear", "everything"]).default("titleCreatorYear"),
    item_type: CommonItemType.or(z.string()).optional(),
    tag: z.string().optional().describe("Restrict to items with this tag."),
    collection: z.string().optional().describe("Restrict to a collection key."),
    limit: z.number().int().min(1).max(100).default(25),
    start: z.number().int().min(0).default(0),
  }),
  z.object({
    action: z.literal("list"),
    limit: z.number().int().min(1).max(100).default(25),
    start: z.number().int().min(0).default(0),
    sort: z.string().optional().describe("e.g. 'dateAdded', 'title', 'creator'"),
    direction: z.enum(["asc", "desc"]).default("desc"),
  }),
  z.object({
    action: z.literal("top_level"),
    limit: z.number().int().min(1).max(100).default(25),
    start: z.number().int().min(0).default(0),
    item_type: CommonItemType.or(z.string()).optional(),
    sort: z.string().optional(),
    direction: z.enum(["asc", "desc"]).default("desc"),
  }),
  z.object({
    action: z.literal("get"),
    key: z.string().length(8),
  }),
  // ---- Write single ----
  z.object({
    action: z.literal("create"),
    item: ItemSpec,
  }),
  z.object({
    action: z.literal("bulk_create"),
    items: z.array(ItemSpec).min(1).max(50),
  }),
  z.object({
    action: z.literal("update"),
    key: z.string().length(8),
    fields: FieldsPatch,
    version: z.number().int().optional().describe("If-Unmodified-Since-Version for concurrency. Omit to force."),
  }),
  z.object({
    action: z.literal("bulk_update"),
    updates: z.array(z.object({
      key: z.string().length(8),
      fields: FieldsPatch,
    })).min(1).max(50).describe("Each entry: {key, fields}. Zotero's POST /items accepts an array."),
  }),
  z.object({
    action: z.literal("delete"),
    key: z.string().length(8),
    version: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("bulk_delete"),
    keys: z.array(z.string().length(8)).min(1).max(50),
  }),
  // ---- Tag mutations (per-item, convenience over update) ----
  z.object({
    action: z.literal("add_tags"),
    key: z.string().length(8),
    tags: z.array(z.string()).min(1),
  }),
  z.object({
    action: z.literal("remove_tags"),
    key: z.string().length(8),
    tags: z.array(z.string()).min(1),
  }),
  z.object({
    action: z.literal("bulk_tag_add"),
    keys: z.array(z.string().length(8)).min(1).max(50),
    tags: z.array(z.string()).min(1).describe("Tags to add to EACH item (existing tags preserved)."),
  }),
  z.object({
    action: z.literal("bulk_tag_remove"),
    keys: z.array(z.string().length(8)).min(1).max(50),
    tags: z.array(z.string()).min(1),
  }),
  // ---- Collection operations ----
  z.object({
    action: z.literal("add_to_collection"),
    key: z.string().length(8),
    collection_key: z.string().length(8),
  }),
  z.object({
    action: z.literal("remove_from_collection"),
    key: z.string().length(8),
    collection_key: z.string().length(8),
  }),
  z.object({
    action: z.literal("move_to_collection"),
    key: z.string().length(8),
    collection_key: z.string().length(8).describe("Destination. REPLACES all current collections with just this one."),
  }),
  z.object({
    action: z.literal("bulk_move_to_collection"),
    keys: z.array(z.string().length(8)).min(1).max(50),
    collection_key: z.string().length(8),
    mode: z.enum(["replace", "add"]).default("add").describe("'add' = add items to the target collection, keep existing memberships. 'replace' = set each item's collection list to just [target]."),
  }),
]);

export async function handleItems(client: ZoteroClient, input: z.infer<typeof ItemsInput>) {
  switch (input.action) {
    // ---- Read paths ----
    case "search":
    case "list":
    case "top_level": {
      const params = new URLSearchParams();
      if (input.action === "search") {
        params.set("q", input.query);
        params.set("qmode", input.qmode);
      }
      const anyInput = input as any;
      params.set("limit", String(anyInput.limit));
      params.set("start", String(anyInput.start));
      if (anyInput.sort) params.set("sort", anyInput.sort);
      if (anyInput.direction) params.set("direction", anyInput.direction);
      if (anyInput.item_type) params.set("itemType", anyInput.item_type);
      if (anyInput.tag) params.set("tag", anyInput.tag);

      let path: string;
      if (input.action === "top_level") {
        path = client.userPath(`/items/top?${params}`);
      } else if (input.action === "search" && anyInput.collection) {
        path = client.userPath(`/collections/${anyInput.collection}/items/top?${params}`);
      } else {
        path = client.userPath(`/items?${params}`);
      }

      const { data, headers } = await client.get<any[]>(path);
      const total = Number(headers.get("total-results") ?? data.length);
      return {
        total,
        count: data.length,
        items: data.map(compactItem),
      };
    }

    case "get": {
      const { data } = await client.get(client.userPath(`/items/${input.key}`));
      return data;
    }

    // ---- Write single ----
    case "create": {
      const { data } = await client.post(client.userPath("/items"), [buildItem(input.item)]);
      return parseWriteResult(data);
    }

    case "bulk_create": {
      const { data } = await client.post(client.userPath("/items"), input.items.map(buildItem));
      return parseWriteResult(data);
    }

    case "update": {
      const headers = await ifUnmodifiedHeaders(client, `/items/${input.key}`, input.version);
      const payload = buildUpdatePayload(input.fields);
      await client.patch(client.userPath(`/items/${input.key}`), payload, headers);
      return { updated: input.key };
    }

    case "bulk_update": {
      // Zotero's POST /items endpoint accepts an array of items to create
      // OR update — if a `key` is present, it's treated as an update, and
      // (unlike single-item PATCH) it takes the version as a `version`
      // property per object rather than a shared header. Resolved in
      // parallel; an item whose version can't be resolved is reported as a
      // failure rather than sent to Zotero, where it would just 428.
      const versions = await runBounded(input.updates, 8, (u) =>
        resolveVersion(client, client.userPath(`/items/${u.key}`)));
      const payload: any[] = [];
      const resolveFailures: any[] = [];
      input.updates.forEach((u, i) => {
        const v = versions[i];
        if (!v.ok) { resolveFailures.push({ key: u.key, error: v.error ?? "couldn't resolve current version" }); return; }
        payload.push({ key: u.key, version: v.result, ...buildUpdatePayload(u.fields) });
      });
      if (payload.length === 0) return { succeeded: 0, failed: resolveFailures.length, keys: [], failures: resolveFailures };
      const { data } = await client.post(client.userPath("/items"), payload);
      const result = parseWriteResult(data);
      return { ...result, failed: result.failed + resolveFailures.length, failures: [...result.failures, ...resolveFailures] };
    }

    case "delete": {
      const headers = await ifUnmodifiedHeaders(client, `/items/${input.key}`, input.version);
      await client.delete(client.userPath(`/items/${input.key}`), headers);
      return { deleted: input.key };
    }

    case "bulk_delete": {
      // DELETE /items?itemKey=K1,K2,...  — up to 50 per call. No per-item
      // version check available on this endpoint, so nothing to send here
      // (see ifUnmodifiedHeaders for why "*" doesn't work).
      await client.delete(client.userPath(`/items?itemKey=${input.keys.join(",")}`));
      return { deleted: input.keys.length, keys: input.keys };
    }

    // ---- Tag ops ----
    case "add_tags":
    case "remove_tags":
      return mutateTags(client, input.key, input.tags, input.action === "add_tags" ? "add" : "remove");

    case "bulk_tag_add":
    case "bulk_tag_remove": {
      const keys = input.keys;
      const tags = input.tags;
      const op: "add" | "remove" = input.action === "bulk_tag_add" ? "add" : "remove";
      const results = await runBounded(keys, 4, (k) => mutateTags(client, k, tags, op));
      return summarize(input.action, results);
    }

    // ---- Collection ops ----
    case "add_to_collection":
    case "remove_from_collection": {
      const { data: item } = await client.get<any>(client.userPath(`/items/${input.key}`));
      const version = item?.version ?? item?.data?.version;
      const current: string[] = item?.data?.collections ?? [];
      let next: string[];
      if (input.action === "add_to_collection") {
        next = current.includes(input.collection_key) ? current : [...current, input.collection_key];
      } else {
        next = current.filter((c) => c !== input.collection_key);
      }
      await client.patch(
        client.userPath(`/items/${input.key}`),
        { collections: next },
        { "If-Unmodified-Since-Version": String(version) },
      );
      return { key: input.key, collections: next };
    }

    case "move_to_collection": {
      const { data: item } = await client.get<any>(client.userPath(`/items/${input.key}`));
      const version = item?.version ?? item?.data?.version;
      await client.patch(
        client.userPath(`/items/${input.key}`),
        { collections: [input.collection_key] },
        { "If-Unmodified-Since-Version": String(version) },
      );
      return { key: input.key, collections: [input.collection_key] };
    }

    case "bulk_move_to_collection": {
      const { keys, collection_key, mode } = input;
      const results = await runBounded(keys, 4, async (k) => {
        const { data: item } = await client.get<any>(client.userPath(`/items/${k}`));
        const version = item?.version ?? item?.data?.version;
        const current: string[] = item?.data?.collections ?? [];
        const next = mode === "replace"
          ? [collection_key]
          : (current.includes(collection_key) ? current : [...current, collection_key]);
        await client.patch(
          client.userPath(`/items/${k}`),
          { collections: next },
          { "If-Unmodified-Since-Version": String(version) },
        );
        return { key: k, collections: next };
      });
      return summarize(`bulk_move_to_collection (${mode})`, results);
    }
  }
}

// ----- helpers -----

// Zotero requires this header for single-item update/delete — it's not
// optional the way "optimistic concurrency" suggests, and there's no
// wildcard to skip the check ("*" 400s, omitting it 428s; both found by
// actually calling it). When the caller doesn't supply a version ("omit to
// force"), this fetches the item's current one so the write goes through.
async function ifUnmodifiedHeaders(client: ZoteroClient, path: string, version?: number): Promise<Record<string, string>> {
  const v = version !== undefined ? version : await resolveVersion(client, client.userPath(path));
  return { "If-Unmodified-Since-Version": String(v) };
}

async function mutateTags(
  client: ZoteroClient,
  key: string,
  tags: string[],
  op: "add" | "remove",
): Promise<{ key: string; tags: string[] }> {
  const { data: item } = await client.get<any>(client.userPath(`/items/${key}`));
  const version = item?.version ?? item?.data?.version;
  const existing: Array<{ tag: string }> = item?.data?.tags ?? [];
  const incoming = new Set(tags);
  let next: Array<{ tag: string }>;
  if (op === "add") {
    const merged = new Set(existing.map((t) => t.tag));
    for (const t of incoming) merged.add(t);
    next = [...merged].map((tag) => ({ tag }));
  } else {
    next = existing.filter((t) => !incoming.has(t.tag));
  }
  await client.patch(
    client.userPath(`/items/${key}`),
    { tags: next },
    { "If-Unmodified-Since-Version": String(version) },
  );
  return { key, tags: next.map((t) => t.tag) };
}

function summarize(action: string, results: Array<{ ok: boolean; item: any; result?: any; error?: string }>) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  return {
    action,
    total: results.length,
    succeeded: ok.length,
    failed: bad.length,
    results: ok.map((r) => r.result),
    failures: bad.map((r) => ({ item: r.item, error: r.error })),
  };
}

function buildItem(spec: z.infer<typeof ItemSpec>) {
  const payload: any = {
    itemType: spec.itemType,
    title: spec.title,
  };
  if (spec.creators) payload.creators = spec.creators.map((c) => ({ creatorType: c.creatorType ?? "author", firstName: c.firstName, lastName: c.lastName, name: c.name }));
  if (spec.abstractNote !== undefined) payload.abstractNote = spec.abstractNote;
  if (spec.publicationTitle !== undefined) payload.publicationTitle = spec.publicationTitle;
  if (spec.date !== undefined) payload.date = spec.date;
  if (spec.DOI !== undefined) payload.DOI = spec.DOI;
  if (spec.url !== undefined) payload.url = spec.url;
  if (spec.extra !== undefined) payload.extra = spec.extra;
  if (spec.tags) payload.tags = spec.tags.map((t) => ({ tag: t }));
  if (spec.collections) payload.collections = spec.collections;
  return payload;
}

function buildUpdatePayload(fields: z.infer<typeof FieldsPatch>): any {
  const payload: any = {};
  if (fields.itemType !== undefined) payload.itemType = fields.itemType;
  if (fields.title !== undefined) payload.title = fields.title;
  if (fields.creators !== undefined) {
    payload.creators = fields.creators.map((c) => ({ creatorType: c.creatorType ?? "author", firstName: c.firstName, lastName: c.lastName, name: c.name }));
  }
  if (fields.abstractNote !== undefined) payload.abstractNote = fields.abstractNote;
  if (fields.publicationTitle !== undefined) payload.publicationTitle = fields.publicationTitle;
  if (fields.date !== undefined) payload.date = fields.date;
  if (fields.DOI !== undefined) payload.DOI = fields.DOI;
  if (fields.url !== undefined) payload.url = fields.url;
  if (fields.extra !== undefined) payload.extra = fields.extra;
  if (fields.tags !== undefined) payload.tags = fields.tags.map((t) => ({ tag: t }));
  if (fields.collections !== undefined) payload.collections = fields.collections;
  if (fields.extra_fields) {
    Object.assign(payload, fields.extra_fields);
  }
  return payload;
}

function compactItem(item: any) {
  const d = item.data ?? {};
  return {
    key: d.key ?? item.key,
    version: d.version ?? item.version,
    item_type: d.itemType,
    title: d.title,
    creators: (d.creators ?? []).map((c: any) => c.name ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()),
    date: d.date,
    publication: d.publicationTitle,
    DOI: d.DOI,
    url: d.url,
    tags: (d.tags ?? []).map((t: any) => t.tag),
    collections: d.collections ?? [],
    added: d.dateAdded,
  };
}

function parseWriteResult(data: any) {
  const success = data?.successful ?? {};
  const failed = data?.failed ?? {};
  return {
    succeeded: Object.keys(success).length,
    failed: Object.keys(failed).length,
    keys: Object.values(success).map((v: any) => v?.data?.key).filter(Boolean),
    failures: Object.values(failed),
  };
}
