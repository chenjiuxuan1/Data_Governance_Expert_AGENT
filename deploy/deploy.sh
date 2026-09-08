#!/bin/bash
# 数据治理专家 · 部署脚本（服务器上运行）
set -e
APP_DIR="/root/gov-bot"
echo "==> 1. 复制代码到 $APP_DIR"
mkdir -p "$APP_DIR"
cp -R "$(dirname "$0")/gov-bot/." "$APP_DIR/"
echo "==> 2. 配置环境变量"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "请编辑 $APP_DIR/.env 填入真实 token/key！"
  exit 1
fi
echo "==> 3. 安装 systemd 服务"
cat > /etc/systemd/system/gov-bot.service <<SVC
[Unit]
Description=Data Governance Bot (KN Chat)
After=network.target
[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/python3 $APP_DIR/gov-bot.py
EnvironmentFile=$APP_DIR/.env
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
SVC
systemctl daemon-reload
echo "==> 4. 启动服务"
systemctl enable gov-bot
systemctl restart gov-bot
systemctl status gov-bot --no-pager | head -8
echo "==> 完成！日志: journalctl -u gov-bot -f"
