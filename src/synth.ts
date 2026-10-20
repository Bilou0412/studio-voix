import type { Config } from "./config.js";
import { ApiError } from "./errors.js";

// Le contrat entre l'API et le worker de synthèse (worker/engine.py, servi par Fly en CPU ou Modal
// en GPU). Le worker lit la référence par URL signée, écrit le WAV par URL signée, et rend sa
// mesure de temps de calcul (gpu_seconds, même en CPU).
export interface SynthesisRequest {
  text: string;
  language: string;
  reference_url: string;
  output_put_url: string;
  seed: number;
  exaggeration: number;
  cfg_weight: number;
  temperature: number;
}

export interface SynthesisResult {
  duration_s: number;
  sample_rate: number;
  gpu_seconds: number;
  model: string;
  segments: { text: string; duration_s: number }[];
  prepared_text: string;
}

export interface Synthesizer {
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;
}

export class HttpSynthesizer implements Synthesizer {
  constructor(
    private url: string,
    private token: string,
    private timeoutMs = 15 * 60 * 1000,
  ) {}
  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw new ApiError("gpu_unavailable", `worker de synthèse injoignable : ${(e as Error).message}`, "réessayer dans une minute");
    }
    // Le worker Fly répond 200 dès le départ et met une éventuelle erreur dans le corps.
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const status = body?.error?.status ?? res.status;
    const detail = body?.error?.detail ?? body?.detail;
    if (status === 422) throw new ApiError("text_too_long", detail ?? "texte refusé par le worker");
    if (status >= 300 || !body || body.error) {
      throw new ApiError("gpu_unavailable", `worker de synthèse en erreur ${status} : ${String(detail ?? text).slice(0, 400)}`);
    }
    return body as SynthesisResult;
  }
}

export function makeSynthesizer(config: Config): Synthesizer | undefined {
  if (config.worker.url && config.worker.token) return new HttpSynthesizer(config.worker.url, config.worker.token, config.worker.timeoutSeconds * 1000);
  return undefined;
}

// Réglages par ton, tableau « Réglages par ton » de la spec.
export interface TonePreset {
  reference_tag: string;
  exaggeration: number;
  cfg_weight: number;
  temperature: number;
  words_per_minute: [number, number];
}

export const TONES: Record<string, TonePreset> = {
  neutre: { reference_tag: "posé", exaggeration: 0.5, cfg_weight: 0.5, temperature: 0.8, words_per_minute: [150, 170] },
  intime: { reference_tag: "intime", exaggeration: 0.35, cfg_weight: 0.4, temperature: 0.7, words_per_minute: [130, 150] },
  incisif: { reference_tag: "incisif", exaggeration: 0.7, cfg_weight: 0.35, temperature: 0.85, words_per_minute: [160, 180] },
  nuance: { reference_tag: "posé", exaggeration: 0.45, cfg_weight: 0.5, temperature: 0.75, words_per_minute: [140, 160] },
  lent: { reference_tag: "intime", exaggeration: 0.3, cfg_weight: 0.45, temperature: 0.7, words_per_minute: [115, 135] },
};

// Une indication libre du script ([calme], [plus dur], [vérification]…) vers l'un des cinq tons.
export function toneFromHint(hint?: string): keyof typeof TONES {
  const h = (hint ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/lent|fin\b/.test(h)) return "lent";
  if (/calme|intime|sincere/.test(h)) return "intime";
  if (/incisif|dur/.test(h)) return "incisif";
  if (/verif|nuance/.test(h)) return "nuance";
  return "neutre";
}
