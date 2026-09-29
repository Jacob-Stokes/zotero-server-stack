# Zotero desktop (optional)

The MCP talks to Zotero's own cloud directly, so it works with or without this. Add it if you also want:

- A GUI to browse, organise and add papers to your library from a browser.
- To open PDFs — the MCP can only return an attachment's extracted text, not the file itself (see the root README's Tools section for why).
- Community plugins (Better BibTeX, translators, ZotMoov, ...) — none of that exists through the Web API, only in a real Zotero.
- Somewhere for the Zotero Connector browser extension to save into, if your other devices aren't always open.
- Continuous PDF text extraction. `zotero_attachments get_text` only has text to return once *some* Zotero client has indexed that PDF — if your other devices are often closed, this is what keeps that happening.

It's the same [linuxserver.io Zotero image](https://github.com/linuxserver/docker-zotero) used elsewhere for this. Zotero itself is free software; this image isn't built or bundled here, it's pulled at `docker compose up`.

## Setup

```bash
cp .env.example .env
docker compose up -d
```

Open `https://localhost:3001` (self-signed certificate — your browser will warn, that's expected) and sign in to your Zotero account once. It stays signed in after that, the same account and library the MCP already sees, kept in sync by Zotero's own cloud.

It only listens on localhost. To reach it from another device, see the root README's "Reaching the MCP" section — the same options (Tailscale, Cloudflare Tunnel, a reverse proxy) work here too.

## Uninstalling

```bash
docker compose down -v
```

`-v` deletes the local Zotero profile/cache. Your library isn't stored here — it stays in Zotero's cloud and comes back on next sign-in.
