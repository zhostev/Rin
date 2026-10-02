#!/usr/bin/env python3
"""minimax-relay 纯函数单测：参数校验、MiniMax body 构造、状态映射。

不碰网络：`python3 test_server.py` 全绿。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from server import (  # noqa: E402
    build_minimax_body,
    is_valid_job_id,
    job_public_view,
    map_minimax_status,
    validate_video_request,
)


def base_body(**overrides):
    body = {"prompt": "一只猫在月光下散步"}
    body.update(overrides)
    return body


class TestValidateVideoRequest(unittest.TestCase):
    def test_defaults_t2v(self):
        p = validate_video_request(base_body())
        self.assertEqual(p["duration"], 6)
        self.assertEqual(p["resolution"], "768P")
        self.assertEqual(p["ratio"], "16:9")
        self.assertEqual(p["model"], "MiniMax-H3")
        self.assertIsNone(p["first_frame_url"])

    def test_missing_prompt(self):
        with self.assertRaises(ValueError):
            validate_video_request({})
        with self.assertRaises(ValueError):
            validate_video_request({"prompt": "   "})

    def test_non_dict_body(self):
        with self.assertRaises(ValueError):
            validate_video_request([1, 2, 3])  # type: ignore[arg-type]

    def test_prompt_too_long(self):
        with self.assertRaises(ValueError):
            validate_video_request(base_body(prompt="x" * 7001))
        # 7000 整可以通过
        p = validate_video_request(base_body(prompt="x" * 7000))
        self.assertEqual(len(p["prompt"]), 7000)

    def test_duration_range(self):
        for bad in (3, 16, 0, -1, "6", 6.0, True, None):
            with self.assertRaises(ValueError, msg=f"duration={bad!r}"):
                validate_video_request(base_body(duration=bad))
        for good in (4, 6, 15):
            self.assertEqual(validate_video_request(base_body(duration=good))["duration"], good)

    def test_resolution(self):
        with self.assertRaises(ValueError):
            validate_video_request(base_body(resolution="4K"))
        self.assertEqual(validate_video_request(base_body(resolution="2K"))["resolution"], "2K")

    def test_t2v_ratio_rejects_adaptive(self):
        with self.assertRaises(ValueError):
            validate_video_request(base_body(ratio="adaptive"))

    def test_t2v_ratio_allowlist(self):
        # 与 Worker 侧 MINIMAX_VIDEO_RATIOS 保持一致：6 种显式比例
        for r in ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16"):
            self.assertEqual(validate_video_request(base_body(ratio=r))["ratio"], r)
        with self.assertRaises(ValueError):
            validate_video_request(base_body(ratio="2:1"))

    def test_client_job_id_optional(self):
        p = validate_video_request(base_body())
        self.assertIsNone(p["client_job_id"])
        p = validate_video_request(base_body(client_job_id="aistudio-123"))
        self.assertEqual(p["client_job_id"], "aistudio-123")
        with self.assertRaises(ValueError):
            validate_video_request(base_body(client_job_id=""))
        with self.assertRaises(ValueError):
            validate_video_request(base_body(client_job_id="x" * 129))

    def test_i2v_forces_adaptive(self):
        # i2v 时即使传了 ratio 也被固定为 adaptive
        p = validate_video_request(
            base_body(first_frame_url="https://example.com/a.jpg", ratio="16:9")
        )
        self.assertEqual(p["ratio"], "adaptive")
        p = validate_video_request(base_body(first_frame_url="https://example.com/a.jpg"))
        self.assertEqual(p["ratio"], "adaptive")

    def test_i2v_bad_frame_url(self):
        with self.assertRaises(ValueError):
            validate_video_request(base_body(first_frame_url="not-a-url"))
        with self.assertRaises(ValueError):
            validate_video_request(base_body(first_frame_url="ftp://example.com/a.jpg"))

    def test_last_frame_requires_first_frame(self):
        with self.assertRaises(ValueError):
            validate_video_request(base_body(last_frame_url="https://example.com/b.jpg"))

    def test_model_default_and_empty(self):
        self.assertEqual(validate_video_request(base_body())["model"], "MiniMax-H3")
        with self.assertRaises(ValueError):
            validate_video_request(base_body(model=""))


class TestBuildMiniMaxBody(unittest.TestCase):
    def test_t2v_body(self):
        params = validate_video_request(base_body(duration=8, resolution="2K", ratio="9:16"))
        body = build_minimax_body(params)
        self.assertEqual(
            body,
            {
                "model": "MiniMax-H3",
                "content": [{"type": "text", "text": "一只猫在月光下散步"}],
                "resolution": "2K",
                "duration": 8,
                "ratio": "9:16",
            },
        )

    def test_i2v_body_frames(self):
        params = validate_video_request(
            base_body(
                first_frame_url="https://example.com/first.jpg",
                last_frame_url="https://example.com/last.jpg",
            )
        )
        body = build_minimax_body(params)
        self.assertEqual(body["ratio"], "adaptive")
        self.assertEqual(len(body["content"]), 3)
        self.assertEqual(body["content"][0], {"type": "text", "text": "一只猫在月光下散步"})
        self.assertEqual(
            body["content"][1],
            {
                "type": "image_url",
                "image_url": {"url": "https://example.com/first.jpg"},
                "role": "first_frame",
            },
        )
        self.assertEqual(body["content"][2]["role"], "last_frame")
        self.assertEqual(body["content"][2]["image_url"]["url"], "https://example.com/last.jpg")


class TestMapMiniMaxStatus(unittest.TestCase):
    def test_mapping(self):
        self.assertEqual(map_minimax_status("queued"), "queued")
        self.assertEqual(map_minimax_status("running"), "running")
        self.assertEqual(map_minimax_status("succeeded"), "succeeded")
        self.assertEqual(map_minimax_status("failed"), "failed")
        self.assertEqual(map_minimax_status("cancelled"), "failed")

    def test_unknown_raises(self):
        with self.assertRaises(ValueError):
            map_minimax_status("weird")
        with self.assertRaises(ValueError):
            map_minimax_status("")


class TestIsValidJobId(unittest.TestCase):
    def test_valid(self):
        self.assertTrue(is_valid_job_id("a" * 32))
        self.assertTrue(is_valid_job_id("0123456789abcdef0123456789abcdef"))

    def test_rejects_traversal_and_garbage(self):
        for bad in ("../../etc/passwd", "..", "", "abc", "A" * 32, "a" * 31, "a" * 33, None, 123):
            self.assertFalse(is_valid_job_id(bad), msg=f"job_id={bad!r}")


class TestJobPublicView(unittest.TestCase):
    def _job(self, **overrides):
        job = {
            "job_id": "abc123",
            "minimax_task_id": "mm-999",  # 内部字段，不应出现在公开视图
            "prompt": "x" * 200,
            "duration": 6,
            "resolution": "768P",
            "ratio": "16:9",
            "model": "MiniMax-H3",
            "status": "succeeded",
            "created_at": 0,
            "updated_at": 0,
        }
        job.update(overrides)
        return job

    def test_prompt_truncated_to_120(self):
        view = job_public_view(self._job())
        self.assertEqual(len(view["prompt"]), 120)

    def test_no_secret_leak(self):
        view = job_public_view(self._job(error="boom", bytes=123))
        self.assertNotIn("minimax_task_id", view)
        # API key 不可能出现在视图里（模块常量里也不含它）
        self.assertNotIn(server.CONFIG["minimax_key"] or "NEVER_SET", json_dumps(view))
        self.assertEqual(view["error"], "boom")
        self.assertEqual(view["bytes"], 123)

    def test_optional_fields_omitted(self):
        view = job_public_view(self._job())
        self.assertNotIn("error", view)
        self.assertNotIn("bytes", view)


def json_dumps(obj):
    import json

    return json.dumps(obj)


if __name__ == "__main__":
    unittest.main(verbosity=2)
