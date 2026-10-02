#!/usr/bin/env python3
"""Rin 视频生成 中转服务。

跑在用户家里的 ddns.hoo.ink 机器上（API key 只放在这里，
Cloudflare Worker 不直接持有 key，只经这里中转）。

    POST /video            Authorization: Bearer <RELAY_SECRET>
    GET  /video/{job_id}
    GET  /video/{job_id}/file
    DELETE /video/{job_id}
    GET  /health

视频后端由 VIDEO_PROVIDER 选择（默认 minimax）：
    minimax  MiniMax V2 官方 API（按量计费，需 MINIMAX_API_KEY）
    comfyui  本地 ComfyUI（越狱版 MiniMax-H3，需 3090 级 GPU 机器；实现待补）

POST /video body (JSON):（同旧版，见 README）

POST /video body (JSON):
    {
        "prompt": "提示词",          # 必填，≤ 7000 字符
        "duration": 6,              # 可选，整数 4..15（秒），默认 6
        "resolution": "768P",       # 可选，768P | 2K，默认 768P
        "ratio": "16:9",            # 文生视频(t2v)时 21:9 | 16:9 | 4:3 | 1:1 | 3:4 | 9:16，
                                    #   默认 16:9，不能为 adaptive；图生视频(i2v)时固定 adaptive
        "first_frame_url": "...",   # 可选，首帧图 http(s) 地址（传了就是 i2v）
        "last_frame_url": "...",    # 可选，尾帧图（必须同时传 first_frame_url）
        "model": "MiniMax-H3",      # 可选，默认 MiniMax-H3
        "client_job_id": "...",     # 可选，幂等键（Rin 传 "aistudio-<jobId>"）；
                                    #   重复提交直接返回已有 job_id，不重复扣费
    }
    → 200 {"ok": true, "job_id": "..."}（幂等命中时多带 "duplicate": true）

流程：
    1. 校验 Bearer + 参数（非法 → 400）
    2. POST MiniMax /v2/video_generation 提交任务 → minimax_task_id
    3. 后台线程每 10 秒轮询 /v2/query/video_generation/{task_id}，最多 2 小时
    4. succeeded → 下载 mp4（上限 500MB）存 {DATA_DIR}/{job_id}.mp4

配置（环境变量）：
    RELAY_SECRET      必填，中转鉴权密钥（Worker 侧 MINIMAX_RELAY_SECRET 与之相同）
    VIDEO_PROVIDER    默认 minimax；comfyui = 本地 ComfyUI 越狱后端（实现待补）
    MINIMAX_API_KEY   VIDEO_PROVIDER=minimax 时必填（platform.minimax.io 获取）
    MINIMAX_API_BASE  默认 https://api.minimax.io
    COMFYUI_URL       VIDEO_PROVIDER=comfyui 时用，默认 http://127.0.0.1:8188
    COMFYUI_WORKFLOW_T2V / COMFYUI_WORKFLOW_I2V  工作流 JSON 模板路径
    RELAY_BIND        默认 0.0.0.0
    RELAY_PORT        默认 18081
    DATA_DIR          默认 ./data（jobs.json + mp4 文件）
    FILE_TTL_DAYS     默认 30，成品文件保留天数，过期自动清理

注意：
    - 对外错误信息绝不包含 API key
    - MiniMax 按量计费：约 ¥0.5/秒 @768P、¥0.8/秒 @2K（以官网为准）
"""
from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from provider_base import VideoProvider
from provider_minimax import MiniMaxProvider, build_minimax_body, map_minimax_status

__all__ = [
    "build_minimax_body",
    "map_minimax_status",
    "validate_video_request",
    "is_valid_job_id",
    "job_public_view",
    "provider",
]

MINIMAX_MODEL = "MiniMax-H3"
PROMPT_MAX_CHARS = 7000
DURATION_MIN, DURATION_MAX = 4, 15
RESOLUTIONS = ("768P", "2K")
# t2v 可选比例（与 Worker 侧 MINIMAX_VIDEO_RATIOS 保持一致）；i2v 固定 adaptive
T2V_RATIOS = ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16")
# job_id 统一为 uuid4 hex；URL 里的 job_id 必须匹配，防止 ../../ 路径穿越
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
POLL_INTERVAL = 10  # 轮询间隔（秒）
POLL_TIMEOUT = 2 * 3600  # 单任务最长等待 2 小时
MAX_VIDEO_BYTES = 500 * 1024 * 1024  # mp4 下载上限 500MB
HTTP_TIMEOUT = 60
REQUEST_BODY_LIMIT = 1024 * 1024  # POST body 上限 1MB（prompt 才 7000 字）

