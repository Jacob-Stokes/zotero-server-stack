<h1 align="center">Zotero Server Stack</h1>

<p align="center">Your Zotero library, reachable over MCP, from a server you run yourself.</p>

Zotero already keeps your library synced through its own free cloud API — no separate sync setup needed here, unlike a lot of other "put my notes on a server" stacks. This is a small MCP server that talks to that same API, so any MCP client can read and write your citations, collections, tags and notes. It runs as one container, with your own Zotero API key, and nothing about your library lives in this repo.

## Install

```bash
git clone https://github.com/Jacob-Stokes/zotero-server-stack.git
cd zotero-server-stack
./install.sh
```

You need Linux with Docker (Compose v2), `openssl` and `curl`. The installer creates the secrets, asks for your Zotero user ID and an API key (both come from [zotero.org/settings/keys](https://www.zotero.org/settings/keys)), and starts the MCP. At the end you have an MCP endpoint at `http://localhost:7012/mcp`, and the bearer token for it is in `.env`. You can run it again at any time.

To run a second copy on the same machine, give it its own prefix and port before running `./install.sh`:

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
| [`zotero-desktop`](extras/zotero-desktop) | The real Zotero app in a browser tab. Only useful for browsing your library by eye, or opening a PDF — the MCP can't return file bytes (see [Tools](#tools)). Set up separately; the MCP works fully without it. |

## Reaching the MCP

The MCP only listens on `localhost:7012`. To use it from anywhere else you need to bring your own way in. Some options:

- [Tailscale Serve](https://tailscale.com/kb/1312/serve): your own devices only. `tailscale serve --bg 7012`
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel): public URL, needed for web-based clients. `tailscale funnel --bg 7012`
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/): public URL on your own domain, no open ports
- A reverse proxy such as [Caddy](https://caddyserver.com) or [nginx](https://nginx.org), if the server has a public IP

Clients send `Authorization: Bearer <MCP_BEARER_TOKEN>`. For clients that need an OAuth login instead, fill in the `MCP_OAUTH_*` settings in `.env`. Anything public is protected only by that token, so keep it private.

## Updating and uninstalling

To update, run `git pull && ./install.sh`. Your `.env` is kept.

To uninstall, run `docker compose down`. Nothing about your library lives in this repo or its volumes — it's all in Zotero's own cloud — so there's nothing local to back up or lose.

## Tools

All tool names start with `zotero_`.

| Tool | Covers |
|---|---|
| `zotero_items` | Search, list, and full CRUD on items — single or bulk (up to 50 at a time), including tags and collection moves |
| `zotero_collections` | List, browse as a tree, and manage collections (folders) |
| `zotero_attachments` | List an item's attachments and read their extracted full text |
| `zotero_notes` | Read, add, update and delete notes, standalone or attached to an item — needs "Allow notes access" on your API key (see below) |
| `zotero_tags` | Library-wide tag listing, search, rename and delete |

**No attachment file bytes.** Zotero's Web API doesn't serve the actual PDF/file content — only metadata and, once Zotero desktop has indexed it, the extracted full text. `zotero_attachments` returns that text, which is enough for an MCP client to read and summarize a paper. To open the file itself, use [`extras/zotero-desktop`](extras/zotero-desktop) or your own Zotero app.

**Notes need a second permission.** Your API key's "Allow library access" doesn't cover notes — there's a separate "Allow notes access" checkbox when you create the key. Without it, we've seen Zotero's API report `zotero_notes add`/`bulk_add` as successful (a real key, a real version number) while the note is never actually saved — no error, nothing in the library, nothing in trash. If notes you add aren't showing up, this is almost certainly why: check the key's permissions at [zotero.org/settings/keys](https://www.zotero.org/settings/keys).

## License

MIT. Zotero's own desktop app, used only by the optional `extras/zotero-desktop`, isn't built or bundled here — it's pulled from [linuxserver.io's image](https://github.com/linuxserver/docker-zotero) at `docker compose up`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
