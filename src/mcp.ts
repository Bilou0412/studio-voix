import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { CONSENT_STATEMENT, PREVIEW_SENTENCE, Studio, type Ctx } from "./studio.js";
import { toApiError } from "./errors.js";

// Les outils MCP du jalon J1. Chaque outil est une fine couche sur une méthode de Studio,
// comme l'endpoint /v1 correspondant. Sorties en JSON compact, fichiers par URL signée.

function ctxFrom(auth: AuthInfo | undefined, ip?: string): Ctx {
  return { actor: auth?.clientId ?? "anonyme", scopes: auth?.scopes ?? [], ip };
}

function ok(out: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
}

function fail(e: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: toApiError(e).toJSON() }) }], isError: true };
}

const idem = z.string().max(200).optional().describe("Clé d'idempotence : deux appels avec la même clé ne créent qu'une fois.");

export function buildMcpServer(studio: Studio, ip?: string) {
  const server = new McpServer({ name: "studio-voix", version: "0.1.0" });
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    fn: (args: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<unknown>,
  ) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: any, extra: any) => {
      try {
        return ok(await fn(args, ctxFrom(extra.authInfo, ip)));
      } catch (e) {
        return fail(e);
      }
    }) as any);

  tool(
    "media_upload_init",
    "Prépare le dépôt d'un fichier (extrait de voix, vidéo, capture) avant de l'utiliser ailleurs. Rend une put_url signée valable 1 h (canal A : `curl -X PUT -H 'content-type: …' --data-binary @fichier put_url`) et, si le canal GitHub est configuré, la commande `gh release upload` du canal B. Si le même sha256 est déjà stocké, rend directement le media_id existant (status ready). Après l'envoi, appeler media_upload_complete.",
    {
      filename: z.string().describe("Nom du fichier, avec son extension (voix_echantillon.mp3)."),
      size: z.number().int().positive().describe("Taille en octets."),
      sha256: z.string().describe("Empreinte sha256 du fichier, en hexadécimal minuscule (`sha256sum fichier`)."),
      kind: z.enum(["audio", "video", "image", "json", "text"]),
      meta: z.record(z.string(), z.unknown()).optional().describe("Métadonnées libres : source, compte, crédit, droits, flouté."),
      project: z.string().optional(),
      idempotency_key: idem,
    },
    (a, ctx) => studio.mediaUploadInit(a, ctx),
  );

  tool(
    "media_upload_chunk",
    "Canal de secours pour les petits fichiers (moins de 200 Ko au total) quand ni la put_url ni GitHub ne sont joignables : envoie un morceau en base64 (512 Ko au plus). Index à partir de 0, puis media_upload_complete.",
    {
      upload_id: z.string(),
      index: z.number().int().min(0),
      data_b64: z.string().describe("Octets du morceau, en base64."),
    },
    (a, ctx) => studio.mediaUploadChunk(a, ctx),
  );

  tool(
    "media_upload_complete",
    "Termine un dépôt commencé par media_upload_init, quel que soit le canal utilisé (put_url, release GitHub, morceaux) : vérifie le sha256 et la taille, puis rend le média prêt (status ready, durée en secondes pour l'audio).",
    { upload_id: z.string() },
    (a, ctx) => studio.mediaUploadComplete(a, ctx),
  );

  tool(
    "media_get",
    "Donne l'URL signée (1 h) d'un média et ses métadonnées. variant : original (défaut), clean (extrait nettoyé), preview (MP3 128 kb/s, créé à la demande). channel=github publie aussi le fichier en asset de release et rend la commande `gh release download` (canal B, quand le domaine média n'est pas autorisé).",
    {
      media_id: z.string(),
      variant: z.enum(["original", "clean", "preview"]).optional(),
      channel: z.enum(["url", "github"]).optional(),
    },
    (a, ctx) => studio.mediaGet(a, ctx),
  );

  tool(
    "voice_create",
    `Crée une voix clonée à partir d'un ou plusieurs extraits déjà déposés (media_id d'audios de 10 s à 5 min). Exige le consentement : consent.statement = « ${CONSENT_STATEMENT} » et consent.accepted_at = horodatage ISO 8601 du moment où la personne l'a donné. Asynchrone : rend un job_id ; quand job_status passe à succeeded, la voix est ready et preview_media_id contient la phrase test. Demande la portée voices:write.`,
    {
      name: z.string().min(1).max(80),
      reference_media_ids: z.array(z.string()).min(1),
      tags: z.array(z.enum(["posé", "intime", "incisif", "hésitant"])).optional().describe("Un ton par extrait, dans le même ordre ; « posé » par défaut."),
      language: z.string().optional().describe("Code langue, « fr » par défaut."),
      consent: z.object({ statement: z.string(), accepted_at: z.string() }),
      idempotency_key: idem,
    },
    (a, ctx) => studio.voiceCreate(a, ctx),
  );

  tool(
    "voice_list",
    "Liste les voix, leurs références étiquetées par ton et leur statut (processing, ready, failed).",
    {},
    (_a, ctx) => studio.voiceList(ctx),
  );

  tool(
    "voice_preview",
    `Fait dire un texte à une voix prête, pour écouter le clone (par défaut la phrase test : « ${PREVIEW_SENTENCE} »). Sert aussi à générer un bloc du script au jalon 1 : text = le texte du bloc (2000 caractères au plus), tone = son indication [calme], [incisif], [vérification], [plus lent]… Asynchrone : rend un job_id ; le résultat de job_status donne media_id, url, durée en secondes, secondes GPU, facteur temps réel et coût en euros.`,
    {
      voice_id: z.string(),
      reference_id: z.string().optional().describe("Référence à utiliser ; sinon celle qui correspond au ton."),
      text: z.string().optional(),
      tone: z.string().optional().describe("Indication de ton du script ; neutre par défaut."),
      seed: z.number().int().min(0).optional(),
      overrides: z
        .object({
          exaggeration: z.number().min(0).max(2).optional(),
          cfg_weight: z.number().min(0).max(1).optional(),
          temperature: z.number().min(0.05).max(2).optional(),
        })
        .optional(),
      idempotency_key: idem,
    },
    (a, ctx) => studio.voicePreview(a, ctx),
  );

  tool(
    "job_status",
    "Suit un job asynchrone : statut (queued, running, succeeded, partial, failed, cancelled), progression de 0 à 1, détail par élément, erreurs, secondes GPU et coût en euros. wait_seconds (25 au plus) attend la fin du job avant de répondre : préférer un appel avec wait_seconds=25 à des appels en boucle.",
    { job_id: z.string(), wait_seconds: z.number().min(0).max(25).optional() },
    (a, ctx) => studio.jobStatus(a, ctx),
  );

  return server;
}