CONFIG = {
    "secret": os.environ.get("RELAY_SECRET", ""),
    "video_provider": os.environ.get("VIDEO_PROVIDER", "minimax").strip().lower(),
    "minimax_key": os.environ.get("MINIMAX_API_KEY", ""),
    "minimax_base": os.environ.get("MINIMAX_API_BASE", "https://api.minimax.io").rstrip("/"),
    "comfyui_url": os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/"),
    "comfyui_workflow_t2v": os.environ.get("COMFYUI_WORKFLOW_T2V", ""),
    "comfyui_workflow_i2v": os.environ.get("COMFYUI_WORKFLOW_I2V", ""),
    "bind": os.environ.get("RELAY_BIND", "0.0.0.0"),
    "port": int(os.environ.get("RELAY_PORT", "18081")),
    "data_dir": Path(os.environ.get("DATA_DIR", "./data")),
    "file_ttl_days": int(os.environ.get("FILE_TTL_DAYS", "30")),
}


def _build_provider() -> VideoProvider:
    """按 VIDEO_PROVIDER 构造视频后端；未知值直接抛错（fail fast）。"""
    name = CONFIG["video_provider"]
    if name == "comfyui":
        from provider_comfyui import ComfyUIProvider

        return ComfyUIProvider(
            CONFIG["comfyui_url"],
            CONFIG["comfyui_workflow_t2v"],
            CONFIG["comfyui_workflow_i2v"],
        )
    if name == "minimax":
        return MiniMaxProvider(CONFIG["minimax_base"], CONFIG["minimax_key"])
    raise RuntimeError(f"未知的 VIDEO_PROVIDER: {name!r}（可选 minimax | comfyui）")


provider = _build_provider()

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
# 幂等键的 in-flight 预占：防止同一 client_job_id 的并发请求在
# MiniMax 提交（网络 IO，锁外）期间双双通过幂等检查导致重复扣费。
_inflight_client_ids: set[str] = set()


def log(msg: str) -> None:
    print(f"[minimax-relay {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ------------------------------------------------------------- 参数校验 --
def _is_http_url(s: object) -> bool:
    return isinstance(s, str) and s.startswith(("http://", "https://"))


def is_valid_job_id(job_id: object) -> bool:
    """job_id 必须为 uuid4 hex（32 位十六进制），防 ../../ 路径穿越。"""
    return isinstance(job_id, str) and JOB_ID_RE.match(job_id) is not None


def validate_video_request(body: dict) -> dict:
    """校验 POST /video 参数，返回规范化后的参数 dict；非法时抛 ValueError。"""
    if not isinstance(body, dict):
        raise ValueError("body 必须是 JSON 对象")

    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("缺少 prompt")
    if len(prompt) > PROMPT_MAX_CHARS:
        raise ValueError(f"prompt 超过 {PROMPT_MAX_CHARS} 字符上限（当前 {len(prompt)} 字符）")

    duration = body.get("duration", 6)
    if isinstance(duration, bool) or not isinstance(duration, int):
        raise ValueError("duration 必须是 4..15 的整数")
    if not (DURATION_MIN <= duration <= DURATION_MAX):
        raise ValueError("duration 必须是 4..15 的整数")

    resolution = body.get("resolution", "768P")
    if resolution not in RESOLUTIONS:
        raise ValueError("resolution 只能是 768P 或 2K")

    first_frame = body.get("first_frame_url")
    last_frame = body.get("last_frame_url")
    if first_frame is not None and not _is_http_url(first_frame):
        raise ValueError("first_frame_url 必须是 http(s) 地址")
    if last_frame is not None and not _is_http_url(last_frame):
        raise ValueError("last_frame_url 必须是 http(s) 地址")
    if last_frame and not first_frame:
        raise ValueError("last_frame_url 需要同时提供 first_frame_url")

    # t2v: ratio 必填且不能为 adaptive；i2v（给了首帧图）: ratio 固定 adaptive
    if first_frame:
        ratio = "adaptive"
    else:
        ratio = body.get("ratio", "16:9")
        if ratio == "adaptive":
            raise ValueError("文生视频（t2v）时 ratio 不能为 adaptive")
        if ratio not in T2V_RATIOS:
            raise ValueError("t2v 时 ratio 只能是 16:9 / 9:16 / 1:1")

    model = body.get("model", MINIMAX_MODEL)
    if not isinstance(model, str) or not model.strip():
        raise ValueError("model 不能为空")

    # 幂等键：调用方（Rin Worker）传 "aistudio-<jobId>"，queue 重投/重试时
    # relay 直接返回已有任务，不重复向 MiniMax 提交（避免重复扣费）
    client_job_id = body.get("client_job_id")
    if client_job_id is not None:
        if not isinstance(client_job_id, str) or not client_job_id.strip():
            raise ValueError("client_job_id 不能为空字符串")
        if len(client_job_id) > 128:
            raise ValueError("client_job_id 超过 128 字符上限")
        client_job_id = client_job_id.strip()

    return {
        "prompt": prompt.strip(),
        "duration": duration,
        "resolution": resolution,
        "ratio": ratio,
        "first_frame_url": first_frame,
        "last_frame_url": last_frame,
        "model": model.strip(),
        "client_job_id": client_job_id,
    }


# --- MiniMax 具体实现已搬到 provider_minimax.py ---
# build_minimax_body / map_minimax_status 在此 re-export（旧测试 import server 用）


def job_public_view(job: dict) -> dict:


# ------------------------------------------------------------- 任务存储 --
    """GET /video/{job_id} 的公开视图：绝不包含 MINIMAX_API_KEY 或内部 id。"""
    view: dict = {
        "ok": True,
        "job_id": job["job_id"],
        "status": job["status"],
        "prompt": job["prompt"][:120],
        "duration": job["duration"],
        "resolution": job["resolution"],
        "ratio": job["ratio"],
    }
    if job.get("error"):
        view["error"] = job["error"]
    if job.get("bytes") is not None:
        view["bytes"] = job["bytes"]
    return view


def download_video(url: str, dest: Path) -> int:
    """下载 mp4（上限 500MB），原子落盘，返回字节数；失败抛 RuntimeError。"""
    req = urllib.request.Request(url, headers={"User-Agent": "RinMiniMaxRelay/1.0"})
    tmp = dest.with_suffix(".mp4.tmp")
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r, tmp.open("wb") as f:
            while True:
                chunk = r.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_VIDEO_BYTES:
                    raise RuntimeError("视频超过 500MB 上限")
                f.write(chunk)
        if total == 0:
            raise RuntimeError("下载的视频为空")
    except RuntimeError:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as e:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"视频下载失败: {e}")
    os.replace(tmp, dest)
    return total


