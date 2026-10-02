#!/usr/bin/env python3
"""ComfyUI 后端：本地越狱版 MiniMax-H3（3090 机器）。

链路：relay → 本地 ComfyUI HTTP API（默认 http://127.0.0.1:8188）
    → POST /prompt 下发工作流 → 轮询 GET /history/{prompt_id}
    → GET /view 下载成品 mp4。

工作流模板：COMFYUI_WORKFLOW_T2V / COMFYUI_WORKFLOW_I2V 指向
ComfyUI 导出的 API 格式工作流 JSON（工作流菜单 → Save (API Format)）。
模板内占位符（出现在字符串值中即可）：
    {{PROMPT}}            提示词（自动 JSON 转义）
    {{FIRST_FRAME_FILE}}  首帧图文件名（i2v；relay 自动下载首帧图并
                         POST /upload/image 上传到 ComfyUI）
    "{{LENGTH}}"          成片帧数（带引号写，relay 替换为数字）：
                         由 duration 按 24fps 换算并对齐到 17n+5

注意：
  - resolution / ratio 由工作流模板固定（832x480，模板内置）。
  - ComfyUI 单卡一次只跑一个任务，多提交会在 ComfyUI 队列里排队。
  - DELETE /video 只删 relay 侧记录，不中断 ComfyUI 正在跑的任务。
"""
from __future__ import annotations

import io
import json
import mimetypes
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

from provider_base import VideoProvider

HTTP_TIMEOUT = 60
# i2v 首帧图下载上限（ComfyUI 只需要一张图）
IMAGE_MAX_BYTES = 100 * 1024 * 1024


