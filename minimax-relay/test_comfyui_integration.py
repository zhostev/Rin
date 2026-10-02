#!/usr/bin/env python3
"""ComfyUI provider 集成测试：本地 fake ComfyUI 服务器 + 真实 HTTP 链路。

覆盖：t2v 提交（校验 {{PROMPT}} 替换）、i2v 首帧下载→上传→{{FIRST_FRAME_FILE}}
替换、轮询 running→succeeded、成片 URL 真实可下载。
不需要真实 ComfyUI / 显卡：`python3 test_comfyui_integration.py` 全绿。
"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from provider_comfyui import ComfyUIProvider  # noqa: E402

# 1x1 PNG（首帧下载用）
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de"
    "0000000c4944415478da6360000000020001e221bc330000000049454e44ae426082"
)
MP4 = b"fake-mp4-bytes"

STATE = {"prompts": [], "polls": 0, "uploads": []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/firstframe.png":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
        elif self.path.startswith("/history/"):
            STATE["polls"] += 1
            if STATE["polls"] < 3:
                self._json({})  # 还在跑
            else:
                self._json(
                    {
                        "test-123": {
                            "status": {"completed": True, "status_str": "success"},
                            "outputs": {
                                "9": {
                                    "gifs": [
                                        {
                                            "filename": "h3_out.mp4",
                                            "subfolder": "",
                                            "type": "output",
                                        }
                                    ]
                                }
                            },
                        }
                    }
                )
        elif self.path.startswith("/view"):
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(MP4)))
            self.end_headers()
            self.wfile.write(MP4)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        if self.path == "/prompt":
            payload = json.loads(body)
            STATE["prompts"].append(payload["prompt"])
            self._json({"prompt_id": "test-123", "number": 1, "node_errors": {}})
        elif self.path == "/upload/image":
            STATE["uploads"].append(len(body))
            self._json({"name": "rin_uploaded.png", "subfolder": "", "type": "input"})
        else:
            self.send_response(404)
            self.end_headers()


class TestIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.tmp = Path(tempfile.mkdtemp(prefix="h3-it-"))
        tpl = json.dumps(
            {
                "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{PROMPT}}"}},
                "2": {
                    "class_type": "LoadImage",
                    "inputs": {"image": "{{FIRST_FRAME_FILE}}"},
                },
                "3": {
                    "class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"length": "{{LENGTH}}"},
                },
            }
        )
        (cls.tmp / "t2v.json").write_text(tpl, encoding="utf-8")
        (cls.tmp / "i2v.json").write_text(tpl, encoding="utf-8")
        cls.p = ComfyUIProvider(
            f"http://127.0.0.1:{cls.port}",
            str(cls.tmp / "t2v.json"),
            str(cls.tmp / "i2v.json"),
        )
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_full_flow(self):
        # 1. 文生视频提交：prompt 占位符被替换，duration 映射为帧数
        pid = self.p.submit(
            {"prompt": "一只猫在下雨", "first_frame_url": "", "duration": 5}
        )
        self.assertEqual(pid, "test-123")
        wf = STATE["prompts"][-1]
        self.assertEqual(wf["1"]["inputs"]["text"], "一只猫在下雨")
        self.assertEqual(wf["3"]["inputs"]["length"], 124)

        # 2. 图生视频提交：首帧下载→上传→文件名回填
        pid2 = self.p.submit(
            {"prompt": "让它动起来", "first_frame_url": f"{self.base}/firstframe.png"}
        )
        self.assertEqual(pid2, "test-123")
        self.assertEqual(len(STATE["uploads"]), 1)
        wf2 = STATE["prompts"][-1]
        self.assertEqual(wf2["2"]["inputs"]["image"], "rin_uploaded.png")
        self.assertEqual(wf2["1"]["inputs"]["text"], "让它动起来")

        # 3. 轮询：running → succeeded，成片 URL 可下载
        self.assertEqual(self.p.query("test-123"), ("running", None))
        self.assertEqual(self.p.query("test-123"), ("running", None))
        status, url = self.p.query("test-123")
        self.assertEqual(status, "succeeded")
        self.assertIsNotNone(url)
        assert url is not None
        self.assertIn("h3_out.mp4", url)
        # provider 返回的是绝对 URL，直接下载
        with urllib.request.urlopen(url, timeout=10) as r:
            self.assertEqual(r.read(), MP4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
