import { createHash, randomInt } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { ObjectStore } from "./storage.js";
import type { Synthesizer } from "./synth.js";
import { TONES, toneFromHint } from "./synth.js";
import { GithubReleases } from "./github.js";
import { ApiError, toApiError } from "./errors.js";
import { newId } from "./ids.js";
import * as audio from "./audio.js";

// Le cœur du service : chaque outil MCP et chaque endpoint /v1 appelle une méthode d'ici.

export interface Ctx {
  actor: string;
  scopes: string[];
  ip?: string;
}

export const SCOPES = ["voices:write", "projects:*", "takes:*", "mixes:*", "media:*"] as const;

export const CONSENT_STATEMENT = "C'est ma voix et j'autorise son clonage.";
export const PREVIEW_SENTENCE =
  "Bonjour, ceci est la phrase test de ma voix : essayons de comprendre, ensemble, ce qui se joue vraiment.";

export const CHUNK_SIZE = 512 * 1024;
const MAX_TEXT = 2000;
const REFERENCE_MIN_S = 10;
const REFERENCE_MAX_S = 300;
const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled"]);
const MAX_ATTEMPTS = 3;

const MEDIA_KINDS = ["audio", "video", "image", "json", "text"] as const;
type MediaKind = (typeof MEDIA_KINDS)[number];

const MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  json: "application/json",
  txt: "text/plain",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  md: "text/markdown",
};