class ComfyUIProvider(VideoProvider):
    name = "comfyui"
    submit_error_code = "comfyui_submit_failed"

    def __init__(self, base_url: str, workflow_t2v: str, workflow_i2v: str) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.workflow_t2v = workflow_t2v or ""
        self.workflow_i2v = workflow_i2v or ""

    # ---------------------------------------------------------- 配置 --
    def validate_config(self) -> None:
        if not self.base_url.startswith(("http://", "https://")):
            raise RuntimeError("VIDEO_PROVIDER=comfyui 时 COMFYUI_URL 必须是 http(s) 地址")
        for label, path in (("COMFYUI_WORKFLOW_T2V", self.workflow_t2v),
                            ("COMFYUI_WORKFLOW_I2V", self.workflow_i2v)):
            if not path:
                raise RuntimeError(f"VIDEO_PROVIDER=comfyui 时必须设置 {label}（工作流 JSON 模板路径）")
            if not os.path.isfile(path):
                raise RuntimeError(f"{label} 指向的文件不存在: {path}")

    # ---------------------------------------------------------- HTTP --
    def _request(self, method: str, path: str,
                 payload: dict | None = None,
                 raw_data: bytes | None = None,
                 content_type: str | None = None,
                 timeout: int = HTTP_TIMEOUT) -> dict:
        """调 ComfyUI API；失败抛 RuntimeError。"""
        url = self.base_url + path
        if payload is not None:
            raw_data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            content_type = "application/json"
        headers = {"User-Agent": "RinMiniMaxRelay/1.0"}
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(url, data=raw_data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                if not body:
                    return {}
                return json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:500]
            except Exception:
                detail = ""
            raise RuntimeError(f"ComfyUI HTTP {e.code}: {detail or e.reason}")
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"ComfyUI 请求失败: {e}")

    def _get_bytes(self, url: str, limit: int) -> bytes:
        """下载字节（限大小）；失败抛 RuntimeError。"""
        req = urllib.request.Request(url, headers={"User-Agent": "RinMiniMaxRelay/1.0"})
        buf = io.BytesIO()
        total = 0
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                while True:
                    chunk = r.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limit:
                        raise RuntimeError(f"文件超过 {limit // 1024 // 1024}MB 上限")
                    buf.write(chunk)
        except RuntimeError:
            raise
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"文件下载失败: {e}")
        if total == 0:
            raise RuntimeError("下载的文件为空")
        return buf.getvalue()

    # ---------------------------------------------------------- 提交 --
    def _load_template(self, params: dict) -> str:
        path = self.workflow_i2v if params.get("first_frame_url") else self.workflow_t2v
        with open(path, encoding="utf-8") as f:
            return f.read()

    @staticmethod
    def _frames_for_duration(duration: int) -> int:
        """时长(秒)→帧数：24fps，对齐到 H3 的 17n+5 帧数网格。"""
        try:
            d = int(duration)
        except (TypeError, ValueError):
            d = 5
        d = max(4, min(15, d))
        return 17 * round((d * 24 - 5) / 17) + 5

    @staticmethod
    def _fill(template: str, prompt: str, image_file: str = "",
              frames: int = 124) -> dict:
        """填充占位符（JSON 转义后替换），返回工作流 dict。"""
        def esc(s: str) -> str:
            return json.dumps(s, ensure_ascii=False)[1:-1]

        filled = template.replace("{{PROMPT}}", esc(prompt))
        filled = filled.replace("{{FIRST_FRAME_FILE}}", esc(image_file))
        filled = filled.replace('"{{LENGTH}}"', str(int(frames)))
        try:
            return json.loads(filled)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"工作流模板 JSON 非法（占位符替换后）: {e}")

    def _upload_image(self, url: str) -> str:
        """下载首帧图并上传到 ComfyUI，返回 ComfyUI 侧文件名。"""
        data = self._get_bytes(url, IMAGE_MAX_BYTES)
        ext = mimetypes.guess_extension("image/jpeg") or ".jpg"
        # 按 URL 猜扩展名（ComfyUI 按扩展名识别图片）
        path_part = urllib.parse.urlparse(url).path
        if "." in path_part.rsplit("/", 1)[-1]:
            cand = "." + path_part.rsplit(".", 1)[-1].lower()[:4]
            if cand in (".jpg", ".jpeg", ".png", ".webp", ".bmp"):
                ext = cand
        filename = f"rin_{uuid.uuid4().hex}{ext}"

        boundary = f"----RinForm{uuid.uuid4().hex}"
        body = io.BytesIO()
        body.write(f"--{boundary}\r\n".encode())
        body.write(
            f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'.encode()
        )
        body.write(f"Content-Type: image/{ext.lstrip('.')}\r\n\r\n".encode())
        body.write(data)
        body.write(f"\r\n--{boundary}\r\n".encode())
        body.write(b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue')
        body.write(f"\r\n--{boundary}--\r\n".encode())

        resp = self._request(
            "POST", "/upload/image",
            raw_data=body.getvalue(),
            content_type=f"multipart/form-data; boundary={boundary}",
            timeout=300,
        )
        name = resp.get("name")
        if not name:
            raise RuntimeError(f"ComfyUI 图片上传返回异常: {str(resp)[:200]}")
        return str(name)

    def submit(self, params: dict) -> str:
        """下发工作流到 ComfyUI，返回 prompt_id；失败抛 RuntimeError。"""
        template = self._load_template(params)
        image_file = ""
        if params.get("first_frame_url"):
            image_file = self._upload_image(params["first_frame_url"])
        frames = self._frames_for_duration(params.get("duration", 5))
        workflow = self._fill(template, params["prompt"], image_file, frames)
        resp = self._request("POST", "/prompt", {"prompt": workflow}, timeout=120)
        prompt_id = resp.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI 提交返回异常（缺少 prompt_id）: {str(resp)[:300]}")
        return str(prompt_id)

    # ---------------------------------------------------------- 查询 --
    def query(self, provider_task_id: str) -> tuple[str | None, str | None]:
        """查 /history：返回 (queued|running|succeeded|failed, 成功时的 /view 下载 url)。"""
        resp = self._request(
            "GET", f"/history/{urllib.parse.quote(provider_task_id, safe='')}"
        )
        entry = resp.get(provider_task_id)
        if not entry:
            # 历史里还没有：排队中或执行中
            return "running", None
        status = (entry.get("status") or {})
        if not status.get("completed"):
            return "running", None
        if status.get("status_str") != "success":
            return "failed", None
        video = self._find_video(entry.get("outputs") or {})
        if not video:
            return "failed", None
        filename, subfolder, ftype = video
        url = (
            self.base_url + "/view?"
            + urllib.parse.urlencode(
                {"filename": filename, "subfolder": subfolder, "type": ftype}
            )
        )
        return "succeeded", url

    @staticmethod
    def _find_video(outputs: dict) -> tuple[str, str, str] | None:
        """从 history outputs 里找视频文件。

        SaveVideo / Video Combine 节点输出位置因 ComfyUI 版本而异：
        gifs、videos，或 images（新版 SaveVideo 把视频放在 images 下，
        用 animated=true 标记区别于静态图）。
        """
        for node_out in outputs.values():
            if not isinstance(node_out, dict):
                continue
            for key in ("gifs", "videos"):
                items = node_out.get(key)
                if not items:
                    continue
                item = items[0]
                return (
                    str(item.get("filename", "")),
                    str(item.get("subfolder", "")),
                    str(item.get("type", "output")),
                )
            images = node_out.get("images")
            if images and node_out.get("animated"):
                item = images[0]
                return (
                    str(item.get("filename", "")),
                    str(item.get("subfolder", "")),
                    str(item.get("type", "output")),
                )
        return None
