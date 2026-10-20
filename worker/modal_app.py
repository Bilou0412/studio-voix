"""Worker GPU du studio voix : Chatterbox Multilingual sur Modal, facturé à la seconde.

Hébergement optionnel (variable de dépôt WORKER_BACKEND=modal) ; par défaut le worker tourne en
CPU sur Fly (server.py). Contrat : POST JSON SynthesisRequest (src/synth.ts) avec
`Authorization: Bearer <WORKER_TOKEN>`, réponse SynthesisResult.
"""

from __future__ import annotations

import os

import modal

from engine import CHATTERBOX_VERSION


def download_weights():
    from engine import load_model

    load_model("cpu")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(f"chatterbox-tts=={CHATTERBOX_VERSION}", "num2words==0.5.14", "soundfile", "fastapi[standard]")
    .add_local_python_source("engine", "textprep", "assemble", copy=True)
    # Poids préchargés dans l'image : pas de téléchargement au démarrage à froid.
    .run_function(download_weights)
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
        from engine import load_model

        self.model = load_model("cuda")

    @modal.fastapi_endpoint(method="POST")
    async def synthesize(self, request: Request):
        import asyncio

        from engine import TextRejected, synthesize, token_ok

        if not token_ok(request.headers.get("authorization"), os.environ.get("WORKER_TOKEN", "")):
            raise HTTPException(status_code=401, detail="jeton du worker invalide")
        body = await request.json()
        try:
            # La synthèse bloque : elle tourne hors de la boucle d'événements.
            return await asyncio.to_thread(synthesize, self.model, body)
        except TextRejected as e:
            raise HTTPException(status_code=422, detail=str(e))
