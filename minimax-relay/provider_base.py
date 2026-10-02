#!/usr/bin/env python3
"""视频生成后端的统一接口。

submit(params) -> provider 侧任务 id；失败抛 RuntimeError。
query(provider_task_id) -> (status, 成功时的 mp4 下载 url 或 None)；
status 必须是 queued | running | succeeded | failed 之一，未知状态抛 ValueError；
网络等临时失败抛 RuntimeError（调用方重试，不标记任务失败）。
"""
from __future__ import annotations


class VideoProvider:
    name = "base"
    # 提交失败时 relay 对外返回的 error code（Worker 侧透传展示）
    submit_error_code = "provider_submit_failed"

    def submit(self, params: dict) -> str:
        """提交视频生成任务，返回后端任务 id；失败抛 RuntimeError。"""
        raise NotImplementedError

    def query(self, provider_task_id: str) -> tuple[str | None, str | None]:
        """查询任务：返回 (status, mp4 下载 url)；失败抛 RuntimeError/ValueError。"""
        raise NotImplementedError

    def validate_config(self) -> None:
        """启动时校验后端配置；不满足抛 RuntimeError（说明原因）。"""
        return None
