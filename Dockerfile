FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static

# DBは /app/data に永続化（ボリュームマウント推奨）
ENV PJBOARD_DB=/app/data/pjboard.db
VOLUME /app/data

EXPOSE 8100
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
