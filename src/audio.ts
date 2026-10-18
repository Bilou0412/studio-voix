import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Traitement audio CPU par ffmpeg (worker CPU de la spec) : rien ici n'a besoin de GPU.

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} a échoué (${code}) : ${err.slice(-600)}`))));
  });
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "studio-voix-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function probeDuration(data: Buffer): Promise<number> {
  return withTemp(async (dir) => {
    const f = path.join(dir, "in");
    await writeFile(f, data);
    const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]);
    const d = Number(out.trim());
    if (!Number.isFinite(d)) throw new Error("durée illisible : ce fichier n'est pas un audio reconnu");
    return d;
  });
}

// Nettoyage d'un extrait de référence : passe-haut 75 Hz, débruitage léger, niveau -20 LUFS,
// mono 24 kHz (la fréquence de Chatterbox). Coupé à maxSeconds.
export const CLEAN_FILTER = "highpass=f=75,afftdn=nr=12:nf=-30,loudnorm=I=-20:TP=-2:LRA=11";

export async function cleanReference(data: Buffer, maxSeconds = 300): Promise<Buffer> {
  return withTemp(async (dir) => {
    const inp = path.join(dir, "in");
    const out = path.join(dir, "out.wav");
    await writeFile(inp, data);
    await run("ffmpeg", ["-v", "error", "-y", "-i", inp, "-t", String(maxSeconds), "-af", CLEAN_FILTER, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", out]);
    return readFile(out);
  });
}

// Variante « preview » de la spec : MP3 128 kb/s.
export async function toMp3(data: Buffer): Promise<Buffer> {
  return withTemp(async (dir) => {
    const inp = path.join(dir, "in");
    const out = path.join(dir, "out.mp3");
    await writeFile(inp, data);
    await run("ffmpeg", ["-v", "error", "-y", "-i", inp, "-c:a", "libmp3lame", "-b:a", "128k", out]);
    return readFile(out);
  });
}
