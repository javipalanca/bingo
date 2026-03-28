FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY renderer ./renderer
COPY web ./web
COPY bingo.py ./bingo.py

EXPOSE 5173

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "5173"]