# ------------------------------------------------------------- 任务存储 --
def _jobs_path() -> Path:
    return CONFIG["data_dir"] / "jobs.json"


def _video_path(job_id: str) -> Path:
    return CONFIG["data_dir"] / f"{job_id}.mp4"


def save_jobs() -> None:
    """原子写入 jobs.json；调用方需持有 _jobs_lock。"""
    p = _jobs_path()
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def load_jobs() -> None:
    p = _jobs_path()
    if not p.exists():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        log(f"jobs.json 读取失败（从空开始）: {e}")
        return
    if isinstance(data, dict):
        with _jobs_lock:
            _jobs.update(data)
        log(f"载入 {_jobs.__len__()} 条历史任务")


def update_job(job_id: str, **fields) -> dict | None:
    """更新任务字段并持久化；任务不存在返回 None。"""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        job.update(fields)
        job["updated_at"] = time.time()
        save_jobs()
        return job


def delete_job(job_id: str) -> bool:
    """删除任务记录与成品文件；任务不存在返回 False。"""
    with _jobs_lock:
        job = _jobs.pop(job_id, None)
        if job is None:
            return False
        save_jobs()
    _video_path(job_id).unlink(missing_ok=True)
    return True


def find_job_by_client_id(client_job_id: str) -> dict | None:
    """按幂等键找已有任务；调用方需持有 _jobs_lock。"""
    for job in _jobs.values():
        if job.get("client_job_id") == client_job_id:
            return job
    return None


def cleanup_expired() -> None:
    """按 FILE_TTL_DAYS 清理过期成品文件及其任务记录。"""
    ttl_days = CONFIG["file_ttl_days"]
    if ttl_days <= 0:
        return
    cutoff = time.time() - ttl_days * 86400
    removed = 0
    with _jobs_lock:
        for job_id in [jid for jid, j in _jobs.items() if j.get("status") == "succeeded"]:
            p = _video_path(job_id)
            if p.exists() and p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
                _jobs.pop(job_id, None)
                removed += 1
        # 失败记录也按 TTL 清理（无成品文件，只删记录，避免 jobs.json 无限增长）
        for job_id in [
            jid
            for jid, j in _jobs.items()
            if j.get("status") == "failed" and j.get("updated_at", 0) < cutoff
        ]:
            _jobs.pop(job_id, None)
            removed += 1
        # 无记录的孤儿 mp4 也清理
        known = set(_jobs)
        for mp4 in CONFIG["data_dir"].glob("*.mp4"):
            if mp4.stem not in known and mp4.stat().st_mtime < cutoff:
                mp4.unlink(missing_ok=True)
                removed += 1
        if removed:
            save_jobs()
    if removed:
        log(f"清理过期文件 {removed} 个（TTL {ttl_days} 天）")


