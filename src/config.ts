// Toute la configuration vient de l'environnement (secrets Fly en production).
export interface Config {
  publicUrl: string;
  port: number;
  databaseUrl?: string;
  apiKey?: string;
  ownerPassword?: string;
  tokenSecret: string;
  storage:
    | { kind: "s3"; bucket: string; endpoint?: string; region: string; publicBase?: string }
    | { kind: "local"; dir: string };
  worker: { url?: string; token?: string };
  gpuEurPerSecond: number;
  gpuDailyCapEur: number;
  github?: { token: string; repo: string };
  signedUrlTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/$/, "");
  const tokenSecret = env.TOKEN_SECRET ?? "";
  if (!tokenSecret && env.NODE_ENV === "production") throw new Error("TOKEN_SECRET manquant");
  return {
    publicUrl,
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL,
    apiKey: env.API_KEY,
    ownerPassword: env.OWNER_PASSWORD,
    tokenSecret: tokenSecret || "dev-secret-ne-pas-utiliser-en-production",
    // `fly storage create` (Tigris) pose BUCKET_NAME et les variables AWS_* sur l'application.
    storage: (env.S3_BUCKET ?? env.BUCKET_NAME)
      ? {
          kind: "s3",
          bucket: (env.S3_BUCKET ?? env.BUCKET_NAME)!,
          endpoint: env.AWS_ENDPOINT_URL_S3,
          region: env.AWS_REGION ?? "auto",
          publicBase: env.MEDIA_PUBLIC_BASE,
        }
      : { kind: "local", dir: env.LOCAL_STORAGE_DIR ?? ".data/objects" },
    worker: { url: env.WORKER_URL, token: env.WORKER_TOKEN },
    gpuEurPerSecond: Number(env.GPU_EUR_PER_SECOND ?? 0.00025),
    gpuDailyCapEur: Number(env.GPU_DAILY_CAP_EUR ?? 10),
    github:
      env.GITHUB_TOKEN && env.GITHUB_EXPORTS_REPO
        ? { token: env.GITHUB_TOKEN, repo: env.GITHUB_EXPORTS_REPO }
        : undefined,
    signedUrlTtlSeconds: Number(env.SIGNED_URL_TTL_SECONDS ?? 3600),
  };
}
