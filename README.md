<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.gif">
    <img src="assets/logo-light.gif" alt="Zotero Server Stack logo" width="90">
  </picture>
</p>

<h1 align="center">Zotero Server Stack</h1>

<p align="center">A Zotero library, reachable over MCP from a self-hosted server.</p>

Zotero already keeps libraries synced through its free cloud API, so unlike most self-hosted note stacks there is no sync layer to set up. This is a small MCP server over that same API, giving any MCP client read and write access to citations, collections, tags and notes. It runs as a single container using a Zotero API key, and no library data is stored locally.

## Install

```bash
git clone https://github.com/Jacob-Stokes/zotero-server-stack.git
cd zotero-server-stack
./install.sh
```

Requires Linux with Docker (Compose v2), `openssl` and `curl`. The installer generates secrets, prompts for a Zotero user ID and API key (both from [zotero.org/settings/keys](https://www.zotero.org/settings/keys)) and starts the MCP. Once finished, the MCP endpoint is at `http://localhost:7012/mcp`, with its bearer token in `.env`. The installer is safe to re-run.

To run a second instance on the same machine, set a prefix and port before running `./install.sh`:

```bash
cp .env.example .env
sed -i 's/^INSTANCE_PREFIX=.*/INSTANCE_PREFIX=test-/; s/^MCP_PORT=.*/MCP_PORT=7112/' .env
```

## Containers

Always installed — just this one:

| Container | Job |
|---|---|
| `zotero-mcp` | MCP server. Talks to `api.zotero.org` directly — no vault, no sync backend to pick, nothing else running. |

Optional, not installed by `./install.sh`:

| Container | Job |
|---|---|
| [`zotero-desktop`](extras/zotero-desktop) | The real Zotero app in a browser tab. Useful for browsing the library visually or opening a PDF — the MCP can't return file bytes (see [Tools](#tools)). Set up separately; the MCP works fully without it. |

## Reaching the MCP

The MCP listens on `localhost:7012` only. Remote access is left to an existing tool, such as:

- [Tailscale Serve](https://tailscale.com/kb/1312/serve): private to the tailnet. `tailscale serve --bg 7012`
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel): public URL, needed for web-based clients. `tailscale funnel --bg 7012`
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/): public URL on a custom domain, no open ports
- A reverse proxy such as [Caddy](https://caddyserver.com) or [nginx](https://nginx.org), if the server has a public IP

Clients authenticate with `Authorization: Bearer <MCP_BEARER_TOKEN>`. For clients that require an OAuth login, set the `MCP_OAUTH_*` values in `.env`. A public endpoint is protected only by that token.

## Updating and uninstalling

To update, run `git pull && ./install.sh`. The existing `.env` is preserved.

To uninstall, run `docker compose down`. No library data is stored in this repo or its volumes; it all remains in Zotero's cloud.

## Tools

All tool names start with `zotero_`.

| Tool | Covers |
|---|---|
| `zotero_items` | Search, list, and full CRUD on items — single or bulk (up to 50 at a time), including tags and collection moves |
| `zotero_collections` | List, browse as a tree, and manage collections (folders) |
| `zotero_attachments` | List an item's attachments and read their extracted full text |
| `zotero_notes` | Read, add, update and delete notes, standalone or attached to an item — requires "Allow notes access" on the API key (see below) |
| `zotero_tags` | Library-wide tag listing, search, rename and delete |

**No attachment file bytes.** Zotero's Web API doesn't serve the actual PDF/file content — only metadata and, once Zotero desktop has indexed it, the extracted full text. `zotero_attachments` returns that text, which is enough for an MCP client to read and summarize a paper. To open the file itself, use [`extras/zotero-desktop`](extras/zotero-desktop) or any other Zotero app.

**Notes need a separate permission.** An API key's "Allow library access" does not cover notes; "Allow notes access" is a separate checkbox when creating the key. Without it, Zotero's API reports `zotero_notes add`/`bulk_add` as successful, with a real key and version number, but the note is never saved. There is no error and nothing appears in the library or the trash. If added notes are missing, check the key's permissions at [zotero.org/settings/keys](https://www.zotero.org/settings/keys).

## License

MIT. Zotero's own desktop app, used only by the optional `extras/zotero-desktop`, isn't built or bundled here — it's pulled from [linuxserver.io's image](https://github.com/linuxserver/docker-zotero) at `docker compose up`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
