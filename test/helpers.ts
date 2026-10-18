import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { LocalStore } from "../src/storage.js";
import { Studio } from "../src/studio.js";
import { OwnerOAuthProvider } from "../src/oauth.js";
import { buildApp } from "../src/app.js";
import type { SynthesisRequest, SynthesisResult, Synthesizer } from "../src/synth.js";

export const API_KEY = "cle-de-test";
export const PASSWORD = "mot-de-passe-de-test";

export function tone(seconds: number, freq = 220): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "sv-test-"));
  const f = path.join(dir, "a.mp3");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-ac", "1", f]);
  return readFileSync(f);
}

export const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Remplace le worker GPU : écrit un WAV par l'URL signée, comme le vrai worker.
export class FakeSynth implements Synthesizer {
  calls: SynthesisRequest[] = [];
  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    this.calls.push(req);
    const ref = await fetch(req.reference_url);
    if (!ref.ok) throw new Error(`référence illisible : ${ref.status}`);
    const seconds = Math.max(1, req.text.length / 15);
    const dir = mkdtempSync(path.join(tmpdir(), "sv-synth-"));
    const f = path.join(dir, "o.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-ar", "24000", "-ac", "1", f]);
    const put = await fetch(req.output_put_url, { method: "PUT", body: new Uint8Array(readFileSync(f)), headers: { "content-type": "audio/wav" } });
    if (!put.ok) throw new Error(`écriture refusée : ${put.status}`);
    return {
      duration_s: seconds,
      sample_rate: 24000,
      gpu_seconds: seconds * 0.5,
      model: "chatterbox-multilingual@fake",
      segments: [{ text: req.text, duration_s: seconds }],
      prepared_text: req.text,
    };
  }
}

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export async function startTestServer(env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sv-store-"));
  const db = await openDb();
  const synth = new FakeSynth();
  const url = `http://localhost:${await freePort()}`;
  const config = loadConfig({ API_KEY, OWNER_PASSWORD: PASSWORD, TOKEN_SECRET: "s", LOCAL_STORAGE_DIR: dir, PUBLIC_URL: url, ...env } as any);
  const store = new LocalStore(dir, url, config.tokenSecret);
  const studio = new Studio({ config, db, store, synth });
  const oauth = new OwnerOAuthProvider(db, { ownerPassword: PASSWORD, apiKey: API_KEY });
  const real = await new Promise<import("node:http").Server>((resolve) => {
    const s = buildApp(studio, oauth).listen(Number(new URL(url).port), "127.0.0.1", () => resolve(s));
  });
  studio.start(2);
  const api = async (method: string, p: string, body?: unknown, token = API_KEY) => {
    const res = await fetch(url + p, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return {
    url,
    db,
    studio,
    synth,
    api,
    async close() {
      real.close();
      await studio.stop();
      await db.close();
    },
  };
}

export async function uploadViaPut(api: Awaited<ReturnType<typeof startTestServer>>["api"], data: Buffer, filename = "voix_echantillon.mp3") {
  const init = await api("POST", "/v1/media", { filename, size: data.length, sha256: sha(data), kind: "audio" });
  if (init.body.status === "ready") return init.body.media_id as string;
  const put = await fetch(init.body.put_url, { method: "PUT", body: new Uint8Array(data), headers: init.body.put_headers });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
  const done = await api("POST", `/v1/media/${init.body.upload_id}/complete`);
  if (done.status !== 200) throw new Error(JSON.stringify(done.body));
  return done.body.media_id as string;
}
