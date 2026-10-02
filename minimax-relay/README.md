# Rin → MiniMax H3 视频生成（中转服务）

Rin 后台（后续接入）提交视频生成任务，经 Cloudflare Worker 调这台中转服务，
再由它调用 MiniMax V2 API 生成视频。MiniMax API key 只存放在这台机器上，
Worker 只持有中转服务的 `RELAY_SECRET`，不直接接触 MiniMax key。

链路：`Rin 后台 → Worker → https://ddns.hoo.ink:18081（本服务）→ MiniMax V2 API`

## 文件

- `server.py` — 服务本体（Python 标准库 only，零第三方依赖）
- `test_server.py` — 纯函数单测（不碰网络）
- `test_concurrency.py` — 并发幂等测试（起本地 HTTP 并发提交，验证不重复扣费）
- `rin-minimax-relay.service` — systemd unit

## MiniMax key 获取

1. 打开 https://platform.minimax.io 注册/登录
2. 开通 API 服务，按量购买（预付费充值）
3. 在 API keys 页面创建 key，记下来填到下面的 `MINIMAX_API_KEY`

费用（按量，以 MiniMax 官网为准）：约 **¥0.5/秒 @768P**、约 **¥0.8/秒 @2K**。
一次 6 秒 768P 视频约 ¥3，15 秒约 ¥7.5。提交前请确认余额充足，
余额不足时提交会 502（`minimax_submit_failed`）。

## ddns.hoo.ink 部署（root 执行）

前置条件：

1. 本机经公网 **HTTPS** 可达（Cloudflare Worker 要能调到它）：
   ddns.hoo.ink 域名解析到本机公网 IP + 路由器端口转发（TCP 18081），
   前面加一层 TLS 反代（nginx / caddy / cloudflared tunnel 均可）。
   纯 HTTP 也可以跑，但 Bearer 走明文有被嗅探风险，公网请务必用 HTTPS。
2. `python3` 可用（标准库即可，无需 pip 装任何东西）。

步骤：

```bash
# 1. 把本目录传到机器上（任意方式），放到 /opt/rin-minimax-relay
mkdir -p /opt/rin-minimax-relay
# （把 server.py / test_server.py / rin-minimax-relay.service 拷进去）

# 2. 写环境变量文件（权限收紧，含两个密钥）
cat > /etc/rin-minimax-relay.env <<'EOF'
RELAY_SECRET=<随机生成，32位以上>
# 视频后端二选一：
#   minimax（默认）：MiniMax 官方 V2 API，按量计费
MINIMAX_API_KEY=<platform.minimax.io 的 API key>
#   comfyui：本地 ComfyUI 越狱后端（3090 机器，实现待补）
# VIDEO_PROVIDER=comfyui
# COMFYUI_URL=http://127.0.0.1:8188
# COMFYUI_WORKFLOW_T2V=/opt/rin-minimax-relay/workflows/h3-t2v.json
# COMFYUI_WORKFLOW_I2V=/opt/rin-minimax-relay/workflows/h3-i2v.json
EOF
chmod 600 /etc/rin-minimax-relay.env

# 3. 单测先过
cd /opt/rin-minimax-relay && python3 test_server.py && python3 test_concurrency.py

# 4. 装 systemd 并启动
cp rin-minimax-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rin-minimax-relay
journalctl -u rin-minimax-relay -f   # 看日志

# 5. 健康检查（内网）
curl http://127.0.0.1:18081/health
# 公网 HTTPS 检查
curl https://ddns.hoo.ink:18081/health
```

## ComfyUI 后端（本地越狱版 MiniMax-H3，3090 机器）

`VIDEO_PROVIDER=comfyui` 时走本地 ComfyUI，不走 MiniMax 官方 API（不花钱）。

1. 在 3090 机器上跑 `install-comfyui-h3.ps1`（Windows PowerShell）下载模型（约 42GB）
2. 按脚本最后打印的手动步骤：加 ComfyUI 启动参数
   `--disable-pinned-memory --fp16-intermediates`（无头运行，不加
   `--auto-launch`，不用开机自启）
3. 工作流模板已内置：`workflows/h3-t2v.json` / `workflows/h3-i2v.json`
   （源自社区 3090 实测配方，已换上越狱版 Heretic 文本编码器；
   提示词 `{{PROMPT}}`、首帧 `{{FIRST_FRAME_FILE}}`、帧数 `{{LENGTH}}`
   由 relay 自动填充，**无需手动从 ComfyUI 导出**）
4. relay 环境变量切到 comfyui（见上面 env 示例），重启 relay

注意：
- `duration`（4–15 秒）由 relay 按 24fps 换算成帧数写入模板（对齐 17n+5）；
  `resolution` / `ratio` 由模板固定为 832x480
