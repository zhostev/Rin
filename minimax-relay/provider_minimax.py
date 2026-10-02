#!/usr/bin/env python3
"""MiniMax V2 API 后端（官方按量计费）。

从 server.py 搬出：build_minimap_body / map_minimax_status /
submit / query 的具体实现；server.py 只保留 re-export 供旧测试使用。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from provider_base import VideoProvider

HTTP_TIMEOUT = 60


def build_minimax_body(params: dict) -> dict:
    """由校验后的参数构造 MiniMax /v2/video_generation 请求体。"""
    content: list[dict] = [{"type": "text", "text": params["prompt"]}]
    if params.get("first_frame_url"):
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": params["first_frame_url"]},
                "role": "first_frame",
            }
        )
    if params.get("last_frame_url"):
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": params["last_frame_url"]},
                "role": "last_frame",
            }
        )
    return {
        "model": params["model"],
        "content": content,
        "resolution": params["resolution"],
        "duration": params["duration"],
        "ratio": params["ratio"],
    }


def map_minimax_status(status: str) -> str:
    """MiniMax 任务状态 → queued | running | succeeded | failed；未知抛 ValueError。"""
    mapping = {
        "queued": "queued",
        "running": "running",
        "succeeded": "succeeded",
        "failed": "failed",
        "cancelled": "failed",
    }
    if status not in mapping:
        raise ValueError(f"未知的 MiniMax 状态: {status!r}")
    return mapping[status]


class MiniMaxProvider(VideoProvider):
    name = "minimax"
    submit_error_code = "minimax_submit_failed"

    def __init__(self, api_base: str, api_key: str) -> None:
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key

    def validate_config(self) -> None:
        if not self.api_key:
            raise RuntimeError("VIDEO_PROVIDER=minimax 时必须设置 MINIMAX_API_KEY 环境变量")

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        """调 MiniMax V2 API；失败抛 RuntimeError（错误信息不含 API key）。"""
        url = self.api_base + path
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:500]
            except Exception:
                detail = ""
            raise RuntimeError(f"MiniMax HTTP {e.code}: {detail or e.reason}")
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"MiniMax 请求失败: {e}")

    def submit(self, params: dict) -> str:
        """提交视频生成任务，返回 minimax task_id；失败抛 RuntimeError。"""
        resp = self._request("POST", "/v2/video_generation", build_minimax_body(params))
        task_id = resp.get("task_id") or (resp.get("task") or {}).get("id")
        if not task_id:
            raise RuntimeError(f"MiniMax 提交返回异常（缺少 task_id）: {str(resp)[:300]}")
        return str(task_id)

    def query(self, provider_task_id: str) -> tuple[str | None, str | None]:
        """查询任务：返回 (归一化状态, 成功时的 mp4 url)；失败抛 RuntimeError。"""
        resp = self._request("GET", f"/v2/query/video_generation/{provider_task_id}")
        task = resp.get("task") or {}
        content = task.get("content") or {}
        return map_minimax_status(task.get("status") or ""), content.get("url")
