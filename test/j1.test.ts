import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, tone, sha, uploadViaPut, API_KEY, PASSWORD } from "./helpers.js";
import { CONSENT_STATEMENT } from "../src/studio.js";

let t: Awaited<ReturnType<typeof startTestServer>>;
const consent = () => ({ statement: CONSENT_STATEMENT, accepted_at: new Date().toISOString() });

before(async () => {
  t = await startTestServer();
});
after(async () => {
  await t.close();
});

test("dépôt par put_url : sha256 vérifié, durée mesurée, dédoublonnage", async () => {
  const data = tone(12);
  const id = await uploadViaPut(t.api, data);
  const got = await t.api("GET", `/v1/media/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.status, "ready");
  assert.ok(Math.abs(got.body.duration_s - 12) < 0.2);
  const file = await fetch(got.body.url);
  assert.equal(sha(Buffer.from(await file.arrayBuffer())), sha(data));
  const again = await t.api("POST", "/v1/media", { filename: "autre.mp3", size: data.length, sha256: sha(data), kind: "audio" });
  assert.equal(again.body.media_id, id);
  assert.equal(again.body.deduplicated, true);
});

test("dépôt par morceaux, et refus d'un sha256 faux", async () => {
  const data = randomBytes(700 * 1024);
  const init = await t.api("POST", "/v1/media", { filename: "capture.png", size: data.length, sha256: sha(data), kind: "image" });
  for (let i = 0; i * 512 * 1024 < data.length; i++) {
    const part = data.subarray(i * 512 * 1024, (i + 1) * 512 * 1024);
    const res = await fetch(`${t.url}/v1/media/${init.body.upload_id}/chunks/${i}`, {
      method: "PUT",
      body: part,
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/octet-stream" },
    });
    assert.equal(res.status, 200);
  }
  const done = await t.api("POST", `/v1/media/${init.body.upload_id}/complete`);
  assert.equal(done.body.status, "ready");

  const bad = randomBytes(1000);
  const wrong = await t.api("POST", "/v1/media", { filename: "x.png", size: bad.length, sha256: sha(randomBytes(10)), kind: "image" });
  await t.api("PUT", `/v1/media/${wrong.body.upload_id}/chunks/0`, { data_b64: bad.toString("base64") });
  const refused = await t.api("POST", `/v1/media/${wrong.body.upload_id}/complete`);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, "checksum_mismatch");
});

test("une voix sans consentement est refusée", async () => {
  const id = await uploadViaPut(t.api, tone(15, 200));
  const none = await t.api("POST", "/v1/voices", { name: "bilel", reference_media_ids: [id] });
  assert.equal(none.status, 422);
  assert.equal(none.body.error.code, "consent_missing");
  const other = await t.api("POST", "/v1/voices", {
    name: "bilel",
    reference_media_ids: [id],
    consent: { statement: "oui", accepted_at: new Date().toISOString() },
  });
  assert.equal(other.body.error.code, "consent_missing");
});

test("un extrait de moins de 10 s fait échouer la création", async () => {
  const id = await uploadViaPut(t.api, tone(4, 260));
  const res = await t.api("POST", "/v1/voices", { name: "court", reference_media_ids: [id], consent: consent() });
  assert.equal(res.status, 202);
  const job = await t.studio.waitJob(res.body.job_id);
  assert.equal(job.status, "failed");
  assert.equal((job.error as any).code, "reference_invalid");
  const list = await t.api("GET", "/v1/voices");
  assert.equal(list.body.voices.find((v: any) => v.voice_id === res.body.voice_id).status, "failed");
});

test("création de voix : référence nettoyée, voix prête, phrase test générée", async () => {
  const id = await uploadViaPut(t.api, tone(14, 240));
  const res = await t.api("POST", "/v1/voices", { name: "bilel", reference_media_ids: [id], tags: ["posé"], consent: consent(), idempotency_key: "v1" });
  assert.equal(res.status, 202);
  const twice = await t.api("POST", "/v1/voices", { name: "bilel", reference_media_ids: [id], tags: ["posé"], consent: consent(), idempotency_key: "v1" });
  assert.equal(twice.body.voice_id, res.body.voice_id);
  const job = await t.api("GET", `/v1/jobs/${res.body.job_id}?wait=25`);
  assert.equal(job.body.status, "succeeded", JSON.stringify(job.body));
  assert.ok(job.body.result.preview_media_id);
  assert.ok(job.body.gpu_seconds > 0);
  const voices = await t.api("GET", "/v1/voices");
  const v = voices.body.voices.find((x: any) => x.voice_id === res.body.voice_id);
  assert.equal(v.status, "ready");
  assert.equal(v.references.length, 1);
  const clean = await t.api("GET", `/v1/media/${id}?variant=clean`);
  assert.equal(clean.body.mime, "audio/wav");
  const consentRow = await t.db.query("SELECT consent_statement, consent_at FROM voice WHERE id = $1", [v.voice_id]);
  assert.equal(consentRow.rows[0].consent_statement, CONSENT_STATEMENT);
  const audit = await t.db.query("SELECT action FROM audit WHERE voice_id = $1", [v.voice_id]);
  assert.ok(audit.rows.some((r: any) => r.action === "voice_create"));
});

test("la voix intégrée parle sans échantillon ni référence", async () => {
  const voices = await t.api("GET", "/v1/voices");
  assert.deepEqual(voices.body.voices[0], {
    voice_id: "voice_defaut",
    name: "Voix intégrée du modèle (pas un clone)",
    language: "fr",
    status: "ready",
    builtin: true,
    references: [],
  });
  const before = t.synth.calls.length;
  const res = await t.api("POST", "/v1/voices/voice_defaut/preview", { text: "Bonjour." });
  assert.equal(res.status, 202);
  const job = await t.api("GET", `/v1/jobs/${res.body.job_id}?wait=25`);
  assert.equal(job.body.status, "succeeded", JSON.stringify(job.body));
  assert.equal(job.body.result.params.reference_id, null);
  assert.equal(t.synth.calls[before].reference_url, undefined);
  assert.equal(job.body.result.url.length > 0, true);
});

test("aperçu d'un bloc : réglages du ton, mesure de vitesse et de coût, variante MP3", async () => {
  const voices = await t.api("GET", "/v1/voices");
  const v = voices.body.voices.find((x: any) => x.status === "ready" && !x.builtin);
  const res = await t.api("POST", `/v1/voices/${v.voice_id}/preview`, { text: "J'avais une théorie. En fait, non.", tone: "[calme, intime]", seed: 42 });
  assert.equal(res.status, 202);
  const job = await t.api("GET", `/v1/jobs/${res.body.job_id}?wait=25`);
  assert.equal(job.body.status, "succeeded", JSON.stringify(job.body));
  const r = job.body.result;
  assert.equal(r.params.tone, "intime");
  assert.equal(r.params.exaggeration, 0.35);
  assert.equal(r.params.seed, 42);
  assert.ok(r.real_time_factor > 0);
  assert.ok(r.cost_eur > 0);
  const call = t.synth.calls.at(-1)!;
  assert.equal(call.language, "fr");
  assert.equal(call.cfg_weight, 0.4);
  const mp3 = await t.api("GET", `/v1/media/${r.media_id}?variant=preview`);
  assert.equal(mp3.body.mime, "audio/mpeg");
  assert.equal((await fetch(mp3.body.url)).status, 200);
});

test("le plafond GPU du jour bloque les nouvelles générations", async () => {
  const capped = await startTestServer({ GPU_DAILY_CAP_EUR: "0" });
  try {
    const id = await uploadViaPut(capped.api, tone(12));
    const res = await capped.api("POST", "/v1/voices", { name: "x", reference_media_ids: [id], consent: consent() });
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, "quota_exceeded");
  } finally {
    await capped.close();
  }
});

test("sans jeton, l'API et le MCP répondent 401 avec l'adresse des métadonnées OAuth", async () => {
  const res = await fetch(`${t.url}/v1/voices`);
  assert.equal(res.status, 401);
  const mcp = await fetch(`${t.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(mcp.status, 401);
  assert.match(mcp.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp/);
});

async function mcpClient(token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const parse = (r: any) => JSON.parse(r.content[0].text);

test("MCP : les outils du jalon 1 sont exposés et marchent de bout en bout", async () => {
  const client = await mcpClient(API_KEY);
  const tools = (await client.listTools()).tools.map((x) => x.name).sort();
  for (const name of ["voice_create", "voice_preview", "media_upload_init", "media_get", "job_status"]) assert.ok(tools.includes(name), name);

  const data = tone(11, 300);
  const init = parse(await client.callTool({ name: "media_upload_init", arguments: { filename: "s.mp3", size: data.length, sha256: sha(data), kind: "audio" } }));
  await fetch(init.put_url, { method: "PUT", body: new Uint8Array(data), headers: init.put_headers });
  const done = parse(await client.callTool({ name: "media_upload_complete", arguments: { upload_id: init.upload_id } }));
  assert.equal(done.status, "ready");
  const created = parse(await client.callTool({ name: "voice_create", arguments: { name: "mcp", reference_media_ids: [done.media_id], consent: consent() } }));
  const st = parse(await client.callTool({ name: "job_status", arguments: { job_id: created.job_id, wait_seconds: 25 } }));
  assert.equal(st.status, "succeeded");
  const prev = parse(await client.callTool({ name: "voice_preview", arguments: { voice_id: created.voice_id, text: "Bloc zéro point un." } }));
  const st2 = parse(await client.callTool({ name: "job_status", arguments: { job_id: prev.job_id, wait_seconds: 25 } }));
  assert.equal(st2.status, "succeeded");
  const got = parse(await client.callTool({ name: "media_get", arguments: { media_id: st2.result.media_id } }));
  assert.equal((await fetch(got.url)).status, 200);

  const err = await client.callTool({ name: "voice_preview", arguments: { voice_id: "voice_inconnue" } });
  assert.equal(err.isError, true);
  assert.equal(parse(err).error.code, "voice_not_found");
  await client.close();
});

async function oauthToken(withVoices: boolean) {
  const reg = await fetch(`${t.url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }),
  }).then((r) => r.json());
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "etat",
  });
  const page = await fetch(`${t.url}/authorize?${q}`).then((r) => r.text());
  assert.match(page, /Mot de passe du propriétaire/);
  const form = new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: challenge,
    state: "etat",
    resource: "",
    password: PASSWORD,
    ...(withVoices ? { voices_write: "1" } : {}),
  });
  const wrong = await fetch(`${t.url}/oauth/consent`, { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(form), password: "non" }), redirect: "manual" });
  assert.equal(wrong.status, 401);
  const consentRes = await fetch(`${t.url}/oauth/consent`, { method: "POST", body: form, redirect: "manual" });
  assert.equal(consentRes.status, 302);
  const back = new URL(consentRes.headers.get("location")!);
  assert.equal(back.searchParams.get("state"), "etat");
  const tok = await fetch(`${t.url}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      client_id: reg.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    }),
  }).then((r) => r.json());
  assert.ok(tok.access_token, JSON.stringify(tok));
  return { tok, clientId: reg.client_id };
}

test("OAuth : sans la case voix, le connecteur ne peut pas créer de voix", async () => {
  const { tok } = await oauthToken(false);
  assert.ok(!tok.scope.includes("voices:write"));
  const client = await mcpClient(tok.access_token);
  const res = await client.callTool({ name: "voice_create", arguments: { name: "x", reference_media_ids: ["m"], consent: consent() } });
  assert.equal(parse(res).error.code, "forbidden");
  const list = parse(await client.callTool({ name: "voice_list", arguments: {} }));
  assert.ok(Array.isArray(list.voices));
  await client.close();
});

test("OAuth : avec la case voix, la portée voices:write est accordée et le jeton se rafraîchit", async () => {
  const { tok, clientId } = await oauthToken(true);
  assert.ok(tok.scope.includes("voices:write"));
  const refreshed = await fetch(`${t.url}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }),
  }).then((r) => r.json());
  assert.ok(refreshed.access_token);
  const reuse = await fetch(`${t.url}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }),
  });
  assert.equal(reuse.status, 400);
});
