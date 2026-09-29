// HTTP transport for MCP servers, with dual-auth + dual-transport support.
//
// Transports offered (same codebase, both endpoints):
//   - Streamable HTTP (/mcp)   — modern, used by ChatGPT, Claude.ai, Claude Desktop
//   - SSE + POST (/sse + /message) — legacy, kept for existing bot
//
// Auth modes (evaluated in order per request):
//   1. Static bearer   — `Authorization: Bearer <MCP_BEARER_TOKEN>`
//                        Used by the Telegram bot + Claude Code CLI on the host.
//                        Configured via `bearerToken` arg.
//   2. OAuth 2.1 JWT   — `Authorization: Bearer <JWT>`
//                        Used by remote clients (ChatGPT, Claude Desktop) via an
//                        authorization server (Authentik). Configured via `oauth`
//                        arg. If absent, OAuth mode is disabled.
//
// When OAuth is enabled:
//   - Publishes /.well-known/oauth-protected-resource (RFC 9728)
//   - 401 responses include WWW-Authenticate with resource_metadata URL
//   - JWT signature + audience + expiry validated via JWKS
//
// Each MCP calls `startMcp(opts)` at the end of its own server.ts boot.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { zodToJsonSchema } from "./schema.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  /** Standard MCP hints surfaced to clients. These are descriptive, not authorization controls. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ToolRegistration {
  def: ToolDefinition;
  handler: (input: any) => Promise<any>;
}

export interface OAuthOptions {
  /**
   * Canonical public URL of this MCP as served to external clients — used as
   * the JWT `aud` claim target and as the `resource` identifier in Protected
   * Resource Metadata (RFC 9728).
   *
   * e.g. "https://<name>-mcp.example.com"
   */
  canonicalUrl: string;
  /**
   * OAuth 2.1 authorization server base URL (the `iss` claim in issued JWTs).
   * Protected Resource Metadata points clients here for OIDC discovery.
   *
   * e.g. "https://auth.example.com/application/o/<name>-mcp/"
   */
  issuer: string;
  /**
   * JWKS endpoint for signature verification. Typically `${issuer}jwks/` for
   * Authentik. Auto-derived from `issuer` if omitted.
   */
  jwksUri?: string;
  /**
   * Expected JWT `aud` claim(s). Defaults to `canonicalUrl`, which is
   * RFC 8707 spec-compliant. Authentik (2026.2.x) does NOT honour the
   * resource indicator and instead puts the OAuth client_id in `aud`;
   * pass the client_id as the expected audience in that case. Accepts
   * an array to allow either form.
   */
  audience?: string | string[];
  /** Scopes advertised in the resource metadata document. */
  scopesSupported?: string[];
}

export interface StartMcpOptions {
  name: string;
  version?: string;
  port: number;
  /** Static bearer token — internal callers (bot, Claude Code) use this. */
  bearerToken: string;
  /** Tools registered with the MCP server. */
  tools: ToolRegistration[];
  /** Optional custom backend-error formatter. */
  onBackendError?: (e: unknown) => string | null;
  /** Enable OAuth 2.1 JWT validation alongside static bearer. */
  oauth?: OAuthOptions;
  /**
   * Returned in the MCP `initialize` response as a hint to the connecting
   * model about how to use this server — e.g. "check X before responding."
   * Not every client surfaces this to the model, but it's the spec-correct
   * place to put it (vs. hoping the model decides to call a tool first).
   */
  instructions?: string;
}