# ------------------------------------------------------------- 轮询 --
def poll_job(job_id: str) -> None:
    """后台线程：每 10 秒轮询视频后端，最多 2 小时；任务被删除则退出。"""
    log(f"job {job_id} 开始轮询（后端 {provider.name}）")
    while True:
        time.sleep(POLL_INTERVAL)
        with _jobs_lock:
            job = _jobs.get(job_id)
        if job is None:
            log(f"job {job_id} 已删除，停止轮询")
            return
        if job["status"] not in ("queued", "running"):
            return
        if time.time() - job["created_at"] > POLL_TIMEOUT:
            update_job(job_id, status="failed", error="轮询超时（2 小时未完成）")
            log(f"job {job_id} 轮询超时，标记 failed")
            return
        # 兼容旧版 jobs.json（minimax_task_id）；新任务记 provider_task_id
        backend_task_id = job.get("provider_task_id") or job.get("minimax_task_id")
        try:
            status, url = provider.query(backend_task_id)
        except RuntimeError as e:
            log(f"job {job_id} 查询失败，下次重试: {e}")
            continue
        except ValueError:
            log(f"job {job_id} 收到未知状态，继续等待")
            continue
        if status in ("queued", "running"):
            if job["status"] != status:
                update_job(job_id, status=status)
            continue
        if status == "succeeded":
            if not url:
                update_job(job_id, status="failed", error=f"{provider.name} 标记成功但未返回下载地址")
                return
            log(f"job {job_id} 生成成功，开始下载 mp4")
            try:
                total = download_video(url, _video_path(job_id))
            except RuntimeError as e:
                update_job(job_id, status="failed", error=str(e))
                return
            # 下载期间任务可能被 DELETE
            if update_job(job_id, status="succeeded", bytes=total) is None:
                _video_path(job_id).unlink(missing_ok=True)
                return
            log(f"job {job_id} 下载完成 {total} 字节")
            return
        # failed
        update_job(job_id, status="failed", error=f"{provider.name} 任务失败")
        log(f"job {job_id} 后端返回失败，标记 failed")
        return


def resume_jobs() -> None:
    """启动时恢复未完成的任务（queued/running）的轮询；超期的直接标记失败。"""
    resumed = 0
    with _jobs_lock:
        pending = [j for j in _jobs.values() if j.get("status") in ("queued", "running")]
    for job in pending:
        job_id = job["job_id"]
        if time.time() - job.get("created_at", 0) > POLL_TIMEOUT:
            update_job(job_id, status="failed", error="重启时已超过 2 小时轮询时限")
            continue
        threading.Thread(target=poll_job, args=(job_id,), daemon=True).start()
        resumed += 1
    if resumed:
        log(f"恢复 {resumed} 个未完成任务的轮询")


