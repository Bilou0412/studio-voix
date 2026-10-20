import json

from fastapi.testclient import TestClient

import server
from engine import TextRejected


class FakeModel:
    sr = 24000


def setup_module():
    server._loaded.wait()
    server._model = FakeModel()
    server.os.environ["WORKER_TOKEN"] = "t"


def call(body, token="t"):
    with TestClient(server.app) as c:
        r = c.post("/synthesize", json=body, headers={"authorization": f"Bearer {token}"})
        return r.status_code, r.text


def test_un_mauvais_jeton_est_refuse():
    status, _ = call({"text": "x"}, token="faux")
    assert status == 401


def test_le_resultat_arrive_en_json_apres_le_maintien(monkeypatch):
    monkeypatch.setattr(server, "KEEPALIVE_SECONDS", 0.01)

    def slow(model, body):
        import time

        time.sleep(0.1)
        return {"duration_s": 1.0, "prepared_text": body["text"]}

    monkeypatch.setattr(server, "synthesize", slow)
    status, text = call({"text": "Bonjour."})
    assert status == 200
    assert text.startswith(" ")
    assert json.loads(text) == {"duration_s": 1.0, "prepared_text": "Bonjour."}


def test_un_texte_refuse_rend_422_dans_le_corps(monkeypatch):
    def reject(model, body):
        raise TextRejected("texte vide après préparation")

    monkeypatch.setattr(server, "synthesize", reject)
    _, text = call({"text": "[pause]"})
    assert json.loads(text) == {"error": {"status": 422, "detail": "texte vide après préparation"}}
