import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { makeStore } from "./storage.js";
import { makeSynthesizer } from "./synth.js";
import { GithubReleases } from "./github.js";
import { Studio } from "./studio.js";
import { OwnerOAuthProvider } from "./oauth.js";
import { buildApp } from "./app.js";

const config = loadConfig();
if (process.env.NODE_ENV === "production") {
  for (const k of ["DATABASE_URL", "OWNER_PASSWORD"] as const) {
    if (!process.env[k]) throw new Error(`${k} manquant`);
  }
  if (config.storage.kind !== "s3") throw new Error("stockage objets manquant (BUCKET_NAME ou S3_BUCKET)");
}
const db = await openDb(config.databaseUrl);
const studio = new Studio({
  config,
  db,
  store: makeStore(config),
  synth: makeSynthesizer(config),
  github: config.github ? new GithubReleases(config.github.token, config.github.repo) : undefined,
});
const oauth = new OwnerOAuthProvider(db, { ownerPassword: config.ownerPassword, apiKey: config.apiKey });
studio.start(Number(process.env.JOB_CONCURRENCY ?? 2));
const server = buildApp(studio, oauth).listen(config.port, () => {
  console.log(JSON.stringify({ msg: "studio-voix démarré", url: config.publicUrl, worker: Boolean(studio.synth), github: Boolean(studio.github) }));
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    server.close();
    await studio.stop();
    await db.close();
    process.exit(0);
  });
}
