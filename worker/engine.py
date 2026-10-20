"""Le cœur du worker : Chatterbox Multilingual, du texte à un WAV écrit par URL signée.

Partagé par les deux hébergements du worker : Fly en CPU (server.py) et Modal en GPU (modal_app.py).
Contrat : SynthesisRequest et SynthesisResult de src/synth.ts.
"""

from __future__ import annotations

import io
import random
import tempfile
import time
import urllib.request

from assemble import join
from textprep import pause_after, segments

CHATTERBOX_VERSION = "0.1.7"
MAX_SEGMENTS = 40
_BUILTIN: dict = {}


class TextRejected(Exception):
    """Le texte ne peut pas être synthétisé tel quel (l'API le rend en text_too_long)."""


def load_model(device: str):
    import copy

    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    # La voix intégrée, gardée à part : prepare_conditionals remplace model.conds à chaque voix clonée.
    _BUILTIN["conds"] = copy.deepcopy(model.conds)
    return model


def synthesize(model, body: dict) -> dict:
    import numpy as np
    import soundfile as sf
    import torch

    segs = segments(body["text"])
    if not segs:
        raise TextRejected("texte vide après préparation")
    if len(segs) > MAX_SEGMENTS:
        raise TextRejected(f"{len(segs)} segments : découpe le bloc")

    seed = int(body.get("seed", 0))
    random.seed(seed)
    np.random.seed(seed % (2**32))
    torch.manual_seed(seed)

    with tempfile.NamedTemporaryFile(suffix=".wav") as ref:
        started = time.monotonic()
        if body.get("reference_url"):
            ref.write(_get(body["reference_url"]))
            ref.flush()
            model.prepare_conditionals(ref.name, exaggeration=float(body["exaggeration"]))
        else:
            # Voix intégrée : les conditionnements livrés avec le modèle (conds.pt).
            model.conds = _builtin_conds(model)
        pieces = []
        for s in segs:
            wav = model.generate(
                s,
                language_id=body.get("language", "fr"),
                exaggeration=float(body["exaggeration"]),
                cfg_weight=float(body["cfg_weight"]),
                temperature=float(body["temperature"]),
            )
            pieces.append(wav.squeeze(0).cpu().numpy().astype("float32"))
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        compute_seconds = time.monotonic() - started

    audio = join(pieces, [pause_after(s) for s in segs], model.sr)
    buf = io.BytesIO()
    sf.write(buf, audio, model.sr, format="WAV", subtype="PCM_16")
    _put(body["output_put_url"], buf.getvalue(), "audio/wav")
    return {
        "duration_s": round(len(audio) / model.sr, 3),
        "sample_rate": model.sr,
        "gpu_seconds": round(compute_seconds, 3),
        "model": f"chatterbox-multilingual@{CHATTERBOX_VERSION}",
        "segments": [{"text": s, "duration_s": round(len(p) / model.sr, 3)} for s, p in zip(segs, pieces)],
        "prepared_text": " ".join(segs),
    }


def _builtin_conds(model):
    import copy

    return copy.deepcopy(_BUILTIN["conds"])


def token_ok(authorization: str | None, want: str) -> bool:
    import hmac

    got = (authorization or "").removeprefix("Bearer ").strip()
    return bool(want) and hmac.compare_digest(want, got)


def _get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def _put(url: str, data: bytes, content_type: str):
    req = urllib.request.Request(url, data=data, method="PUT", headers={"content-type": content_type})
    with urllib.request.urlopen(req, timeout=300) as r:
        if r.status >= 300:
            raise RuntimeError(f"écriture refusée : {r.status}")
