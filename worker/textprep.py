"""Préparation du texte avant synthèse (étape 1 du pipeline de la spec).

Pur Python, sans dépendance au GPU : testé par test_textprep.py.
"""

from __future__ import annotations

import re

from num2words import num2words

MAX_SEGMENT = 250

_BRACKETS = re.compile(r"\[[^\]]*\]")
# 161,6 · 2027 · 10 000 (espaces fines ou insécables entre les milliers)
_NUMBER = re.compile(r"(?<![\w,])(\d{1,3}(?:[   ]\d{3})+|\d+)(?:,(\d+))?(?![\w])")
_PERCENT = re.compile(r"\s*%")
_EURO = re.compile(r"\s*€")
_SPACES = re.compile(r"\s+")


def _number_words(intpart: str, decimals: str | None) -> str:
    n = int(re.sub(r"[   ]", "", intpart))
    words = num2words(n, lang="fr")
    if decimals is not None:
        # « 1,05 » se dit « un virgule zéro cinq » : les zéros de tête sont lus un par un.
        lead = len(decimals) - len(decimals.lstrip("0"))
        rest = decimals.lstrip("0")
        parts = ["zéro"] * lead + ([num2words(int(rest), lang="fr")] if rest else [])
        words += " virgule " + " ".join(parts)
    return words


def strip_directions(text: str) -> tuple[str, list[str]]:
    """Retire les indications [ … ] et les rend à part."""
    hints = [h.strip("[] ") for h in _BRACKETS.findall(text)]
    return _BRACKETS.sub(" ", text), hints


def normalize(text: str) -> str:
    text, _ = strip_directions(text)
    text = _PERCENT.sub(" pour cent", text)
    text = _EURO.sub(" euros", text)
    text = _NUMBER.sub(lambda m: _number_words(m.group(1), m.group(2)), text)
    text = text.replace("’", "'")
    return _SPACES.sub(" ", text).strip()


def _split_long(sentence: str, limit: int) -> list[str]:
    if len(sentence) <= limit:
        return [sentence]
    # D'abord sur la ponctuation faible, puis sur les espaces.
    for pattern in (r"(?<=[,;:])\s+", r"\s+"):
        pieces = re.split(pattern, sentence)
        if len(pieces) == 1:
            continue
        out: list[str] = []
        cur = ""
        for p in pieces:
            cand = f"{cur} {p}".strip()
            if len(cand) <= limit or not cur:
                cur = cand
            else:
                out.append(cur)
                cur = p
        if cur:
            out.append(cur)
        if all(len(o) <= limit for o in out):
            return out
        return [x for o in out for x in _split_long(o, limit)]
    # Un seul « mot » plus long que la limite : coupe brute.
    return [sentence[i : i + limit] for i in range(0, len(sentence), limit)]


def segments(text: str, limit: int = MAX_SEGMENT) -> list[str]:
    """Une phrase par segment, `limit` caractères au plus."""
    sentences = re.split(r"(?<=[.!?…])\s+", normalize(text))
    return [s for sent in sentences if sent for s in _split_long(sent, limit)]


def pause_after(segment: str) -> float:
    """Pause naturelle selon la ponctuation finale, 0,15 à 0,3 s."""
    end = segment.rstrip()[-1:] if segment.strip() else ""
    if end in ".!?…":
        return 0.3
    if end in ";:":
        return 0.2
    return 0.15
