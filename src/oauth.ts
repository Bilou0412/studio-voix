import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Db } from "./db.js";

// Serveur d'autorisation OAuth 2.1 (PKCE, enregistrement dynamique) pour un seul propriétaire :
// Claude s'enregistre comme client, le propriétaire se connecte avec son mot de passe et choisit les portées.
// Aucun jeton ne passe par le chat.

export const DEFAULT_SCOPES = ["projects:*", "takes:*", "mixes:*", "media:*"];
export const ALL_SCOPES = ["voices:write", ...DEFAULT_SCOPES];
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 600;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const token = () => randomBytes(32).toString("base64url");

function safeEqual(a: string, b: string) {
  const x = Buffer.from(hash(a));
  const y = Buffer.from(hash(b));
  return timingSafeEqual(x, y);
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export class OwnerOAuthProvider implements OAuthServerProvider {
  constructor(
    private db: Db,
    private opts: { ownerPassword?: string; apiKey?: string },
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (id) => {
        const { rows } = await this.db.query("SELECT info FROM oauth_client WHERE client_id = $1", [id]);
        return rows[0]?.info;
      },
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        await this.db.query("INSERT INTO oauth_client (client_id, info) VALUES ($1, $2)", [full.client_id, JSON.stringify(full)]);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const wantsVoices = (params.scopes ?? []).includes("voices:write");
    const hidden = {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      state: params.state ?? "",
      resource: params.resource?.toString() ?? "",
    };
    res.type("html").send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Studio voix · autoriser</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}input[type=password]{width:100%;padding:.5rem;font-size:1rem}button{padding:.6rem 1.2rem;font-size:1rem;margin-top:1rem}label{display:block;margin:.6rem 0}</style>
<h1>Autoriser ${esc(client.client_name ?? "un client")}</h1>
<p>Ce client demande l'accès au studio voix : projets, prises, mix et médias.</p>
<form method="post" action="/oauth/consent">
${Object.entries(hidden)
  .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
  .join("\n")}
<label><input type="checkbox" name="voices_write" value="1"${wantsVoices ? " checked" : ""}> Lui permettre aussi de <strong>créer et supprimer des voix</strong> (portée voices:write)</label>
<label>Mot de passe du propriétaire<br><input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button type="submit">Autoriser</button>
</form></html>`);
  }

  // POST /oauth/consent : le formulaire ci-dessus.
  async consent(req: Request, res: Response) {
    const b = req.body ?? {};
    const client = await this.clientsStore.getClient(String(b.client_id ?? ""));
    if (!client || !client.redirect_uris.map(String).includes(String(b.redirect_uri))) {
      res.status(400).type("text").send("client ou redirect_uri inconnu");
      return;
    }
    if (!this.opts.ownerPassword || !safeEqual(String(b.password ?? ""), this.opts.ownerPassword)) {
      res.status(401).type("text").send("mot de passe incorrect");
      return;
    }
    const scopes = b.voices_write ? ALL_SCOPES : DEFAULT_SCOPES;
    const code = token();
    await this.db.query(
      "INSERT INTO oauth_grant (code, client_id, scopes, code_challenge, redirect_uri, resource, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7))",
      [code, client.client_id, scopes, String(b.code_challenge), String(b.redirect_uri), b.resource || null, CODE_TTL],
    );
    const url = new URL(String(b.redirect_uri));
    url.searchParams.set("code", code);
    if (b.state) url.searchParams.set("state", String(b.state));
    res.redirect(302, url.toString());
  }

  private async grant(client: OAuthClientInformationFull, code: string) {
    const { rows } = await this.db.query("SELECT * FROM oauth_grant WHERE code = $1 AND client_id = $2 AND expires_at > now()", [
      code,
      client.client_id,
    ]);
    if (!rows[0]) throw new InvalidGrantError("code d'autorisation invalide ou expiré");
    return rows[0];
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    return (await this.grant(client, code)).code_challenge;
  }

  private async issue(clientId: string, scopes: string[], resource: string | null): Promise<OAuthTokens> {
    const access = token();
    const refresh = token();
    await this.db.query(
      "INSERT INTO oauth_token (token_hash, kind, client_id, scopes, resource, expires_at) VALUES ($1,'access',$2,$3,$4, now() + make_interval(secs => $5)), ($6,'refresh',$2,$3,$4, now() + make_interval(secs => $7))",
      [hash(access), clientId, scopes, resource, ACCESS_TTL, hash(refresh), REFRESH_TTL],
    );
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string) {
    const g = await this.grant(client, code);
    if (redirectUri && redirectUri !== g.redirect_uri) throw new InvalidGrantError("redirect_uri différent de celui de l'autorisation");
    await this.db.query("DELETE FROM oauth_grant WHERE code = $1", [code]);
    return this.issue(client.client_id, g.scopes, g.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]) {
    const { rows } = await this.db.query(
      "UPDATE oauth_token SET revoked = true WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND NOT revoked AND expires_at > now() RETURNING *",
      [hash(refreshToken), client.client_id],
    );
    if (!rows[0]) throw new InvalidGrantError("jeton de rafraîchissement invalide");
    const granted: string[] = rows[0].scopes;
    const next = scopes?.length ? scopes.filter((s) => granted.includes(s)) : granted;
    return this.issue(client.client_id, next, rows[0].resource);
  }

  async verifyAccessToken(t: string): Promise<AuthInfo> {
    // La clé d'API statique sert aux outils du propriétaire (curl, scripts) : toutes les portées.
    if (this.opts.apiKey && safeEqual(t, this.opts.apiKey)) {
      return { token: t, clientId: "api_key", scopes: ALL_SCOPES, expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TTL };
    }
    const { rows } = await this.db.query(
      "SELECT * FROM oauth_token WHERE token_hash = $1 AND kind = 'access' AND NOT revoked AND expires_at > now()",
      [hash(t)],
    );
    if (!rows[0]) throw new InvalidTokenError("jeton invalide ou expiré");
    return {
      token: t,
      clientId: rows[0].client_id,
      scopes: rows[0].scopes,
      expiresAt: Math.floor(new Date(rows[0].expires_at).getTime() / 1000),
      resource: rows[0].resource ? new URL(rows[0].resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, req: { token: string }) {
    await this.db.query("UPDATE oauth_token SET revoked = true WHERE token_hash = $1", [hash(req.token)]);
  }
}
