"""Worker CPU du studio voix sur Fly : la même synthèse que modal_app.py, sans GPU.

La machine s'éteint seule quand personne ne l'appelle et redémarre à la requête suivante.
Une synthèse CPU dure plusieurs minutes : la réponse est envoyée au fil de l'eau, une espace
toutes les 15 s puis le JSON, pour que le proxy ne coupe pas une connexion muette. Le statut HTTP
part donc avant le résultat : une erreur arrive dans le corps, {"error": {"status", "detail"}}.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from engine import TextRejected, load_model, synthesize, token_ok

KEEPALIVE_SECONDS = 15

app = FastAPI()
_model = None
_loaded = threading.Event()
_load_error: Exception | None = None
# Une synthèse à la fois : deux en parallèle se partageraient les mêmes cœurs.
_busy = asyncio.Lock()


def _load():
    global _model, _load_error
    try:
        import torch

        torch.set_num_threads(os.cpu_count() or 1)
        _model = load_model("cpu")
    except Exception as e:  # rendu à chaque requête plutôt que de tuer la machine en boucle
        _load_error = e
    finally:
        _loaded.set()


# Le port écoute tout de suite ; le modèle se charge à côté.
threading.Thread(target=_load, daemon=True).start()


@app.get("/healthz")
def healthz():
    return {"ok": True, "model_loaded": _model is not None}


@app.post("/synthesize")
async def synthesize_endpoint(request: Request):
    if not token_ok(request.headers.get("authorization"), os.environ.get("WORKER_TOKEN", "")):
        return JSONResponse({"detail": "jeton du worker invalide"}, status_code=401)
    body = await request.json()

    async def run() -> dict:
        async with _busy:
            await asyncio.to_thread(_loaded.wait)
            if _model is None:
                return {"error": {"status": 503, "detail": f"modèle non chargé : {_load_error}"}}
            try:
                return await asyncio.to_thread(synthesize, _model, body)
            except TextRejected as e:
                return {"error": {"status": 422, "detail": str(e)}}
            except Exception as e:
                return {"error": {"status": 500, "detail": f"{type(e).__name__}: {e}"}}

    async def stream():
        task = asyncio.create_task(run())
        while True:
            done, _ = await asyncio.wait({task}, timeout=KEEPALIVE_SECONDS)
            if done:
                break
            yield b" "
        yield json.dumps(task.result()).encode()

    return StreamingResponse(stream(), media_type="application/json")
