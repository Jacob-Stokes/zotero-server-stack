// Zotero Web API v3 client. Auth via a personal API key from
// https://www.zotero.org/settings/keys. All calls target api.zotero.org —
// the library state reflected is the user's synced cloud library, which
// the Zotero desktop (self-hosted or native) keeps in sync.
//
// Docs: https://www.zotero.org/support/dev/web_api/v3/start

export class ZoteroError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly detail: any,
  ) {
    super(`${method} ${path} → ${status}`);
  }
}

export class ZoteroClient {
  constructor(
    private baseUrl: string,
    private userId: string | number,
    private token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Prefix a library-relative path with /users/<id>. */
  userPath(suffix: string): string {
    return `/users/${this.userId}${suffix.startsWith("/") ? suffix : "/" + suffix}`;
  }

  private async req<T = any>(method: string, path: string, body?: any, extraHeaders: Record<string, string> = {}): Promise<{ data: T; headers: Headers }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Zotero-API-Version": "3",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const raw = res.status === 204 ? "" : await res.text();
    if (!res.ok) {
      let detail: any;
      try { detail = raw ? JSON.parse(raw) : ""; } catch { detail = raw; }
      throw new ZoteroError(method, path, res.status, detail);
    }
    if (!raw) return { data: undefined as any, headers: res.headers };
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? JSON.parse(raw) : raw;
    return { data: data as T, headers: res.headers };
  }

  get<T = any>(path: string) { return this.req<T>("GET", path); }
  post<T = any>(path: string, body: any, headers: Record<string, string> = {}) { return this.req<T>("POST", path, body, headers); }
  put<T = any>(path: string, body: any, headers: Record<string, string> = {}) { return this.req<T>("PUT", path, body, headers); }
  patch<T = any>(path: string, body: any, headers: Record<string, string> = {}) { return this.req<T>("PATCH", path, body, headers); }
  delete<T = any>(path: string, headers: Record<string, string> = {}) { return this.req<T>("DELETE", path, undefined, headers); }
}

/**
 * Zotero requires If-Unmodified-Since-Version on single-item update/delete —
 * it's not optional the way its docs' wording ("optimistic concurrency")
 * suggests, and there's no wildcard to skip the check (Zotero rejects "*"
 * outright; found by calling it). When the caller doesn't supply a version
 * ("omit to force"), this fetches the item's current one so the write goes
 * through as an unconditional-in-practice write, not a real optimistic-lock
 * check — there's a race if something else modifies the item in between,
 * the same as any other "last write wins" default would have.
 */
export async function resolveVersion(client: ZoteroClient, path: string): Promise<number> {
  const { data } = await client.get<{ version: number }>(path);
  return data.version;
}

export async function runBounded<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<{ ok: boolean; item: T; result?: R; error?: string }>> {
  const out: Array<{ ok: boolean; item: T; result?: R; error?: string }> = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = { ok: true, item: items[i], result: await fn(items[i]) }; }
      catch (e: any) { out[i] = { ok: false, item: items[i], error: e?.message ?? String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
