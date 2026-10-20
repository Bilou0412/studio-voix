import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HttpSynthesizer, type SynthesisRequest } from "../src/synth.js";

// Le worker Fly répond 200 tout de suite, envoie des espaces pendant le calcul, puis le JSON.
async function fakeWorker(final: unknown) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer t") return res.writeHead(401).end('{"detail":"jeton"}');
      res.writeHead(200, { "content-type": "application/json" });
      let n = 0;
      const timer = setInterval(() => {
        if (n++ < 3) return res.write(" ");
        clearInterval(timer);
        res.end(JSON.stringify(final));
      }, 20);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/synthesize` };
}

const req: SynthesisRequest = {
  text: "Bonjour.",
  language: "fr",
  reference_url: "http://x/ref",
  output_put_url: "http://x/out",
  seed: 1,
  exaggeration: 0.5,
  cfg_weight: 0.5,
  temperature: 0.8,
};

test("le résultat arrive après les espaces de maintien", async () => {
  const result = { duration_s: 1, sample_rate: 24000, gpu_seconds: 3, model: "m", segments: [], prepared_text: "Bonjour." };
  const w = await fakeWorker(result);
  try {
    assert.deepEqual(await new HttpSynthesizer(w.url, "t").synthesize(req), result);
  } finally {
    w.server.close();
  }
});

test("une erreur dans le corps est rendue avec son code", async () => {
  const w = await fakeWorker({ error: { status: 422, detail: "41 segments : découpe le bloc" } });
  try {
    await assert.rejects(new HttpSynthesizer(w.url, "t").synthesize(req), (e: any) => e.code === "text_too_long" && /41 segments/.test(e.message));
  } finally {
    w.server.close();
  }
});

test("un mauvais jeton ou une panne du worker donne gpu_unavailable", async () => {
  const w = await fakeWorker({ error: { status: 503, detail: "modèle non chargé" } });
  try {
    await assert.rejects(new HttpSynthesizer(w.url, "t").synthesize(req), (e: any) => e.code === "gpu_unavailable" && /503/.test(e.message));
    await assert.rejects(new HttpSynthesizer(w.url, "faux").synthesize(req), (e: any) => e.code === "gpu_unavailable" && /401/.test(e.message));
  } finally {
    w.server.close();
  }
});
