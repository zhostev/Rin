#!/usr/bin/env python3
"""Rin → 微信公众号草稿 中转服务。

跑在有固定公网 IP 的 ECS 上（微信 token 接口强制校验 IP 白名单，
Cloudflare Worker 出口 IP 不固定，只能经这里中转）。

    POST /push-draft   Authorization: Bearer <RELAY_SECRET>
    GET  /health

/push-draft body (JSON):
    {
        "title": "文章标题",            # 必填，微信限制 64 字节
        "digest": "摘要",              # 可选，微信草稿摘要
        "author": "作者",              # 可选
        "content_markdown": "...",     # 必填，Rin 文章 markdown
        "site_base_url": "https://s7ea.com",  # 相对图片地址的基准
        "article_url": "https://s7ea.com/feed/10"  # 可选，填入"阅读原文"
    }

流程：
    1. 校验 Bearer
    2. 标题 64 字节检查（微信硬限制）
    3. 取 access_token（内存缓存，提前 5 分钟刷新；失败自动重取一次）
    4. 从 markdown 按序提取图片，下载 → uploadimg → mmbiz URL（同 URL 只传一次）
    5. 第一张图 → material/add_material?type=thumb → thumb_media_id
    6. draft/add → 返回 draft_media_id

配置（环境变量）：
    RELAY_SECRET   必填，中转鉴权密钥（Worker 侧 WECHAT_RELAY_SECRET 与之相同）
    WECHAT_CONFIG  默认 /root/.wechat_config.json，内含 {"app_id","app_secret"}
    RELAY_BIND     默认 0.0.0.0
    RELAY_PORT     默认 18080

微信 API 用量注意：
    - uploadimg（正文图片）不占 10 万素材库配额
    - add_material?type=thumb（封面）占素材库配额
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WECHAT_API = "https://api.weixin.qq.com/cgi-bin"
TITLE_BYTE_CAP = 64
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # uploadimg 上限 10MB
HTTP_TIMEOUT = 30

CONFIG = {
    "secret": os.environ.get("RELAY_SECRET", ""),
    "wechat_config": os.environ.get("WECHAT_CONFIG", "/root/.wechat_config.json"),
    "bind": os.environ.get("RELAY_BIND", "0.0.0.0"),
    "port": int(os.environ.get("RELAY_PORT", "18080")),
}

_token_cache: dict = {}
_token_lock = threading.Lock()


def log(msg: str) -> None:
    print(f"[relay {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- 微信 API --
def _read_wechat_config() -> dict:
    p = Path(CONFIG["wechat_config"])
    if not p.exists():
        raise RuntimeError(f"wechat config not found: {p}")
    cfg = json.loads(p.read_text())
    if not cfg.get("app_id") or not cfg.get("app_secret"):
        raise RuntimeError("wechat config 缺少 app_id / app_secret")
    return cfg


def get_access_token(force_refresh: bool = False) -> str:
    """取 access_token，内存缓存，过期前 5 分钟自动刷新。"""
    with _token_lock:
        if (
            not force_refresh
            and _token_cache.get("token")
            and _token_cache.get("expires_at", 0) > time.time() + 300
        ):
            return _token_cache["token"]
    cfg = _read_wechat_config()
    params = urllib.parse.urlencode(
        {"grant_type": "client_credential", "appid": cfg["app_id"], "secret": cfg["app_secret"]}
    )
    resp = _http_json(f"{WECHAT_API}/token?{params}")
    token = resp.get("access_token")
    if not token:
        raise RuntimeError(f"微信 token 获取失败: {resp}")
    with _token_lock:
        _token_cache["token"] = token
        _token_cache["expires_at"] = time.time() + int(resp.get("expires_in", 7200))
    return token


def _http_json(url: str, data: bytes | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data else "GET")
    raw = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read()
    return json.loads(raw)


def _upload_multipart(url: str, field_name: str, filename: str, content_type: str, data: bytes) -> dict:
    boundary = "----RinRelay" + hashlib.md5(os.urandom(16)).hexdigest()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    return _http_json(url, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})


def wechat_api_call(path: str, payload: dict | None = None) -> dict:
    """调微信 API，token 失效（40001/42001）时自动刷新重试一次。"""
    token = get_access_token()
    url = f"{WECHAT_API}{path}?access_token={token}"
    body = (
        json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    )
    headers = {"Content-Type": "application/json; charset=utf-8"}
    try:
        resp = _http_json(url, data=body, headers=headers)
    except Exception as e:
        raise RuntimeError(f"微信 API 请求失败 {path}: {e}")
    if resp.get("errcode") in (40001, 42001):
        token = get_access_token(force_refresh=True)
        url = f"{WECHAT_API}{path}?access_token={token}"
        resp = _http_json(url, data=body, headers=headers)
    if resp.get("errcode", 0) != 0:
        raise RuntimeError(f"微信 API 错误 {path}: errcode={resp.get('errcode')} errmsg={resp.get('errmsg')}")
    return resp


def upload_inline_image(image_bytes: bytes, filename: str) -> str:
    """正文图片 → uploadimg，不占素材库配额，返回 mmbiz URL。"""
    token = get_access_token()
    content_type = mimetypes.guess_type(filename)[0] or "image/jpeg"
    resp = _upload_multipart(
        f"{WECHAT_API}/media/uploadimg?access_token={token}",
        "media", filename, content_type, image_bytes,
    )
    # uploadimg 的 token 失效重试走简化路径：刷新一次再试
    if "url" not in resp and resp.get("errcode") in (40001, 42001):
        token = get_access_token(force_refresh=True)
        resp = _upload_multipart(
            f"{WECHAT_API}/media/uploadimg?access_token={token}",
            "media", filename, content_type, image_bytes,
        )
    if "url" not in resp:
        raise RuntimeError(f"uploadimg 失败: {resp}")
    return resp["url"]


def upload_thumb(image_bytes: bytes, filename: str) -> str:
    """封面图 → add_material?type=thumb（占素材库配额），返回 media_id。"""
    token = get_access_token()
    content_type = mimetypes.guess_type(filename)[0] or "image/jpeg"
    resp = _upload_multipart(
        f"{WECHAT_API}/material/add_material?access_token={token}&type=thumb",
        "media", filename, content_type, image_bytes,
    )
    if "media_id" not in resp and resp.get("errcode") in (40001, 42001):
        token = get_access_token(force_refresh=True)
        resp = _upload_multipart(
            f"{WECHAT_API}/material/add_material?access_token={token}&type=thumb",
            "media", filename, content_type, image_bytes,
        )
    if "media_id" not in resp:
        raise RuntimeError(f"封面上传失败: {resp}")
    return resp["media_id"]


# ------------------------------------------------------------- markdown --
IMG_RE = re.compile(r"!\[([^\]]*)\]\(\s*([^)\s]+?)\s*(?:\"[^\"]*\")?\)")


def extract_image_urls(markdown: str, site_base_url: str) -> list[tuple[str, str]]:
    """按出现顺序提取正文图片，返回 [(原文写法, 补全后的绝对 URL)]（按绝对 URL 去重）。

    相对地址按 site_base_url 补全；data: 内联图跳过（微信不接受）。
    """
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for match in IMG_RE.finditer(markdown):
        raw = match.group(2).strip()
        if raw.startswith("data:"):
            continue
        resolved = raw
        if not raw.startswith(("http://", "https://")):
            resolved = urllib.parse.urljoin(site_base_url.rstrip("/") + "/", raw.lstrip("/"))
        if resolved not in seen:
            seen.add(resolved)
            pairs.append((raw, resolved))
    return pairs


def download_image(url: str) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "RinWechatRelay/1.0"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        content_type = r.headers.get("Content-Type", "")
        data = r.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise RuntimeError(f"图片超过 10MB 上限: {url}")
    if not data:
        raise RuntimeError(f"图片下载为空: {url}")
    ext = mimetypes.guess_extension(content_type.split(";")[0].strip()) or ".jpg"
    path_part = urllib.parse.urlparse(url).path
    name = Path(path_part).name or "image"
    if "." not in name:
        name += ext
    return data, name


def _inline_md(text: str) -> str:
    """行内 markdown → HTML（先转义再替换，避免注入）。"""
    text = html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"`([^`]+?)`", r"<code>\1</code>", text)
    text = re.sub(r"\[([^\]]+?)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', text)
    return text


def markdown_to_wechat_html(markdown: str, image_url_map: dict[str, str]) -> str:
    """Rin 文章 markdown → 微信草稿可用的简洁 HTML。

    image_url_map: 原 URL → mmbiz URL 的映射；图片转成居中 <img>。
    微信编辑器会过滤 script 等危险标签，这里只输出白名单标签。
    """
    # 先把图片占位成 token，避免被行内规则误处理
    tokens: dict[str, str] = {}

    def img_sub(m: re.Match) -> str:
        alt, url = m.group(1), m.group(2).strip()
        key = f"\ue000IMG{len(tokens)}\ue001"
        mmbiz = image_url_map.get(url, "")
        tokens[key] = (
            f'<img src="{html.escape(mmbiz or url)}" alt="{html.escape(alt)}" '
            f'style="max-width:100%;height:auto;" />'
        )
        return key

    md = IMG_RE.sub(img_sub, markdown)
    lines = md.split("\n")
    out: list[str] = []
    in_code = False
    code_buf: list[str] = []
    list_stack: list[str] = []  # "ul" / "ol"

    def close_list() -> None:
        while list_stack:
            out.append(f"</{list_stack.pop()}>")

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            if in_code:
                out.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")
                code_buf = []
                in_code = False
            else:
                close_list()
                in_code = True
            continue
        if in_code:
            code_buf.append(line)
            continue
        if not stripped:
            close_list()
            continue
        if stripped.startswith("#"):
            close_list()
            level = len(stripped) - len(stripped.lstrip("#"))
            text = stripped.lstrip("#").strip()
            tag = f"h{min(level, 3)}"
            out.append(f"<{tag}>{_inline_md(text)}</{tag}>")
            continue
        if re.match(r"^(\*{3,}|-{3,}|_{3,})$", stripped):
            close_list()
            out.append("<hr/>")
            continue
        if stripped.startswith(">"):
            close_list()
            out.append(f"<blockquote>{_inline_md(stripped.lstrip('>').strip())}</blockquote>")
            continue
        m_ul = re.match(r"^[-*+]\s+(.*)$", stripped)
        m_ol = re.match(r"^(\d+)[.)]\s+(.*)$", stripped)
        if m_ul or m_ol:
            kind = "ul" if m_ul else "ol"
            text = (m_ul or m_ol).group(1 if m_ul else 2)
            if not list_stack or list_stack[-1] != kind:
                close_list()
                out.append(f"<{kind}>")
                list_stack.append(kind)
            out.append(f"<li>{_inline_md(text)}</li>")
            continue
        close_list()
        out.append(f"<p>{_inline_md(stripped)}</p>")

    close_list()
    if in_code:
        out.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")

    result = "\n".join(out)
    for key, img_html in tokens.items():
        result = result.replace(key, img_html)
    return result


# ------------------------------------------------------------- 主流程 --
def push_draft(body: dict) -> dict:
    title = (body.get("title") or "").strip()
    content_markdown = body.get("content_markdown") or ""
    site_base_url = (body.get("site_base_url") or "").rstrip("/")
    if not title:
        raise ValueError("缺少 title")
    if len(title.encode("utf-8")) > TITLE_BYTE_CAP:
        raise ValueError(f"标题超过微信 64 字节限制（当前 {len(title.encode('utf-8'))} 字节）")
    if not content_markdown.strip():
        raise ValueError("正文内容为空")
    if not site_base_url:
        raise ValueError("缺少 site_base_url（用于解析相对图片地址）")

    digest = (body.get("digest") or "").strip()[:120]
    author = (body.get("author") or "").strip()[:30]
    article_url = (body.get("article_url") or "").strip()

    # 1. 提取图片并上传（首图留作封面）
    image_pairs = extract_image_urls(content_markdown, site_base_url)
    if not image_pairs:
        raise ValueError("文章中没有图片：微信草稿必须设置封面图，请先在文章中插入至少一张图片")
    log(f"发现 {len(image_pairs)} 张图片")
    image_data: dict[str, tuple[bytes, str]] = {}
    for _raw, resolved in image_pairs:
        log(f"下载图片: {resolved[:80]}")
        image_data[resolved] = download_image(resolved)

    # 原文写法与绝对 URL 都映射到 mmbiz（正文里两种写法都可能出现）
    image_url_map: dict[str, str] = {}
    for raw, resolved in image_pairs:
        data, name = image_data[resolved]
        mmbiz = upload_inline_image(data, name)
        image_url_map[raw] = mmbiz
        image_url_map[resolved] = mmbiz
        log(f"uploadimg ok: {name}")

    # 2. 封面 = 第一张图
    first_resolved = image_pairs[0][1]
    data, name = image_data[first_resolved]
    thumb_media_id = upload_thumb(data, name)
    log(f"thumb_media_id = {thumb_media_id}")

    # 3. markdown → HTML（图片替换为 mmbiz 链接）
    content_html = markdown_to_wechat_html(content_markdown, image_url_map)

    article: dict = {
        "title": title,
        "thumb_media_id": thumb_media_id,
        "content": content_html,
        "need_open_comment": 0,
        "only_fans_can_comment": 0,
    }
    if author:
        article["author"] = author
    if digest:
        article["digest"] = digest
    if article_url:
        article["content_source_url"] = article_url

    resp = wechat_api_call("/draft/add", {"articles": [article]})
    draft_media_id = resp["media_id"]
    log(f"draft_media_id = {draft_media_id}")
    return {"ok": True, "draft_media_id": draft_media_id, "thumb_media_id": thumb_media_id}


# ---------------------------------------------------------------- HTTP --
class Handler(BaseHTTPRequestHandler):
    server_version = "RinWechatRelay/1.0"

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        given = auth[len("Bearer "):].strip()
        return hmac.compare_digest(given, CONFIG["secret"]) and bool(CONFIG["secret"])

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/push-draft":
            self._send(404, {"ok": False, "error": "not found"})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 10 * 1024 * 1024:
            self._send(400, {"ok": False, "error": "body 为空或超过 10MB"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except Exception:
            self._send(400, {"ok": False, "error": "body 不是合法 JSON"})
            return
        try:
            result = push_draft(body)
        except ValueError as e:
            self._send(400, {"ok": False, "error": str(e)})
        except RuntimeError as e:
            self._send(502, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            log(f"push-draft 未预期异常: {e}")
            self._send(500, {"ok": False, "error": f"内部错误: {e}"})
        else:
            self._send(200, result)

    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        log(fmt % args)


def main() -> None:
    if not CONFIG["secret"]:
        print("ERROR: 必须设置 RELAY_SECRET 环境变量", file=sys.stderr)
        sys.exit(1)
    server = ThreadingHTTPServer((CONFIG["bind"], CONFIG["port"]), Handler)
    log(f"listening on {CONFIG['bind']}:{CONFIG['port']}, wechat_config={CONFIG['wechat_config']}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
