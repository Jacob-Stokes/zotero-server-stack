import { startMcp } from "./lib/transport.js";
import { ZoteroClient, ZoteroError } from "./zotero-client.js";
import { ITEMS_TOOL, ItemsInput, handleItems } from "./tools/items.js";
import { COLLECTIONS_TOOL, CollectionsInput, handleCollections } from "./tools/collections.js";
import { ATTACHMENTS_TOOL, AttachmentsInput, handleAttachments } from "./tools/attachments.js";
import { NOTES_TOOL, NotesInput, handleNotes } from "./tools/notes.js";
import { TAGS_TOOL, TagsInput, handleTags } from "./tools/tags.js";

const PORT = parseInt(process.env.PORT || "7012", 10);
const ZOTERO_BASE_URL = process.env.ZOTERO_BASE_URL || "https://api.zotero.org";

const ZOTERO_USER_ID = process.env.ZOTERO_USER_ID;
if (!ZOTERO_USER_ID) { console.error("FATAL: ZOTERO_USER_ID env var required — see .env.example"); process.exit(1); }

const ZOTERO_API_TOKEN = process.env.ZOTERO_API_TOKEN;
if (!ZOTERO_API_TOKEN) { console.error("FATAL: ZOTERO_API_TOKEN env var required — see .env.example"); process.exit(1); }

const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;
if (!MCP_BEARER_TOKEN) { console.error("FATAL: MCP_BEARER_TOKEN env var required — see .env.example"); process.exit(1); }

const client = new ZoteroClient(ZOTERO_BASE_URL, ZOTERO_USER_ID, ZOTERO_API_TOKEN);

// Fail fast on a bad key/user ID rather than serving broken tools.
try {
  const { data } = await client.get<any>(`/keys/${ZOTERO_API_TOKEN}`);
  console.log(`zotero connectivity: ok (${ZOTERO_BASE_URL}, user=${data.username}, id=${data.userID})`);
} catch (e: any) {
  console.error(`zotero connectivity FAILED at ${ZOTERO_BASE_URL}:`, e.message);
  console.error("Check ZOTERO_USER_ID and ZOTERO_API_TOKEN in .env.");
  process.exit(1);
}

// OAuth is opt-in. Set MCP_OAUTH_ISSUER + MCP_OAUTH_CANONICAL_URL to enable.
// The static bearer token keeps working either way.
const oauth = process.env.MCP_OAUTH_ISSUER
  ? {
      issuer: process.env.MCP_OAUTH_ISSUER,
      canonicalUrl: process.env.MCP_OAUTH_CANONICAL_URL!,
      jwksUri: process.env.MCP_OAUTH_JWKS_URI || undefined,
      audience: process.env.MCP_OAUTH_AUDIENCE || undefined,
      scopesSupported: (process.env.MCP_OAUTH_SCOPES || "openid email profile offline_access").split(/\s+/),
    }
  : undefined;

await startMcp({
  name: "zotero-mcp",
  version: "1.0.0",
  port: PORT,
  bearerToken: MCP_BEARER_TOKEN,
  oauth,
  instructions:
    "This is a remote MCP server over your Zotero library, via Zotero's own Web API v3 — the same cloud your Zotero apps sync through. " +
    "Attachment file bytes aren't available here (the Web API doesn't serve them); zotero_attachments returns extracted full text instead, " +
    "which Zotero desktop indexes and syncs automatically.",
  tools: [
    { def: { ...ITEMS_TOOL,       inputSchema: ItemsInput },       handler: (i) => handleItems(client, i) },
    { def: { ...COLLECTIONS_TOOL, inputSchema: CollectionsInput }, handler: (i) => handleCollections(client, i) },
    { def: { ...ATTACHMENTS_TOOL, inputSchema: AttachmentsInput }, handler: (i) => handleAttachments(client, i) },
    { def: { ...NOTES_TOOL,       inputSchema: NotesInput },       handler: (i) => handleNotes(client, i) },
    { def: { ...TAGS_TOOL,        inputSchema: TagsInput },        handler: (i) => handleTags(client, i) },
  ],
  onBackendError: (e) => {
    if (e instanceof ZoteroError) {
      return `zotero error: ${e.method} ${e.path} → HTTP ${e.status}: ${JSON.stringify(e.detail).slice(0, 200)}`;
    }
    return null;
  },
});
