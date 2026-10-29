FROM python:3.13-slim
WORKDIR /app
# Build from archive/cultur: docker build -f python-reference/Dockerfile .
COPY python-reference/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY python-reference/cultur cultur
COPY registry registry
COPY python-reference/static static
ENV CULTUR_REGISTRY_PATH=/app/registry/cases.json
ENV DB_PATH=/tmp/cultur.db
EXPOSE 7860
CMD ["sh", "-c", "uvicorn cultur.app:app --host 0.0.0.0 --port ${PORT:-7860}"]
