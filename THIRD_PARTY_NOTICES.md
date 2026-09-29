# Third-party notices

## services/zotero-mcp/

Our own code, not vendored from anywhere. It talks to
[Zotero's Web API v3](https://www.zotero.org/support/dev/web_api/v3/start)
over HTTPS, using an API key you generate yourself — nothing from Zotero is
bundled or redistributed.

## extras/zotero-desktop/

Our own compose file, not vendored. It runs
[`lscr.io/linuxserver/zotero`](https://github.com/linuxserver/docker-zotero),
linuxserver.io's own image, pulled at `docker compose up` rather than built
or bundled here. Zotero itself is free, open-source software
([GPLv3](https://github.com/zotero/zotero/blob/master/LICENSE)); linuxserver.io
publish and maintain that image independently of this repo.

## Everything else

Everything not listed above — the installer, the compose files, the
Dockerfiles — is original to this repo, MIT licensed (see [LICENSE](LICENSE)).