function json(res: ServerResponse, status: number, body: any, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startMcp(opts: StartMcpOptions): Promise<void> {
  const { name, version = "0.1.0", port, bearerToken, tools, onBackendError, oauth, instructions } = opts;

  if (!bearerToken) throw new Error(`startMcp: bearerToken required for '${name}'`);

  const toolsByName: Record<string, ToolRegistration> = {};
  for (const t of tools) toolsByName[t.def.name] = t;

  // ----- OAuth / JWT setup (if enabled) -----
  let jwks: JWTVerifyGetKey | null = null;
  let protectedResourceMetadata: Record<string, any> | null = null;
  let resourceMetadataPath = "";

  if (oauth) {
    const jwksUri = oauth.jwksUri ?? new URL("jwks/", oauth.issuer).toString();
    jwks = createRemoteJWKSet(new URL(jwksUri), {
      cacheMaxAge: 10 * 60 * 1000, // 10 min
      cooldownDuration: 30 * 1000, // 30s between fetches on failure
    });

    protectedResourceMetadata = {
      resource: oauth.canonicalUrl,
      authorization_servers: [oauth.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: oauth.scopesSupported ?? [],
      resource_documentation: `${oauth.canonicalUrl}/health`,
    };

    resourceMetadataPath = "/.well-known/oauth-protected-resource";
  }

  async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
      unauthorized(res, "missing_token");
      return false;
    }
    const token = auth.slice("bearer ".length).trim();

    // Static bearer first (fast path, bot + CLI).
    if (token === bearerToken) return true;

    // Fall through to OAuth JWT if enabled.
    if (oauth && jwks) {
      try {
        await jwtVerify(token, jwks, {
          issuer: oauth.issuer,
          audience: oauth.audience ?? oauth.canonicalUrl,
        });
        return true;
      } catch {
        // intentional: no detail leak
      }
    }

    unauthorized(res, "invalid_token");
    return false;
  }

  function unauthorized(res: ServerResponse, err: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (oauth) {
      const resourceMetadataUrl = `${oauth.canonicalUrl}${resourceMetadataPath}`;
      headers["WWW-Authenticate"] = `Bearer error="${err}", resource_metadata="${resourceMetadataUrl}"`;
    } else {
      headers["WWW-Authenticate"] = `Bearer error="${err}"`;
    }
    res.writeHead(401, headers);
    res.end(
      JSON.stringify({
        error: err === "missing_token" ? "authorization required" : "invalid token",
      }),
    );
  }

  const buildServer = (): Server => {
    const server = new Server(
      { name, version },
      { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.def.name,
        description: t.def.description,
        inputSchema: zodToJsonSchema(t.def.inputSchema),
        ...(t.def.annotations ? { annotations: t.def.annotations } : {}),
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name: toolName, arguments: args } = req.params;
      const reg = toolsByName[toolName];
      if (!reg) return { isError: true, content: [{ type: "text", text: `unknown tool: ${toolName}` }] };

      const parsed = reg.def.inputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `invalid input for ${toolName}: ${parsed.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")}`,
            },
          ],
        };
      }
      try {
        const result = await reg.handler(parsed.data);
        // Pass-through: handler may return an already-shaped MCP response
        // (e.g. with embedded resource/image content). Otherwise wrap as JSON text.
        if (result && typeof result === "object" && Array.isArray((result as any).content)) {
          return result as any;
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        const custom = onBackendError?.(e);
        if (custom) return { isError: true, content: [{ type: "text", text: custom }] };
        return { isError: true, content: [{ type: "text", text: `error: ${e.message ?? String(e)}` }] };
      }
    });

    return server;
  };

  const sseTransports = new Map<string, SSEServerTransport>();
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/health" && req.method === "GET") {
      return json(res, 200, { ok: true, service: name, tools: tools.map((t) => t.def.name) });
    }
    if (oauth && url.pathname === resourceMetadataPath && req.method === "GET") {
      return json(res, 200, protectedResourceMetadata);
    }

    if (!(await authenticate(req, res))) return;

    // ----- Streamable HTTP (/mcp) — modern MCP transport (ChatGPT, Claude.ai) -----
    if (url.pathname === "/mcp") {
      const sessionHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

      if (sessionId && streamableTransports.has(sessionId)) {
        await streamableTransports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      if (req.method === "POST") {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            streamableTransports.set(newSessionId, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) streamableTransports.delete(transport.sessionId);
        };
        const server = buildServer();
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      return json(res, 400, { error: "invalid /mcp request — initialise via POST" });
    }

    // ----- Legacy SSE (/sse + /message) — kept for bot -----
    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/message", res);
      sseTransports.set(transport.sessionId, transport);
      req.on("close", () => sseTransports.delete(transport.sessionId));
      const server = buildServer();
      await server.connect(transport);
      return;
    }
    if (url.pathname === "/message" && req.method === "POST") {
      const sid = url.searchParams.get("sessionId");
      const transport = sid ? sseTransports.get(sid) : undefined;
      if (!transport) return json(res, 404, { error: "unknown sessionId" });
      await transport.handlePostMessage(req, res);
      return;
    }

    json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, "0.0.0.0", () => {
      console.log(`${name} listening on 0.0.0.0:${port}`);
      console.log(`  tools:    ${tools.map((t) => t.def.name).join(", ")}`);
      console.log(`  health:   GET /health (public)`);
      console.log(`  mcp:      POST /mcp (streamable HTTP, Bearer)`);
      console.log(`  legacy:   GET /sse + POST /message (bearer)`);
      if (oauth) {
        console.log(`  oauth:    issuer ${oauth.issuer}`);
        console.log(`  prm:      GET ${resourceMetadataPath} (public)`);
      } else {
        console.log(`  oauth:    disabled (static bearer only)`);
      }
      resolve();
    });
  });

  const shutdown = () => {
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
