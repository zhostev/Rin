#!/usr/bin/env bash
# ECS 一键部署 rin-wechat-relay（在 ECS 上以 root 执行）。
# 用法：./install.sh
#   会把 server.py 装到 /opt/rin-wechat-relay，写入 systemd unit 并启动。
set -euo pipefail
cd "$(dirname "$0")"

INSTALL_DIR=/opt/rin-wechat-relay
UNIT_SRC=rin-wechat-relay.service
UNIT_DST=/etc/systemd/system/rin-wechat-relay.service

echo "[1/5] 安装到 $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp server.py "$INSTALL_DIR/server.py"
chmod 644 "$INSTALL_DIR/server.py"
python3 -m py_compile "$INSTALL_DIR/server.py" && echo "    py_compile OK"

echo "[2/5] 单测"
python3 ./test_server.py 2>&1 | tail -3

echo "[3/5] 写入 systemd unit"
cp "$UNIT_SRC" "$UNIT_DST"
chmod 644 "$UNIT_DST"

echo "[4/5] 生成 RELAY_SECRET（如果还是 CHANGE_ME）"
if grep -q "RELAY_SECRET=CHANGE_ME" "$UNIT_DST"; then
  SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
  sed -i "s/RELAY_SECRET=CHANGE_ME/RELAY_SECRET=$SECRET/" "$UNIT_DST"
  echo "    已生成随机密钥，请记下它，等会填到 Cloudflare Worker 的 WECHAT_RELAY_SECRET："
  echo "    $SECRET"
else
  echo "    密钥已设置，跳过"
fi

echo "[5/5] 启动服务"
systemctl daemon-reload
systemctl enable --now rin-wechat-relay
sleep 2
systemctl is-active --quiet rin-wechat-relay && echo "    服务运行中"
curl -s http://127.0.0.1:18080/health && echo && echo "    /health OK"

echo
echo "下一步："
echo "  1. 云厂商安全组放行 TCP 18080（来源不限，鉴权靠 Bearer 密钥）"
echo "  2. 在 Cloudflare Worker 配两个 secrets："
echo "       WECHAT_RELAY_URL=https://<ECS公网IP>:18080  （或 http，见 README）"
echo "       WECHAT_RELAY_SECRET=<上面生成的密钥>"
echo "  3. 在 Rin 后台文章编辑页点「推送公众号草稿」"
