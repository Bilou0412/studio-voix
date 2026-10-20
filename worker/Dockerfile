# Worker CPU de synthèse (Fly) : Chatterbox Multilingual, poids inclus dans l'image.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# PyTorch CPU d'abord : sans lui pip tirerait la version CUDA, plusieurs Go inutiles ici.
RUN pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir chatterbox-tts==0.1.7 num2words==0.5.14 soundfile "fastapi[standard]"
COPY engine.py textprep.py assemble.py server.py ./
ENV HF_HOME=/app/hf
# Téléchargement seul : charger le modèle ici dépasse la mémoire du constructeur d'images.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='ResembleAI/chatterbox', repo_type='model', revision='main', allow_patterns=['ve.pt', 't3_mtl23ls_v2.safetensors', 's3gen.pt', 'grapheme_mtl_merged_expanded_v1.json', 'conds.pt', 'Cangjie5_TC.json'])"
ENV HF_HUB_OFFLINE=1
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "::", "--port", "8080", "--timeout-keep-alive", "75"]
