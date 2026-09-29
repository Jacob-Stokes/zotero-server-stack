import { z } from "zod";
import type { ZoteroClient } from "../zotero-client.js";

// Zotero attachments as exposed via the web API. For actual file bytes
// we rely on Zotero's own fulltext indexing — the desktop extracts
// PDF text and syncs just the index (not the file) to zotero.org.
// The web API then serves that text via /items/<attachment-key>/fulltext,
// which is the right shape for agent reading (no 1MB MCP resource cap,
// no binary transport, no filesystem mount needed).
//
// If you want the actual PDF binary, open the item in the Zotero desktop
// app — that's the separate UX path.

export const ATTACHMENTS_TOOL = {
  name: "zotero_attachments",
  description: [
    "Work with files attached to Zotero items (PDFs, HTML snapshots). Actions:",
    "• list — show attachments for an item (filename, type, link mode, etc.). Pass the parent item key.",
    "• get_text — fetch the extracted full text of a PDF/HTML attachment for reading/summarization. Pass either attachment_key directly, or parent item_key + index (defaults to first attachment of the item). Returns the indexed content + page count.",
    "Extraction happens on the Zotero desktop and is synced via zotero.org's fulltext index — the actual file bytes never leave your server. If `get_text` returns empty content, the item either hasn't been indexed yet (needs to open in desktop) or is a scanned/image-only PDF.",
  ].join(" "),
} as const;

export const AttachmentsInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    item_key: z.string().length(8).describe("Parent item key (the paper/book the files are attached to)."),
  }),
  z.object({
    action: z.literal("get_text"),
    attachment_key: z.string().length(8).optional().describe("Attachment item key (each file is its own item in Zotero)."),
    item_key: z.string().length(8).optional().describe("Alternative: parent item key + index to pick the index'th attachment."),
    index: z.number().int().min(0).default(0).describe("Used with item_key — which attachment of the parent to return."),
    max_chars: z.number().int().min(500).max(200_000).default(100_000).describe("Truncate the returned text if it exceeds this length (keeps responses tractable for very long docs)."),
  }),
]);

export async function handleAttachments(client: ZoteroClient, input: z.infer<typeof AttachmentsInput>) {
  switch (input.action) {
    case "list": {
      const { data } = await client.get<any[]>(client.userPath(`/items/${input.item_key}/children`));
      const attachments = (data ?? [])
        .filter((it: any) => it.data?.itemType === "attachment")
        .map(compactAttachment);
      return {
        item_key: input.item_key,
        count: attachments.length,
        attachments,
      };
    }

    case "get_text": {
      let attKey = input.attachment_key;
      let parentInfo: { item_key: string; index: number } | null = null;

      if (!attKey) {
        if (!input.item_key) throw new Error("either attachment_key or item_key is required");
        const { data } = await client.get<any[]>(client.userPath(`/items/${input.item_key}/children`));
        const attachments = (data ?? []).filter((it: any) => it.data?.itemType === "attachment");
        if (attachments.length === 0) throw new Error(`no attachments on item ${input.item_key}`);
        const picked = attachments[input.index];
        if (!picked) throw new Error(`item ${input.item_key} has only ${attachments.length} attachments (asked for index ${input.index})`);
        attKey = picked.data.key;
        parentInfo = { item_key: input.item_key, index: input.index };
      }

      const { data: ft } = await client.get<any>(client.userPath(`/items/${attKey}/fulltext`));
      const content: string = ft?.content ?? "";
      const truncated = content.length > input.max_chars;
      const body = truncated ? content.slice(0, input.max_chars) : content;

      return {
        attachment_key: attKey,
        ...(parentInfo ? { resolved_from: parentInfo } : {}),
        indexed_pages: ft?.indexedPages,
        total_pages: ft?.totalPages,
        indexed_chars: ft?.indexedChars,
        total_chars: ft?.totalChars,
        chars_returned: body.length,
        truncated,
        content: body,
        ...(content.length === 0 ? {
          note: "Fulltext is empty — the attachment hasn't been indexed yet (open the item in Zotero desktop to trigger indexing) or it's a scanned/image-only PDF without OCR.",
        } : {}),
      };
    }
  }
}

function compactAttachment(att: any) {
  const d = att.data ?? {};
  return {
    key: d.key,
    filename: d.filename,
    title: d.title,
    content_type: d.contentType,
    link_mode: d.linkMode,
    path: d.path,
  };
}