# ---------------------------------------------------------------- HTTP --
class Handler(BaseHTTPRequestHandler):
    server_version = "RinMiniMaxRelay/1.0"

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
        return bool(CONFIG["secret"]) and hmac.compare_digest(given, CONFIG["secret"])

    def _read_json(self) -> tuple[dict | None, str | None]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > REQUEST_BODY_LIMIT:
            return None, "body 为空或超过 1MB"
        try:
            return json.loads(self.rfile.read(length)), None
        except Exception:
            return None, "body 不是合法 JSON"

    def _serve_mp4(self, path: Path) -> None:
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.end_headers()
        with path.open("rb") as f:
            shutil.copyfileobj(f, self.wfile, length=1024 * 1024)

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            self._send(200, {"ok": True, "service": "minimax-relay", "provider": provider.name, "model": MINIMAX_MODEL})
            return
        segs = path.strip("/").split("/")
        if len(segs) >= 2 and segs[0] == "video":
            job_id = segs[1]
            if len(segs) == 2:
                self._handle_job_status(job_id)
                return
            if len(segs) == 3 and segs[2] == "file":
                self._handle_job_file(job_id)
                return
        self._send(404, {"ok": False, "error": "not_found"})

    def _handle_job_status(self, job_id: str) -> None:
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        if not is_valid_job_id(job_id):
            self._send(404, {"ok": False, "error": "not_found"})
            return
        with _jobs_lock:
            job = _jobs.get(job_id)
        if job is None:
            self._send(404, {"ok": False, "error": "not_found"})
            return
        self._send(200, job_public_view(job))

    def _handle_job_file(self, job_id: str) -> None:
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        if not is_valid_job_id(job_id):
            self._send(404, {"ok": False, "error": "not_found"})
            return
        with _jobs_lock:
            job = _jobs.get(job_id)
        if job is None:
            self._send(404, {"ok": False, "error": "not_found"})
            return
        mp4 = _video_path(job_id)
        if job["status"] != "succeeded" or not mp4.exists():
            self._send(404, {"ok": False, "error": "not_ready"})
            return
        self._serve_mp4(mp4)

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path != "/video":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        body, err = self._read_json()
        if err:
            self._send(400, {"ok": False, "error": err})
            return
        try:
            params = validate_video_request(body or {})
        except ValueError as e:
            self._send(400, {"ok": False, "error": str(e)})
            return
        # 幂等：带 client_job_id 的重复提交直接返回已有任务，不重复扣费。
        # 检查与 MiniMax 提交之间有网络 IO，不能拿同一把锁包住整个提交，
        # 因此用 in-flight 预占集防止并发双提交：后来者等待先行者完成。
        client_job_id = params["client_job_id"]
        if client_job_id:
            deadline = time.time() + 30
            while True:
                with _jobs_lock:
                    existing = find_job_by_client_id(client_job_id)
                    if existing is not None:
                        log(f"幂等命中 client_job_id={client_job_id}，返回已有 job {existing['job_id']}")
                        self._send(200, {"ok": True, "job_id": existing["job_id"], "duplicate": True})
                        return
                    if client_job_id not in _inflight_client_ids:
                        _inflight_client_ids.add(client_job_id)
                        break
                if time.time() > deadline:
                    self._send(409, {"ok": False, "error": "duplicate_in_flight，请稍后重试"})
                    return
                time.sleep(0.2)
        try:
            task_id = provider.submit(params)
        except RuntimeError as e:
            if client_job_id:
                with _jobs_lock:
                    _inflight_client_ids.discard(client_job_id)
            log(f"{provider.name} 提交失败: {e}")
            self._send(502, {"ok": False, "error": provider.submit_error_code, "detail": str(e)})
            return
        job_id = uuid.uuid4().hex
        now = time.time()
        with _jobs_lock:
            _jobs[job_id] = {
                "job_id": job_id,
                "provider": provider.name,
                "provider_task_id": task_id,
                "client_job_id": params["client_job_id"],
                "prompt": params["prompt"],
                "duration": params["duration"],
                "resolution": params["resolution"],
                "ratio": params["ratio"],
                "model": params["model"],
                "status": "queued",
                "created_at": now,
                "updated_at": now,
            }
            if client_job_id:
                _inflight_client_ids.discard(client_job_id)
            save_jobs()
        threading.Thread(target=poll_job, args=(job_id,), daemon=True).start()
        log(f"job {job_id} 已提交，后端={provider.name} task_id={task_id}")
        self._send(200, {"ok": True, "job_id": job_id})

    def do_DELETE(self) -> None:  # noqa: N802
        segs = urllib.parse.urlparse(self.path).path.strip("/").split("/")
        if len(segs) != 2 or segs[0] != "video":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        job_id = segs[1]
        if not is_valid_job_id(job_id):
            self._send(404, {"ok": False, "error": "not_found"})
            return
        if not delete_job(job_id):
            self._send(404, {"ok": False, "error": "not_found"})
            return
        log(f"job {job_id} 已删除")
        self._send(200, {"ok": True, "job_id": job_id})

    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        log(fmt % args)


def main() -> None:
    if not CONFIG["secret"]:
        print("ERROR: 必须设置 RELAY_SECRET 环境变量", file=sys.stderr)
        sys.exit(1)
    try:
        provider.validate_config()
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    CONFIG["data_dir"].mkdir(parents=True, exist_ok=True)
    load_jobs()
    cleanup_expired()
    resume_jobs()
    server = ThreadingHTTPServer((CONFIG["bind"], CONFIG["port"]), Handler)
    log(
        f"listening on {CONFIG['bind']}:{CONFIG['port']}, "
        f"provider={provider.name}, data_dir={CONFIG['data_dir']}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
