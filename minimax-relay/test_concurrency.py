#!/usr/bin/env python3
"""minimax-relay 并发幂等测试：同一 client_job_id 的并发提交只调一次后端。

起真实 ThreadingHTTPServer（127.0.0.1 随机端口），mock 掉 provider.submit，
8 个线程同时 POST /video，断言 MiniMax 只被调用一次、所有响应 job_id 一致。
"""
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from server import Handler  # noqa: E402


class TestConcurrentIdempotentSubmit(unittest.TestCase):
    def test_same_client_job_id_submits_once(self):
        tmp = Path(tempfile.mkdtemp(prefix="minimax-relay-test-"))
        server.CONFIG["secret"] = "test-secret"
        server.CONFIG["data_dir"] = tmp
        server.CONFIG["minimax_key"] = "test-key"
        with server._jobs_lock:
            server._jobs.clear()
            server._inflight_client_ids.clear()

        calls: list[str] = []
        orig_submit = server.provider.submit

        def fake_submit(params):
            calls.append(params["client_job_id"])
            time.sleep(0.3)  # 放大竞态窗口：无预占时必现双提交
            return "mm-task-1"

        server.provider.submit = fake_submit  # type: ignore[method-assign]
        # 后台轮询线程不跑（不断言轮询行为）
        orig_poll = server.poll_job
        server.poll_job = lambda job_id: None  # type: ignore[method-assign]
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            port = httpd.server_address[1]
            threading.Thread(target=httpd.serve_forever, daemon=True).start()

            results: list[dict] = []
            errors: list[str] = []

            def post_once():
                try:
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}/video",
                        data=json.dumps(
                            {"prompt": "并发测试", "client_job_id": "cid-123"}
                        ).encode(),
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": "Bearer test-secret",
                        },
                    )
                    with urllib.request.urlopen(req, timeout=30) as r:
                        results.append(json.loads(r.read()))
                except Exception as e:  # noqa: BLE001
                    errors.append(str(e))

            threads = [threading.Thread(target=post_once) for _ in range(8)]
            for th in threads:
                th.start()
            for th in threads:
                th.join(timeout=60)
            httpd.shutdown()
            httpd.server_close()

            self.assertEqual(errors, [])
            self.assertEqual(len(results), 8)
            self.assertEqual(len(calls), 1, f"后端被调用了 {len(calls)} 次")
            self.assertEqual(len({r["job_id"] for r in results}), 1)
            self.assertEqual(sum(1 for r in results if r.get("duplicate")), 7)
        finally:
            server.provider.submit = orig_submit  # type: ignore[method-assign]
            server.poll_job = orig_poll  # type: ignore[method-assign]


if __name__ == "__main__":
    unittest.main(verbosity=2)
