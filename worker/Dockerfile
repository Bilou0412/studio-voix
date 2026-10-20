# Worker CPU de synthèse (Fly) : Chatterbox Multilingual, poids inclus dans l'image.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# PyTorch CPU d'abord : sans lui pip tirerait la version CUDA, plusieurs Go inutiles ici.
RUN pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir chatterbox-tts==0.1.7 num2words==0.5.14 soundfile "fastapi[standard]"
COPY engine.py textprep.py assemble.py server.py ./
ENV HF_HOME=/app/hf
RUN python -c "from engine import load_model; load_model('cpu')"
ENV HF_HUB_OFFLINE=1
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "::", "--port", "8080", "--timeout-keep-alive", "75"]
