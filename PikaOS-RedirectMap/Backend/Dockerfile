# URL Redirect Map backend — standalone FastAPI (stateless, no DB).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# curl for the compose healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# No migrations / seed — the tool is stateless. Just run the app.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
