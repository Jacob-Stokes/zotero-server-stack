# Zotero desktop (optional)

The MCP talks to Zotero's own cloud directly, so it works with or without this. It adds:

- A GUI for browsing, organising and adding papers from a browser.
- PDF viewing. The MCP returns only an attachment's extracted text, not the file (see the root README's Tools section).
- Community plugins such as Better BibTeX, translators and ZotMoov, which are not available through the Web API.
- A target for the Zotero Connector browser extension to save into when no other Zotero client is running.
- Continuous PDF text extraction. `zotero_attachments get_text` has text to return only after a Zotero client has indexed the PDF; this keeps indexing running when other devices are offline.

It uses the [linuxserver.io Zotero image](https://github.com/linuxserver/docker-zotero), pulled at `docker compose up` rather than built or bundled here.

## Setup

```bash
cp .env.example .env
docker compose up -d
```

Open `https://localhost:3001` (a self-signed certificate, so the browser shows a warning) and sign in to the Zotero account once. It stays signed in afterwards and syncs the same library the MCP reads, through Zotero's cloud.

It listens on localhost only. The remote-access options in the root README's "Reaching the MCP" section (Tailscale, Cloudflare Tunnel, a reverse proxy) apply here too.

## Uninstalling

```bash
docker compose down -v
```

`-v` deletes the local Zotero profile and cache. The library itself is not stored here; it remains in Zotero's cloud and syncs back on the next sign-in.