function mimeFor(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function sha256(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

function requireScope(ctx: Ctx, scope: string) {
  const family = scope.split(":")[0];
  if (ctx.scopes.includes(scope) || ctx.scopes.includes(`${family}:*`)) return;
  throw new ApiError(
    "forbidden",
    `la portée ${scope} n'est pas accordée à ce client`,
    scope === "voices:write"
      ? "reconnecte le connecteur en cochant « créer et supprimer des voix » sur la page d'autorisation"
      : undefined,
  );
}

function sanitizeAssetName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "fichier";
}

export interface StudioDeps {
  config: Config;
  db: Db;
  store: ObjectStore;
  synth?: Synthesizer;
  github?: GithubReleases;
}

export class Studio {
  config: Config;
  db: Db;
  store: ObjectStore;
  synth?: Synthesizer;
  github?: GithubReleases;
  private running = false;
  private loops: Promise<void>[] = [];
  private wake: (() => void)[] = [];

  constructor(deps: StudioDeps) {
    this.config = deps.config;
    this.db = deps.db;
    this.store = deps.store;
    this.synth = deps.synth;
    this.github = deps.github;
  }

  // ---------- utilitaires ----------

  private async idempotent<T>(op: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    const k = `${op}:${key}`;
    const { rows } = await this.db.query("SELECT response FROM idempotency WHERE key = $1", [k]);
    if (rows[0]) return rows[0].response as T;
    const out = await fn();
    await this.db.query("INSERT INTO idempotency (key, operation, response) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
      k,
      op,
      JSON.stringify(out),
    ]);
    return out;
  }

  private async audit(ctx: Ctx, action: string, voiceId: string | null, detail: object) {
    await this.db.query("INSERT INTO audit (actor, action, voice_id, detail) VALUES ($1, $2, $3, $4)", [
      ctx.actor,
      action,
      voiceId,
      JSON.stringify(detail),
    ]);
  }

  private async spentTodayEur(): Promise<number> {
    const { rows } = await this.db.query(
      "SELECT COALESCE(SUM(cost_eur), 0) AS s FROM job WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    );
    return Number(rows[0].s);
  }

  private async checkQuota() {
    const spent = await this.spentTodayEur();
    if (spent >= this.config.gpuDailyCapEur) {
      throw new ApiError(
        "quota_exceeded",
        `plafond GPU du jour atteint (${spent.toFixed(2)} € sur ${this.config.gpuDailyCapEur} €)`,
        "le plafond se remet à zéro à minuit UTC ; GPU_DAILY_CAP_EUR le règle",
      );
    }
  }

  private async enqueue(type: string, input: object): Promise<string> {
    const id = newId("job");
    await this.db.query("INSERT INTO job (id, type, input) VALUES ($1, $2, $3)", [id, type, JSON.stringify(input)]);
    this.wake.splice(0).forEach((w) => w());
    return id;
  }

  // ---------- médias ----------

  async mediaUploadInit(
    input: {
      filename: string;
      size: number;
      sha256: string;
      kind: MediaKind;
      meta?: Record<string, unknown>;
      project?: string;
      idempotency_key?: string;
    },
    ctx: Ctx,
  ) {
    requireScope(ctx, "media:write");
    if (!MEDIA_KINDS.includes(input.kind)) throw new ApiError("invalid_input", `kind inconnu : ${input.kind}`);
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new ApiError("invalid_input", "sha256 attendu en hexadécimal minuscule (64 caractères)");
    return this.idempotent("media_upload_init", input.idempotency_key, async () => {
      const dup = await this.db.query(
        "SELECT id FROM media WHERE sha256 = $1 AND status = 'ready' AND variant = 'original' LIMIT 1",
        [input.sha256],
      );
      if (dup.rows[0]) {
        return { upload_id: dup.rows[0].id, media_id: dup.rows[0].id, status: "ready", deduplicated: true };
      }
      const id = newId("med");
      const mime = mimeFor(input.filename);
      const key = `sha256/${input.sha256}`;
      await this.db.query(
        "INSERT INTO media (id, project, kind, sha256, size, mime, filename, storage_key, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [id, input.project ?? null, input.kind, input.sha256, input.size, mime, input.filename, key, JSON.stringify(input.meta ?? {})],
      );
      const ttl = this.config.signedUrlTtlSeconds;
      const out: Record<string, unknown> = {
        upload_id: id,
        media_id: id,
        status: "pending",
        put_url: await this.store.signedPutUrl(key, ttl, mime),
        put_headers: { "content-type": mime },
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        chunk_size: CHUNK_SIZE,
        next: "envoie les octets (put_url, ou la release GitHub, ou media_upload_chunk sous 200 Ko), puis appelle media_upload_complete",
      };
      if (this.github) {
        const tag = `inbox-${new Date().toISOString().slice(0, 10)}`;
        const asset = `${id}-${sanitizeAssetName(input.filename)}`;
        out.github_inbox = {
          repo: this.github.repo,
          tag,
          asset_name: asset,
          command: `gh release create ${tag} -R ${this.github.repo} --prerelease -t ${tag} -n inbox 2>/dev/null; cp '${input.filename}' '/tmp/${asset}' && gh release upload ${tag} '/tmp/${asset}' -R ${this.github.repo} --clobber`,
        };
      }
      return out;
    });
  }

  async mediaUploadChunk(input: { upload_id: string; index: number; data_b64: string }, ctx: Ctx) {
    requireScope(ctx, "media:write");
    const m = await this.getMediaRow(input.upload_id);
    if (m.status === "ready") return { upload_id: m.id, status: "ready", received_bytes: Number(m.size) };
    const data = Buffer.from(input.data_b64, "base64");
    if (data.length > CHUNK_SIZE) throw new ApiError("invalid_input", `morceau trop gros (${data.length} o > ${CHUNK_SIZE} o)`);
    await this.db.query(
      "INSERT INTO media_chunk (media_id, idx, data) VALUES ($1, $2, $3) ON CONFLICT (media_id, idx) DO UPDATE SET data = EXCLUDED.data",
      [m.id, input.index, data],
    );
    const { rows } = await this.db.query("SELECT COALESCE(SUM(length(data)), 0) AS n FROM media_chunk WHERE media_id = $1", [m.id]);
    return { upload_id: m.id, index: input.index, received_bytes: Number(rows[0].n), expected_bytes: Number(m.size) };
  }

  async mediaUploadComplete(input: { upload_id: string }, ctx: Ctx) {
    requireScope(ctx, "media:write");
    const m = await this.getMediaRow(input.upload_id);
    if (m.status === "ready") return this.mediaSummary(m);
    let data: Buffer | undefined;
    let via = "";
    const chunks = await this.db.query("SELECT data FROM media_chunk WHERE media_id = $1 ORDER BY idx", [m.id]);
    if (chunks.rows.length) {
      data = Buffer.concat(chunks.rows.map((r: any) => Buffer.from(r.data)));
      via = "chunks";
    } else if (await this.store.exists(m.storage_key)) {
      data = await this.store.get(m.storage_key);
      via = "put_url";
    } else if (this.github) {
      const tag = `inbox-${new Date().toISOString().slice(0, 10)}`;
      const name = `${m.id}-${sanitizeAssetName(m.filename)}`;
      data = await this.github.downloadAsset(tag, name);
      // La release de la veille, si l'envoi a eu lieu juste avant minuit UTC.
      if (!data) data = await this.github.downloadAsset(`inbox-${new Date(Date.now() - 864e5).toISOString().slice(0, 10)}`, name);
      via = "github";
    }
    if (!data) {
      throw new ApiError("upload_incomplete", "aucun octet reçu pour ce dépôt", "envoie le fichier par put_url, par la release GitHub ou par media_upload_chunk avant d'appeler complete");
    }
    const got = sha256(data);
    if (got !== m.sha256) {
      throw new ApiError("checksum_mismatch", `sha256 reçu ${got}, attendu ${m.sha256}`, "renvoie le fichier ; si l'envoi est par morceaux, vérifie l'ordre des index");
    }
    if (m.size != null && Number(m.size) !== data.length) {
      throw new ApiError("checksum_mismatch", `taille reçue ${data.length} o, attendue ${m.size} o`);
    }
    if (via !== "put_url") await this.store.put(m.storage_key, data, m.mime);
    let duration: number | null = null;
    if (m.kind === "audio" || m.kind === "video") duration = await audio.probeDuration(data).catch(() => null);
    await this.db.query("UPDATE media SET status = 'ready', size = $2, duration_s = $3 WHERE id = $1", [m.id, data.length, duration]);
    await this.db.query("DELETE FROM media_chunk WHERE media_id = $1", [m.id]);
    await this.audit(ctx, "media_upload_complete", null, { media_id: m.id, via, size: data.length });
    return this.mediaSummary(await this.getMediaRow(m.id));
  }

  private async getMediaRow(id: string) {
    const { rows } = await this.db.query("SELECT * FROM media WHERE id = $1", [id]);
    if (!rows[0]) throw new ApiError("not_found", `média ${id} introuvable`);
    return rows[0];
  }

  private mediaSummary(m: any) {
    return {
      media_id: m.id,
      status: m.status,
      kind: m.kind,
      variant: m.variant,
      filename: m.filename,
      mime: m.mime,
      size: m.size == null ? null : Number(m.size),
      sha256: m.sha256,
      duration_s: m.duration_s,
      meta: m.meta,
    };
  }

  private async storeGenerated(
    data: Buffer,
    opts: { kind: MediaKind; mime: string; filename: string; variant: string; parentId?: string; meta?: object; duration?: number | null; id?: string; key?: string },
  ) {
    const id = opts.id ?? newId("med");
    const hash = sha256(data);
    const key = opts.key ?? `sha256/${hash}`;
    if (!opts.key) await this.store.put(key, data, opts.mime);
    await this.db.query(
      `INSERT INTO media (id, kind, sha256, size, mime, filename, storage_key, status, variant, parent_id, duration_s, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10,$11)`,
      [id, opts.kind, hash, data.length, opts.mime, opts.filename, key, opts.variant, opts.parentId ?? null, opts.duration ?? null, JSON.stringify(opts.meta ?? {})],
    );
    return id;
  }

  async mediaGet(input: { media_id: string; variant?: string; channel?: "url" | "github" }, ctx: Ctx) {
    requireScope(ctx, "media:read");
    const variant = input.variant ?? "original";
    const base = await this.getMediaRow(input.media_id);
    const rootId = base.parent_id ?? base.id;
    let m = base.variant === variant ? base : undefined;
    if (!m) {
      const { rows } = await this.db.query(
        "SELECT * FROM media WHERE (id = $1 AND variant = $2) OR (parent_id = $1 AND variant = $2) LIMIT 1",
        [rootId, variant],
      );
      m = rows[0];
    }
    if (!m && variant === "preview" && (base.kind === "audio") && base.status === "ready") {
      const mp3 = await audio.toMp3(await this.store.get(base.storage_key));
      const id = await this.storeGenerated(mp3, {
        kind: "audio",
        mime: "audio/mpeg",
        filename: base.filename.replace(/\.[^.]+$/, "") + ".mp3",
        variant: "preview",
        parentId: rootId,
        duration: base.duration_s,
      });
      m = await this.getMediaRow(id);
    }
    if (!m) throw new ApiError("not_found", `variante ${variant} absente pour ${input.media_id}`, "variantes connues : original, clean, preview");
    if (m.status !== "ready") throw new ApiError("upload_incomplete", `média ${m.id} pas encore prêt (${m.status})`);
    const ttl = this.config.signedUrlTtlSeconds;
    const out: Record<string, unknown> = {
      ...this.mediaSummary(m),
      url: await this.store.signedGetUrl(m.storage_key, ttl, m.filename),
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    };
    if (input.channel === "github") {
      if (!this.github) throw new ApiError("invalid_input", "le canal GitHub n'est pas configuré sur ce service", "GITHUB_TOKEN et GITHUB_EXPORTS_REPO");
      const tag = `media-${rootId}`;
      const name = sanitizeAssetName(`${m.variant}-${m.filename}`);
      await this.github.uploadAsset(tag, name, await this.store.get(m.storage_key), m.mime);
      out.github = { repo: this.github.repo, tag, asset_name: name, command: `gh release download ${tag} -R ${this.github.repo} -p '${name}'` };
    }
    return out;
  }

  // ---------- voix ----------

  async voiceCreate(
    input: {
      name: string;
      reference_media_ids: string[];
      tags?: string[];
      language?: string;
      consent: { statement: string; accepted_at: string };
      idempotency_key?: string;
    },
    ctx: Ctx,
  ) {
    requireScope(ctx, "voices:write");
    const consentAt = new Date(input.consent?.accepted_at ?? "");
    if (!input.consent?.statement?.trim() || Number.isNaN(consentAt.getTime())) {
      throw new ApiError("consent_missing", "la déclaration de consentement horodatée est obligatoire", `statement = « ${CONSENT_STATEMENT} », accepted_at = horodatage ISO 8601`);
    }
    if (input.consent.statement.trim() !== CONSENT_STATEMENT) {
      throw new ApiError("consent_missing", "la déclaration ne correspond pas au texte de consentement", `recopie exactement : « ${CONSENT_STATEMENT} »`);
    }
    if (!input.reference_media_ids?.length) throw new ApiError("invalid_input", "au moins un extrait de référence est nécessaire");
    return this.idempotent("voice_create", input.idempotency_key, async () => {
      for (const id of input.reference_media_ids) {
        const m = await this.getMediaRow(id);
        if (m.status !== "ready") throw new ApiError("upload_incomplete", `l'extrait ${id} n'est pas encore déposé`);
        if (m.kind !== "audio") throw new ApiError("reference_invalid", `l'extrait ${id} n'est pas un audio (${m.kind})`);
      }
      await this.checkQuota();
      const voiceId = newId("voice");
      await this.db.query(
        "INSERT INTO voice (id, name, language, consent_statement, consent_at, consent_ip) VALUES ($1,$2,$3,$4,$5,$6)",
        [voiceId, input.name, input.language ?? "fr", input.consent.statement.trim(), consentAt.toISOString(), ctx.ip ?? null],
      );
      const jobId = await this.enqueue("voice_create", {
        voice_id: voiceId,
        reference_media_ids: input.reference_media_ids,
        tags: input.tags ?? [],
      });
      await this.audit(ctx, "voice_create", voiceId, { job_id: jobId, references: input.reference_media_ids });
      return { voice_id: voiceId, status: "processing", job_id: jobId, preview_media_id: null };
    });
  }

  async voiceList(ctx: Ctx) {
    requireScope(ctx, "projects:read");
    const voices = await this.db.query("SELECT * FROM voice ORDER BY created_at");
    const refs = await this.db.query("SELECT * FROM voice_reference ORDER BY created_at");
    return {
      voices: voices.rows.map((v: any) => ({
        voice_id: v.id,
        name: v.name,
        language: v.language,
        status: v.status,
        error: v.error,
        default_reference_id: v.default_reference_id,
        preview_media_id: v.preview_media_id,
        consent_at: v.consent_at,
        references: refs.rows
          .filter((r: any) => r.voice_id === v.id)
          .map((r: any) => ({ reference_id: r.id, tag: r.tag, duration_s: r.duration_s, media_id: r.media_id, clean_media_id: r.clean_media_id })),
      })),
    };
  }

  async voicePreview(
    input: {
      voice_id: string;
      reference_id?: string;
      text?: string;
      tone?: string;
      seed?: number;
      overrides?: { exaggeration?: number; cfg_weight?: number; temperature?: number };
      idempotency_key?: string;
    },
    ctx: Ctx,
  ) {
    requireScope(ctx, "takes:write");
    const text = (input.text ?? PREVIEW_SENTENCE).trim();
    if (!text) throw new ApiError("invalid_input", "texte vide");
    if (text.length > MAX_TEXT) throw new ApiError("text_too_long", `${text.length} caractères, ${MAX_TEXT} au plus`, "découpe le bloc");
    const voice = await this.getVoice(input.voice_id);
    if (voice.status !== "ready") throw new ApiError("voice_not_ready", `la voix ${voice.id} est en statut ${voice.status}`, "suis le job de création avec job_status");
    if (input.reference_id) await this.getReference(voice.id, input.reference_id);
    if (!this.synth) throw new ApiError("gpu_unavailable", "aucun worker GPU n'est configuré", "WORKER_URL et WORKER_TOKEN");
    return this.idempotent("voice_preview", input.idempotency_key, async () => {
      await this.checkQuota();
      const jobId = await this.enqueue("voice_preview", { ...input, text, idempotency_key: undefined });
      await this.audit(ctx, "voice_preview", voice.id, { job_id: jobId, chars: text.length });
      return { job_id: jobId, status: "queued" };
    });
  }

  private async getVoice(id: string) {
    const { rows } = await this.db.query("SELECT * FROM voice WHERE id = $1", [id]);
    if (!rows[0]) throw new ApiError("voice_not_found", `voix ${id} introuvable`, "voice_list donne les voix existantes");
    return rows[0];
  }

  private async getReference(voiceId: string, refId: string) {
    const { rows } = await this.db.query("SELECT * FROM voice_reference WHERE id = $1 AND voice_id = $2", [refId, voiceId]);
    if (!rows[0]) throw new ApiError("not_found", `référence ${refId} introuvable pour la voix ${voiceId}`);
    return rows[0];
  }

  // Choisit la référence : celle demandée, sinon celle dont l'étiquette colle au ton, sinon la référence par défaut.
  private async pickReference(voice: any, refId?: string, tag?: string) {
    if (refId) return this.getReference(voice.id, refId);
    if (tag) {
      const { rows } = await this.db.query("SELECT * FROM voice_reference WHERE voice_id = $1 AND tag = $2 ORDER BY created_at LIMIT 1", [voice.id, tag]);
      if (rows[0]) return rows[0];
    }
    return this.getReference(voice.id, voice.default_reference_id);
  }

  // ---------- jobs ----------

  private jobView(j: any) {
    return {
      job_id: j.id,
      type: j.type,
      status: j.status,
      progress: j.progress,
      items: j.items,
      result: j.result,
      error: j.error,
      gpu_seconds: Math.round(j.gpu_seconds * 100) / 100,
      cost_eur: Math.round(j.cost_eur * 10000) / 10000,
      created_at: j.created_at,
      started_at: j.started_at,
      finished_at: j.finished_at,
    };
  }

  async jobStatus(input: { job_id: string; wait_seconds?: number }, ctx: Ctx) {
    requireScope(ctx, "projects:read");
    const wait = Math.max(0, Math.min(25, input.wait_seconds ?? 0));
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      const { rows } = await this.db.query("SELECT * FROM job WHERE id = $1", [input.job_id]);
      if (!rows[0]) throw new ApiError("not_found", `job ${input.job_id} introuvable`);
      if (TERMINAL.has(rows[0].status) || Date.now() >= deadline) return this.jobView(rows[0]);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  start(concurrency = 2) {
    if (this.running) return;
    this.running = true;
    // Un job resté « running » après un redémarrage est remis dans la file.
    this.loops.push(
      this.db
        .query(`UPDATE job SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END WHERE status = 'running'`)
        .then(() => undefined),
    );
    for (let i = 0; i < concurrency; i++) this.loops.push(this.loop());
  }

  async stop() {
    this.running = false;
    this.wake.splice(0).forEach((w) => w());
    await Promise.all(this.loops);
    this.loops = [];
  }

  private async loop() {
    while (this.running) {
      const job = await this.claim().catch(() => undefined);
      if (!job) {
        await new Promise<void>((r) => {
          const w = () => {
            clearTimeout(t);
            r();
          };
          const t = setTimeout(() => {
            this.wake = this.wake.filter((x) => x !== w);
            r();
          }, 1000);
          this.wake.push(w);
        });
        continue;
      }
      await this.runJob(job);
    }
  }

  private async claim() {
    const { rows } = await this.db.query(
      `UPDATE job SET status = 'running', started_at = COALESCE(started_at, now()), attempts = attempts + 1
       WHERE id = (SELECT id FROM job WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
    );
    return rows[0];
  }

  // Attend qu'un job soit terminé (tests et outils internes).
  async waitJob(jobId: string, timeoutMs = 30000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const { rows } = await this.db.query("SELECT * FROM job WHERE id = $1", [jobId]);
      if (TERMINAL.has(rows[0]?.status)) return this.jobView(rows[0]);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`job ${jobId} non terminé`);
  }

  private async runJob(job: any) {
    const log = (msg: string, extra: object = {}) =>
      console.log(JSON.stringify({ at: new Date().toISOString(), job_id: job.id, type: job.type, msg, ...extra }));
    log("job démarré");
    try {
      let out: { status: string; result: unknown };
      if (job.type === "voice_create") out = await this.runVoiceCreate(job);
      else if (job.type === "voice_preview") out = await this.runVoicePreview(job);
      else throw new ApiError("internal", `type de job inconnu : ${job.type}`);
      const { status, result } = out;
      await this.db.query("UPDATE job SET status = $2, result = $3, progress = 1, finished_at = now() WHERE id = $1", [job.id, status, JSON.stringify(result)]);
      log("job terminé", { status });
    } catch (e) {
      const err = toApiError(e);
      log("job en échec", { error: err.toJSON() });
      const again = err.retryable && err.code !== "quota_exceeded" && job.attempts < MAX_ATTEMPTS;
      await this.db.query("UPDATE job SET status = $2, error = $3, finished_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END WHERE id = $1", [
        job.id,
        again ? "queued" : "failed",
        JSON.stringify(err.toJSON()),
      ]);
      if (!again && job.type === "voice_create") {
        await this.db.query("UPDATE voice SET status = 'failed', error = $2 WHERE id = $1", [job.input.voice_id, err.message]);
      }
    }
  }

  private async setItems(jobId: string, items: object[], progress: number) {
    await this.db.query("UPDATE job SET items = $2, progress = $3 WHERE id = $1", [jobId, JSON.stringify(items), progress]);
  }

  private async addGpu(jobId: string, seconds: number) {
    await this.db.query("UPDATE job SET gpu_seconds = gpu_seconds + $2, cost_eur = cost_eur + $3 WHERE id = $1", [
      jobId,
      seconds,
      seconds * this.config.gpuEurPerSecond,
    ]);
  }

  private async runVoiceCreate(job: any) {
    const { voice_id, reference_media_ids, tags } = job.input;
    const items: any[] = [];
    // Un nouvel essai repart de zéro : pas de références en double.
    await this.db.query("DELETE FROM voice_reference WHERE voice_id = $1", [voice_id]);
    const total = reference_media_ids.length + 1;
    let firstRef: string | undefined;
    let poseRef: string | undefined;
    for (const [i, mediaId] of (reference_media_ids as string[]).entries()) {
      const m = await this.getMediaRow(mediaId);
      const raw = await this.store.get(m.storage_key);
      const duration = await audio.probeDuration(raw);
      if (duration < REFERENCE_MIN_S) {
        throw new ApiError("reference_invalid", `l'extrait ${mediaId} dure ${duration.toFixed(1)} s, il faut au moins ${REFERENCE_MIN_S} s`, "un extrait de 20 s à 1 min de parole claire donne le meilleur clone");
      }
      const clean = await audio.cleanReference(raw, REFERENCE_MAX_S);
      const cleanId = await this.storeGenerated(clean, {
        kind: "audio",
        mime: "audio/wav",
        filename: m.filename.replace(/\.[^.]+$/, "") + ".clean.wav",
        variant: "clean",
        parentId: m.id,
        duration: Math.min(duration, REFERENCE_MAX_S),
      });
      const tag = tags?.[i] ?? "posé";
      const refId = newId("ref");
      await this.db.query(
        "INSERT INTO voice_reference (id, voice_id, media_id, clean_media_id, tag, duration_s) VALUES ($1,$2,$3,$4,$5,$6)",
        [refId, voice_id, m.id, cleanId, tag, Math.min(duration, REFERENCE_MAX_S)],
      );
      firstRef ??= refId;
      if (tag === "posé") poseRef ??= refId;
      items.push({ media_id: mediaId, reference_id: refId, tag, duration_s: duration, truncated: duration > REFERENCE_MAX_S, status: "ok" });
      await this.setItems(job.id, items, (i + 1) / total);
    }
    // Le consentement est enregistré à la création : la voix devient utilisable maintenant.
    await this.db.query("UPDATE voice SET status = 'ready', default_reference_id = $2, error = NULL WHERE id = $1", [voice_id, poseRef ?? firstRef]);
    const voice = await this.getVoice(voice_id);
    if (!this.synth) {
      items.push({ step: "preview", status: "skipped", reason: "aucun worker GPU configuré" });
      await this.setItems(job.id, items, 1);
      return { status: "partial", result: { voice_id, status: "ready", preview_media_id: null } };
    }
    try {
      const preview = await this.synthesize(job.id, voice, { text: PREVIEW_SENTENCE });
      await this.db.query("UPDATE voice SET preview_media_id = $2 WHERE id = $1", [voice_id, preview.media_id]);
      items.push({ step: "preview", status: "ok", media_id: preview.media_id });
      await this.setItems(job.id, items, 1);
      return { status: "succeeded", result: { voice_id, status: "ready", preview_media_id: preview.media_id, preview } };
    } catch (e) {
      const err = toApiError(e);
      items.push({ step: "preview", status: "failed", error: err.toJSON() });
      await this.setItems(job.id, items, 1);
      return { status: "partial", result: { voice_id, status: "ready", preview_media_id: null } };
    }
  }

  private async runVoicePreview(job: any) {
    const voice = await this.getVoice(job.input.voice_id);
    const result = await this.synthesize(job.id, voice, job.input);
    return { status: "succeeded", result };
  }

  private async synthesize(
    jobId: string,
    voice: any,
    input: { text: string; reference_id?: string; tone?: string; seed?: number; overrides?: { exaggeration?: number; cfg_weight?: number; temperature?: number } },
  ) {
    const toneName = toneFromHint(input.tone);
    const tone = TONES[toneName];
    const ref = await this.pickReference(voice, input.reference_id, tone.reference_tag);
    const refMedia = await this.getMediaRow(ref.clean_media_id ?? ref.media_id);
    const ttl = this.config.signedUrlTtlSeconds;
    const mediaId = newId("med");
    const key = `gen/${mediaId}.wav`;
    const params = {
      model: "chatterbox-multilingual",
      language: voice.language,
      seed: input.seed ?? randomInt(0, 2 ** 31 - 1),
      reference_id: ref.id,
      tone: toneName,
      exaggeration: input.overrides?.exaggeration ?? tone.exaggeration,
      cfg_weight: input.overrides?.cfg_weight ?? tone.cfg_weight,
      temperature: input.overrides?.temperature ?? tone.temperature,
    };
    const res = await this.synth!.synthesize({
      text: input.text,
      language: voice.language,
      reference_url: await this.store.signedGetUrl(refMedia.storage_key, ttl),
      output_put_url: await this.store.signedPutUrl(key, ttl, "audio/wav"),
      seed: params.seed,
      exaggeration: params.exaggeration,
      cfg_weight: params.cfg_weight,
      temperature: params.temperature,
    });
    await this.addGpu(jobId, res.gpu_seconds);
    const wav = await this.store.get(key);
    await this.storeGenerated(wav, {
      id: mediaId,
      key,
      kind: "audio",
      mime: "audio/wav",
      filename: `${voice.name}-${mediaId}.wav`.replace(/[^\w.-]+/g, "_"),
      variant: "original",
      duration: res.duration_s,
      meta: { source: "tts", voice_id: voice.id, params: { ...params, model: res.model }, prepared_text: res.prepared_text, segments: res.segments },
    });
    const words = input.text.split(/\s+/).filter(Boolean).length;
    return {
      media_id: mediaId,
      url: await this.store.signedGetUrl(key, ttl, `${mediaId}.wav`),
      duration_s: res.duration_s,
      params: { ...params, model: res.model },
      // La mesure demandée par J1 : vitesse réelle (secondes GPU par seconde d'audio) et coût.
      gpu_seconds: res.gpu_seconds,
      real_time_factor: res.duration_s ? Math.round((res.gpu_seconds / res.duration_s) * 1000) / 1000 : null,
      cost_eur: Math.round(res.gpu_seconds * this.config.gpuEurPerSecond * 10000) / 10000,
      words_per_minute: res.duration_s ? Math.round((words / res.duration_s) * 60) : null,
      target_words_per_minute: tone.words_per_minute,
    };
  }
}
