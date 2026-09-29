import { z } from "zod";
import type { ZoteroClient } from "../zotero-client.js";
import { runBounded, resolveVersion } from "../zotero-client.js";

// Zotero notes are ITEMS of type "note" with parentItem set. The note body
// is stored in `note` as HTML (Zotero's note editor produces HTML). Plain
// text works too — Zotero just renders it verbatim.

export const NOTES_TOOL = {
  name: "zotero_notes",
  description: [
    "Work with standalone notes or notes attached to Zotero items. Requires \"Allow notes access\" " +
    "on your API key (a separate checkbox from library access, at zotero.org/settings/keys) — without " +
    "it, Zotero's API reports add/bulk_add as successful but the note is never actually saved. Actions:",
    "• list — all notes attached to a parent item (paper/book).",
    "• get — a single note by its item key (returns html content).",
    "• add — attach a new note to a parent item. Pass plain text or HTML in `body`.",
    "• bulk_add — attach multiple notes to the same parent (up to 50).",
    "• update — edit a note's body.",
    "• delete — remove a note.",
    "Zotero treats notes as items of itemType=note with parentItem set; each has its own key.",
  ].join(" "),
} as const;

export const NotesInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    item_key: z.string().length(8).describe("Parent item key (the paper/book the notes are attached to)."),
  }),
  z.object({
    action: z.literal("get"),
    key: z.string().length(8).describe("The note's own item key."),
  }),
  z.object({
    action: z.literal("add"),
    item_key: z.string().length(8).describe("Parent item key."),
    body: z.string().min(1).describe("Note content (plain text or HTML)."),
    tags: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal("bulk_add"),
    item_key: z.string().length(8),
    notes: z.array(z.object({
      body: z.string().min(1),
      tags: z.array(z.string()).optional(),
    })).min(1).max(50),
  }),
  z.object({
    action: z.literal("update"),
    key: z.string().length(8),
    body: z.string().min(1),
    version: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("delete"),
    key: z.string().length(8),
    version: z.number().int().optional(),
  }),
]);

export async function handleNotes(client: ZoteroClient, input: z.infer<typeof NotesInput>) {
  switch (input.action) {
    case "list": {
      const { data } = await client.get<any[]>(client.userPath(`/items/${input.item_key}/children`));
      const notes = (data ?? [])
        .filter((it: any) => it.data?.itemType === "note")
        .map(compactNote);
      return {
        item_key: input.item_key,
        count: notes.length,
        notes,
      };
    }

    case "get": {
      const { data } = await client.get(client.userPath(`/items/${input.key}`));
      return data;
    }

    case "add": {
      const payload = buildNote(input.item_key, input.body, input.tags);
      const { data } = await client.post(client.userPath("/items"), [payload]);
      return parseWriteResult(data);
    }

    case "bulk_add": {
      const payload = input.notes.map((n) => buildNote(input.item_key, n.body, n.tags));
      const { data } = await client.post(client.userPath("/items"), payload);
      return parseWriteResult(data);
    }

    case "update": {
      // Zotero requires this header (or a real version — "*" and omitting
      // it both fail); fetch the current version when the caller didn't
      // supply one. Notes are items under the hood, same endpoint shape.
      const version = input.version !== undefined ? input.version : await resolveVersion(client, client.userPath(`/items/${input.key}`));
      const headers = { "If-Unmodified-Since-Version": String(version) };
      await client.patch(client.userPath(`/items/${input.key}`), { note: input.body }, headers);
      return { updated: input.key };
    }

    case "delete": {
      const version = input.version !== undefined ? input.version : await resolveVersion(client, client.userPath(`/items/${input.key}`));
      const headers = { "If-Unmodified-Since-Version": String(version) };
      await client.delete(client.userPath(`/items/${input.key}`), headers);
      return { deleted: input.key };
    }
  }
}

function buildNote(parentKey: string, body: string, tags?: string[]) {
  const payload: any = {
    itemType: "note",
    parentItem: parentKey,
    note: body,
  };
  if (tags) payload.tags = tags.map((t) => ({ tag: t }));
  return payload;
}

function compactNote(it: any) {
  const d = it.data ?? {};
  // Strip HTML for a preview; Zotero's note editor produces <div>/<p>.
  const preview = (d.note || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    key: d.key,
    version: d.version,
    parent: d.parentItem,
    preview,
    tags: (d.tags ?? []).map((t: any) => t.tag),
    date_modified: d.dateModified,
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
