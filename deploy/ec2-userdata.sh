#!/bin/bash
# ============================================================
# PJ Board (test-kakita-nb-tool) 初期構築スクリプト
# Amazon Linux 2023 / Python3.11 / systemd / 1分毎の自動デプロイ
# ============================================================
set -x
exec > /var/log/pjboard-bootstrap.log 2>&1

APP_DIR=/opt/pjboard
REPO=https://github.com/persimmon-rf/project-board.git
DATA_URL='__DATA_PRESIGNED_URL__'

dnf install -y git python3.11 python3.11-pip

# --- リポジトリ取得（Public化されるまでリトライ: 30秒間隔・最大2時間） ---
for i in $(seq 1 240); do
  git clone "$REPO" "$APP_DIR" && break
  echo "clone failed (attempt $i) - repo not public yet? retrying in 30s"
  sleep 30
done
if [ ! -d "$APP_DIR/.git" ]; then
  echo "FATAL: clone failed permanently"; exit 1
fi

python3.11 -m pip install -r "$APP_DIR/requirements.txt"

# --- ローカルデータの移行（S3署名付きURL・期限切れ時はスキップして新規DB） ---
mkdir -p "$APP_DIR/data"
if curl -fsSL "$DATA_URL" -o /tmp/pjboard-data.zip; then
  dnf install -y unzip
  unzip -o /tmp/pjboard-data.zip -d "$APP_DIR/data"
  rm -f /tmp/pjboard-data.zip
  echo "data restored from snapshot"
else
  echo "WARN: data snapshot fetch failed (expired?) - starting with fresh DB"
fi

# --- アプリ本体 systemd サービス ---
cat > /etc/systemd/system/pjboard.service <<'EOF'
[Unit]
Description=PJ Board (FastAPI)
After=network.target

[Service]
WorkingDirectory=/opt/pjboard
Environment=PJBOARD_DEBUG=1
ExecStart=/usr/bin/python3.11 -m uvicorn app:app --host 0.0.0.0 --port 8100
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# --- 自動デプロイ（1分毎に git fetch、更新があれば pull → 依存更新 → 再起動） ---
cat > /usr/local/bin/pjboard-deploy.sh <<'EOF'
#!/bin/bash
cd /opt/pjboard || exit 1
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "$(date '+%F %T') deploying $LOCAL -> $REMOTE" >> /var/log/pjboard-deploy.log
  git reset --hard origin/main >> /var/log/pjboard-deploy.log 2>&1
  python3.11 -m pip install -q -r requirements.txt >> /var/log/pjboard-deploy.log 2>&1
  systemctl restart pjboard
  echo "$(date '+%F %T') deployed $(git rev-parse --short HEAD)" >> /var/log/pjboard-deploy.log
fi
EOF
chmod +x /usr/local/bin/pjboard-deploy.sh

cat > /etc/systemd/system/pjboard-deploy.service <<'EOF'
[Unit]
Description=PJ Board auto deploy (git pull)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/pjboard-deploy.sh
EOF

cat > /etc/systemd/system/pjboard-deploy.timer <<'EOF'
[Unit]
Description=PJ Board auto deploy timer (every minute)

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now pjboard.service
systemctl enable --now pjboard-deploy.timer

echo "bootstrap completed: $(date)"
