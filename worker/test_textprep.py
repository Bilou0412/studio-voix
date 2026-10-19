import numpy as np

from assemble import join, trim_silence
from textprep import normalize, pause_after, segments, strip_directions


def test_nombres_de_la_spec():
    assert normalize("161,6") == "cent soixante et un virgule six"
    assert normalize("en 2027") == "en deux mille vingt-sept"
    assert normalize("1,05 %") == "un virgule zéro cinq pour cent"
    assert normalize("10 000 élèves") == "dix mille élèves"


def test_les_indications_entre_crochets_sont_retirees():
    text, hints = strip_directions("[calme, intime] J'avais une théorie… [pause] en fait non.")
    assert hints == ["calme, intime", "pause"]
    assert normalize("[calme] J'avais une théorie.") == "J'avais une théorie."


def test_une_phrase_par_segment_et_250_caracteres_au_plus():
    long = "Ceci est une phrase, " * 30 + "fin."
    segs = segments("Première phrase. Deuxième ? " + long)
    assert segs[0] == "Première phrase."
    assert segs[1] == "Deuxième ?"
    assert all(len(s) <= 250 for s in segs)
    assert " ".join(segs[2:]).replace("  ", " ") == normalize(long)


def test_pause_selon_la_ponctuation():
    assert pause_after("Fin.") == 0.3
    assert pause_after("Liste :") == 0.2
    assert pause_after("virgule,") == 0.15
    assert all(0.15 <= pause_after(s) <= 0.3 for s in ["a", "b?", "c…", "d;"])


def test_recollage_coupe_les_silences_et_ajoute_la_pause():
    sr = 24000
    voice = np.sin(np.linspace(0, 2 * np.pi * 220, sr // 2)).astype(np.float32) * 0.5
    padded = np.concatenate([np.zeros(sr), voice, np.zeros(sr)])
    assert len(trim_silence(padded, sr)) < len(voice) + int(0.1 * sr)
    out = join([padded, padded], [0.3], sr)
    # 30 ms de marge gardés de chaque côté de chaque segment.
    assert abs(len(out) / sr - (2 * 0.5 + 0.3 + 4 * 0.03)) < 0.02
    assert out[0] == 0.0 and out[-1] == 0.0  # fondus
