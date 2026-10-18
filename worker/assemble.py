"""Recollage des segments synthétisés (étape 3 du pipeline) : coupe sur les silences,
fondu de 20 ms, pause selon la ponctuation. numpy seulement."""

from __future__ import annotations

import numpy as np

FADE_S = 0.02


def trim_silence(wav: np.ndarray, sr: int, threshold_db: float = -45.0, keep_s: float = 0.03) -> np.ndarray:
    if wav.size == 0:
        return wav
    frame = max(1, int(sr * 0.01))
    n = len(wav) // frame
    if n == 0:
        return wav
    rms = np.sqrt(np.mean(wav[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    loud = np.nonzero(20 * np.log10(rms) > threshold_db)[0]
    if loud.size == 0:
        return wav[:0]
    keep = int(sr * keep_s)
    start = max(0, loud[0] * frame - keep)
    end = min(len(wav), (loud[-1] + 1) * frame + keep)
    return wav[start:end]


def fade(wav: np.ndarray, sr: int, seconds: float = FADE_S) -> np.ndarray:
    n = min(len(wav) // 2, int(sr * seconds))
    if n == 0:
        return wav
    out = wav.astype(np.float32, copy=True)
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    out[:n] *= ramp
    out[-n:] *= ramp[::-1]
    return out


def join(pieces: list[np.ndarray], pauses: list[float], sr: int) -> np.ndarray:
    """Recolle les segments ; pauses[i] est le silence après le segment i (le dernier est ignoré)."""
    out: list[np.ndarray] = []
    for i, p in enumerate(pieces):
        out.append(fade(trim_silence(p, sr), sr))
        if i < len(pieces) - 1:
            out.append(np.zeros(int(sr * pauses[i]), dtype=np.float32))
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)