- ComfyUI 单卡一次只跑一个任务，多提交会排队
- 3090 出 5 秒 832x480 约 4～5 分钟；NVFP4 编码器在 Ampere 上是仿真运行

如果安装路径不是 `/opt/rin-minimax-relay`，同步改 unit 里的
`WorkingDirectory`、`Environment=DATA_DIR=…`、`ExecStart` 三处。

## Worker 配置（Cloudflare Dashboard → Workers → rin → Settings → Variables）

| 变量 | 说明 |
|---|---|
| `MINIMAX_RELAY_URL` | `https://ddns.hoo.ink:18081`（本服务公网地址） |
| `MINIMAX_RELAY_SECRET` | 与 `/etc/rin-minimax-relay.env` 里的 `RELAY_SECRET` 相同 |

两个都是 Secret 类型。没配时 Worker 侧相关入口会提示"未配置视频生成服务"，
不影响其他功能。（Worker 侧接入代码见本分支 `server/src/features/ai-studio/`。）

## API 参考

所有 `/video*` 接口都需要头 `Authorization: Bearer <RELAY_SECRET>`，
`/health` 不需要鉴权。

### POST /video — 提交生成任务

```bash
curl -X POST https://ddns.hoo.ink:18081/video \
  -H "Authorization: Bearer $RELAY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一只猫在月光下散步","duration":6,"resolution":"768P","ratio":"16:9"}'
# → 200 {"ok":true,"job_id":"…"}（幂等命中时多带 "duplicate":true）
```

参数：

| 字段 | 必填 | 说明 |
|---|---|---|
| `prompt` | 是 | 提示词，≤ 7000 字符 |
| `duration` | 否 | 整数 4..15（秒），默认 6 |
| `resolution` | 否 | `768P` \| `2K`，默认 `768P` |
| `ratio` | 否 | t2v: `21:9` \| `16:9` \| `4:3` \| `1:1` \| `3:4` \| `9:16`（默认 `16:9`，不能为 `adaptive`）；传了 `first_frame_url` 就是 i2v，ratio 固定 `adaptive` |
| `first_frame_url` | 否 | 首帧图 http(s) 地址（i2v） |
| `last_frame_url` | 否 | 尾帧图（必须同时传首帧图） |
| `model` | 否 | 默认 `MiniMax-H3` |
| `client_job_id` | 否 | 幂等键（Rin 传 `aistudio-<jobId>`），重复提交直接返回已有任务，不重复扣费 |

参数非法 → `400 {"ok":false,"error":"…"}`；
MiniMax 非 2xx → `502 {"ok":false,"error":"minimax_submit_failed","detail":"…"}`。

### GET /video/{job_id} — 查任务状态

```bash
curl https://ddns.hoo.ink:18081/video/<job_id> -H "Authorization: Bearer $RELAY_SECRET"
# → 200 {"ok":true,"job_id":"…","status":"running","prompt":"一只猫…",
#        "duration":6,"resolution":"768P","ratio":"16:9"}
```

`status`: `queued` | `running` | `succeeded` | `failed`。
`prompt` 只返回前 120 字符；失败时带 `error`；成功时带 `bytes`。
未知 id → `404 {"ok":false,"error":"not_found"}`。

### GET /video/{job_id}/file — 下载成品 mp4

成功时 `200 video/mp4` 字节流；未完成 → `404 {"ok":false,"error":"not_ready"}`。

### DELETE /video/{job_id} — 删除任务与文件

→ `200 {"ok":true,"job_id":"…"}`；未知 id → 404。

### GET /health

→ `200 {"ok":true,"service":"minimax-relay","model":"MiniMax-H3"}`

## 行为约束（服务端，改不了就别硬调）

- 提交成功后后台线程每 10 秒轮询 MiniMax，**最多 2 小时**，超时任务标 `failed`
- 成功后下载 mp4 上限 **500MB**（超了标失败），存 `{DATA_DIR}/{job_id}.mp4`
- 任务记录持久化在 `{DATA_DIR}/jobs.json`（原子写入）；服务重启后自动恢复
  未完成任务的轮询
- 成品文件按 `FILE_TTL_DAYS`（默认 30 天）自动清理（含任务记录）；失败记录同样按 TTL 清理，避免 `jobs.json` 无限增长
- 对外错误信息绝不包含 `MINIMAX_API_KEY`

## 本地测试

```bash
cd minimax-relay && python3 test_server.py   # 纯函数单测，不碰网络
```

真实 E2E 需要 ddns.hoo.ink 部署完成后：POST /video 提交一个 6 秒 768P 任务，
轮询 /video/{job_id} 到 succeeded，再 GET /video/{job_id}/file 下载验证。
