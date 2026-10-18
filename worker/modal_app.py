"""Worker GPU du studio voix : Chatterbox Multilingual sur Modal, facturé à la seconde.

Déploiement : `modal deploy worker/modal_app.py` (voir DEPLOIEMENT.md).
Contrat : POST JSON SynthesisRequest (src/synth.ts) avec `Authorization: Bearer <WORKER_TOKEN>`,
réponse SynthesisResult. La référence est lue et le WAV écrit par URL signée : aucun fichier ne
transite par l'API.
"""

from __future__ import annotations

import io
import os
import random
import tempfile
import time
import urllib.request

import modal

CHATTERBOX_VERSION = "0.1.7"


def download_weights():
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    ChatterboxMultilingualTTS.from_pretrained(device="cpu")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(f"chatterbox-tts=={CHATTERBOX_VERSION}", "num2words==0.5.14", "soundfile", "fastapi[standard]")
    # Poids préchargés dans l'image : pas de téléchargement au démarrage à froid.
    .run_function(download_weights)
    .add_local_python_source("textprep", "assemble")
)

app = modal.App("studio-voix-worker", image=image)

with image.imports():
    # Présents dans l'image seulement ; FastAPI résout l'annotation `Request` dans le conteneur.
    from fastapi import HTTPException, Request


@app.cls(
    gpu=os.environ.get("STUDIO_GPU", "L4"),
    timeout=900,
    scaledown_window=120,
    secrets=[modal.Secret.from_name("studio-voix-worker")],
)
class Worker:
    @modal.enter()
    def load(self):
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        self.torch = torch
        self.model = ChatterboxMultilingualTTS.from_pretrained(device="cuda")
        self.sr = self.model.sr

    @modal.fastapi_endpoint(method="POST")
    async def synthesize(self, request: Request):
        import asyncio

        raise_if_unauthorized(request.headers.get("authorization"))
        body = await request.json()
        # La synthèse bloque : elle tourne hors de la boucle d'événements.
        return await asyncio.to_thread(self.run, body)

    def run(self, body: dict) -> dict:
        import numpy as np
        import soundfile as sf

        from assemble import join
        from textprep import pause_after, segments

        segs = segments(body["text"])
        if not segs:
            raise HTTPException(status_code=422, detail="texte vide après préparation")
        if len(segs) > 40:
            raise HTTPException(status_code=422, detail=f"{len(segs)} segments : découpe le bloc")

        seed = int(body.get("seed", 0))
        random.seed(seed)
        np.random.seed(seed % (2**32))
        self.torch.manual_seed(seed)

        with tempfile.NamedTemporaryFile(suffix=".wav") as ref:
            ref.write(_get(body["reference_url"]))
            ref.flush()
            started = time.monotonic()
            self.model.prepare_conditionals(ref.name, exaggeration=float(body["exaggeration"]))
            pieces = []
            for s in segs:
                wav = self.model.generate(
                    s,
                    language_id=body.get("language", "fr"),
                    exaggeration=float(body["exaggeration"]),
                    cfg_weight=float(body["cfg_weight"]),
                    temperature=float(body["temperature"]),
                )
                pieces.append(wav.squeeze(0).cpu().numpy().astype("float32"))
            self.torch.cuda.synchronize()
            gpu_seconds = time.monotonic() - started

        audio = join(pieces, [pause_after(s) for s in segs], self.sr)
        buf = io.BytesIO()
        sf.write(buf, audio, self.sr, format="WAV", subtype="PCM_16")
        _put(body["output_put_url"], buf.getvalue(), "audio/wav")
        return {
            "duration_s": round(len(audio) / self.sr, 3),
            "sample_rate": self.sr,
            "gpu_seconds": round(gpu_seconds, 3),
            "model": f"chatterbox-multilingual@{CHATTERBOX_VERSION}",
            "segments": [{"text": s, "duration_s": round(len(p) / self.sr, 3)} for s, p in zip(segs, pieces)],
            "prepared_text": " ".join(segs),
        }


def raise_if_unauthorized(authorization: str | None):
    import hmac

    want = os.environ.get("WORKER_TOKEN", "")
    got = (authorization or "").removeprefix("Bearer ").strip()
    if not want or not hmac.compare_digest(want, got):
        raise HTTPException(status_code=401, detail="jeton du worker invalide")


def _get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def _put(url: str, data: bytes, content_type: str):
    req = urllib.request.Request(url, data=data, method="PUT", headers={"content-type": content_type})
    with urllib.request.urlopen(req, timeout=300) as r:
        if r.status >= 300:
            raise RuntimeError(f"écriture refusée : {r.status}")
