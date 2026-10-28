FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY cultur cultur
COPY registry registry
COPY static static
ENV DB_PATH=/tmp/cultur.db
EXPOSE 7860
CMD ["sh", "-c", "uvicorn cultur.app:app --host 0.0.0.0 --port ${PORT:-7860}"]
