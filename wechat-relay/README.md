# Rin → 微信公众号草稿（一键推送）

Rin 后台文章编辑页点「推送公众号草稿」，文章自动送进公众号草稿箱。
链路：`Rin 后台 → Worker → ECS 中转服务 → 微信 API`。

必须经 ECS 中转：微信 `token` 接口强制校验 IP 白名单，
Cloudflare Worker 出口 IP 不固定，直调会被 40164 拒绝。

## 架构

```
文章编辑页 [推送公众号草稿]
  → POST /api/admin/feed/:id/wechat-draft   (Worker, 仅管理员)
  → POST https://<ECS>:18080/push-draft     (Bearer 鉴权)
      1. 标题 64 字节检查（微信硬限制）
      2. access_token（内存缓存，过期前 5 分钟自动刷新）
      3. 正文图片下载 → uploadimg → mmbiz URL（不占素材库配额，同图只传一次）
      4. 第一张图 → add_material?type=thumb → 封面（占素材库配额）
      5. draft/add → draft_media_id
  → 前端提示"已送达草稿箱"
```

相对你之前的手工流程（备 MD → 传 ECS → 跑脚本），优化点：

- 一键推送，不用手工准备 MD/封面/SSH 传文件
- token 自动刷新（之前 `build_longform_essay.py` 要求手动刷新 token cache）
- 文章内图片自动下载上传（之前要手工指定 `DIAG_LIST`）
- 封面自动取文章首图
- 标题超限在 Worker 侧就拦掉，不浪费一次推送

## ECS 部署（root 执行）

```bash
# 把本目录传到 ECS（任意方式），然后：
cd wechat-relay && ./install.sh
```

`install.sh` 会：装到 `/opt/rin-wechat-relay`、跑单测、生成随机 `RELAY_SECRET`、
写入 systemd 并启动。日志：`journalctl -u rin-wechat-relay -f`。

前置条件：

1. `/root/.wechat_config.json` 存在（复用现有手工流程的，内含 `app_id`/`app_secret`）
2. 云厂商安全组放行 TCP 18080
3. 微信公众号后台 IP 白名单包含本机公网 IP（已有，手工流程一直在用）

### HTTP 还是 HTTPS？

中转请求里不含微信密钥（只有文章内容 + Bearer），且 Bearer 走明文有被嗅探风险。
内网/可信网络用 HTTP 即可；公网建议前面加一层 TLS（nginx 反代或 stunnel），
把 `WECHAT_RELAY_URL` 填 `https://` 地址。v1 默认 HTTP，README 后续补反代示例。

## Worker 配置（Cloudflare Dashboard → Workers → rin → Settings → Variables）

| 变量 | 说明 |
|---|---|
| `WECHAT_RELAY_URL` | `http://<ECS公网IP>:18080`（加了 TLS 就填 `https://…`） |
| `WECHAT_RELAY_SECRET` | `install.sh` 生成的随机密钥 |

两个都是 Secret 类型。没配时按钮会提示"未配置微信中转服务"，不影响其他功能。

## 约束（微信侧，改不了）

- 标题 ≤ 64 字节（中文约 21 个字），超了会直接报错
- 草稿必须有封面图：文章里至少要有一张图片，自动取第一张做封面
- 正文图片单张 ≤ 10MB（`uploadimg` 上限）
- 封面走 `add_material`，占用公众号 10 万素材库配额；正文图走 `uploadimg`，不占配额
- 摘要截断 120 字，作者截断 30 字；`article_url` 会填入"阅读原文"

## 本地测试

```bash
cd wechat-relay && python3 test_server.py   # 15 个单测，微信 API 全 mock
```

真实 E2E 需要 ECS 部署完成后，在 Rin 后台对一篇测试文章点推送，
再去公众号后台草稿箱确认。
