import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { Studio, type Ctx } from "./studio.js";
import { buildMcpServer } from "./mcp.js";
import { OwnerOAuthProvider, ALL_SCOPES } from "./oauth.js";
import { LocalStore } from "./storage.js";
import { toApiError } from "./errors.js";

export function buildApp(studio: Studio, oauth: OwnerOAuthProvider) {
  const { publicUrl } = studio.config;
  const app = express();
  // Un seul saut de proxy devant le service (le routeur de Fly).
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Stockage local seulement : les URL signées pointent ici.
  if (studio.store instanceof LocalStore) {
    const store = studio.store;
    app.get(/^\/files\/(.+)$/, async (req, res) => {
      const key = (req.params as any)[0];
      if (!store.verify("GET", key, Number(req.query.exp), String(req.query.sig ?? ""))) return res.status(403).end();
      if (!(await store.exists(key))) return res.status(404).end();
      res.send(await store.get(key));
    });
    app.put(/^\/files\/(.+)$/, express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
      const key = (req.params as any)[0];
      if (!store.verify("PUT", key, Number(req.query.exp), String(req.query.sig ?? ""))) return res.status(403).end();
      await store.put(key, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      res.status(200).end();
    });
  }

  const mcpUrl = new URL(`${publicUrl}/mcp`);
  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: new URL(publicUrl),
      scopesSupported: ALL_SCOPES,
      resourceServerUrl: mcpUrl,
      resourceName: "Studio voix",
    }),
  );
  app.post("/oauth/consent", express.urlencoded({ extended: false }), (req, res) => {
    oauth.consent(req, res).catch((e) => res.status(500).type("text").send(String(e)));
  });

  const bearer = requireBearerAuth({ verifier: oauth, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

  // Serveur MCP, transport HTTP streamable, sans état : un serveur par requête.
  app.post("/mcp", bearer, express.json({ limit: "4mb" }), async (req, res) => {
    const server = buildMcpServer(studio, req.ip);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null });
    }
  });
  app.get("/mcp", (_req, res) => res.status(405).set("allow", "POST").end());
  app.delete("/mcp", (_req, res) => res.status(405).set("allow", "POST").end());

  // API REST /v1 : les mêmes opérations que les outils MCP.
  const v1 = express.Router();
  v1.use(bearer, express.json({ limit: "4mb" }));
  const ctx = (req: Request): Ctx => ({ actor: req.auth!.clientId, scopes: req.auth!.scopes, ip: req.ip });
  const h =
    (fn: (req: Request) => Promise<unknown>, status = 200) =>
    async (req: Request, res: Response, _next: NextFunction) => {
      try {
        res.status(status).json(await fn(req));
      } catch (e) {
        const err = toApiError(e);
        res.status(err.status).json({ error: err.toJSON() });
      }
    };
  const idem = (req: Request) => req.get("idempotency-key") ?? req.body?.idempotency_key;

  v1.get("/voices", h((req) => studio.voiceList(ctx(req))));
  v1.post("/voices", h((req) => studio.voiceCreate({ ...req.body, idempotency_key: idem(req) }, ctx(req)), 202));
  v1.post(
    "/voices/:id/preview",
    h((req) => studio.voicePreview({ ...req.body, voice_id: req.params.id, idempotency_key: idem(req) }, ctx(req)), 202),
  );
  v1.post("/media", h((req) => studio.mediaUploadInit({ ...req.body, idempotency_key: idem(req) }, ctx(req)), 201));
  v1.put(
    "/media/:id/chunks/:n",
    express.raw({ type: "application/octet-stream", limit: "1mb" }),
    h((req) =>
      studio.mediaUploadChunk(
        {
          upload_id: req.params.id,
          index: Number(req.params.n),
          data_b64: Buffer.isBuffer(req.body) ? req.body.toString("base64") : String(req.body?.data_b64 ?? ""),
        },
        ctx(req),
      ),
    ),
  );
  v1.post("/media/:id/complete", h((req) => studio.mediaUploadComplete({ upload_id: req.params.id }, ctx(req))));
  v1.get(
    "/media/:id",
    h((req) =>
      studio.mediaGet(
        { media_id: req.params.id, variant: req.query.variant as string | undefined, channel: req.query.channel as any },
        ctx(req),
      ),
    ),
  );
  v1.get("/jobs/:id", h((req) => studio.jobStatus({ job_id: req.params.id, wait_seconds: Number(req.query.wait ?? 0) }, ctx(req))));
  app.use("/v1", v1);

  return app;
}
