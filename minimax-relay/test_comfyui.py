#!/usr/bin/env python3
"""ComfyUI 后端单测：占位符填充、提交/查询逻辑、配置校验。

不碰真实 ComfyUI：_request 被 mock 掉。
`python3 test_comfyui.py` 全绿。
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from provider_comfyui import ComfyUIProvider  # noqa: E402

TEMPLATE = json.dumps(
    {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{PROMPT}}"}},
        "2": {"class_type": "LoadImage", "inputs": {"image": "{{FIRST_FRAME_FILE}}"}},
        "3": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"length": "{{LENGTH}}"}},
    }
)


def make_provider(tmp: Path) -> ComfyUIProvider:
    t2v = tmp / "t2v.json"
    i2v = tmp / "i2v.json"
    t2v.write_text(TEMPLATE, encoding="utf-8")
    i2v.write_text(TEMPLATE, encoding="utf-8")
    return ComfyUIProvider("http://127.0.0.1:8188", str(t2v), str(i2v))


class TestFill(unittest.TestCase):
    def test_prompt_escaped(self):
        wf = ComfyUIProvider._fill(TEMPLATE, 'say "hi"\n换行', "")
        self.assertEqual(wf["1"]["inputs"]["text"], 'say "hi"\n换行')

    def test_image_file_filled(self):
        wf = ComfyUIProvider._fill(TEMPLATE, "p", "rin_abc.png")
        self.assertEqual(wf["2"]["inputs"]["image"], "rin_abc.png")

    def test_bad_template_raises(self):
        with self.assertRaises(RuntimeError):
            ComfyUIProvider._fill("{not json", "p", "")

    def test_length_becomes_number(self):
        wf = ComfyUIProvider._fill(TEMPLATE, "p", "", 124)
        self.assertEqual(wf["3"]["inputs"]["length"], 124)
        self.assertIsInstance(wf["3"]["inputs"]["length"], int)

    def test_frames_for_duration(self):
        f = ComfyUIProvider._frames_for_duration
        self.assertEqual(f(5), 124)    # 5s → 124 帧（社区 3090 实测配置）
        self.assertEqual(f(15), 362)   # 15s → 362 帧
        self.assertEqual(f(4), 90)
        self.assertEqual(f(6), 141)
        self.assertEqual(f(99), 362)   # 上限钳制
        self.assertEqual(f("bad"), 124)  # 非法输入回退 5s


class TestSubmit(unittest.TestCase):
    def test_t2v_submit(self):
        tmp = Path(tempfile.mkdtemp(prefix="comfyui-test-"))
        p = make_provider(tmp)
        captured = {}

        def fake_request(method, path, payload=None, **kw):
            captured["method"] = method
            captured["path"] = path
            captured["payload"] = payload
            return {"prompt_id": "pid-123"}

        p._request = fake_request  # type: ignore[method-assign]
        pid = p.submit({"prompt": "一只猫", "first_frame_url": ""})
        self.assertEqual(pid, "pid-123")
        self.assertEqual(captured["path"], "/prompt")
        wf = captured["payload"]["prompt"]
        self.assertEqual(wf["1"]["inputs"]["text"], "一只猫")

    def test_i2v_uploads_image(self):
        tmp = Path(tempfile.mkdtemp(prefix="comfyui-test-"))
        p = make_provider(tmp)
        uploaded = {}

        def fake_upload(url):
            uploaded["url"] = url
            return "rin_up.png"

        p._upload_image = fake_upload  # type: ignore[method-assign]
        p._request = lambda method, path, payload=None, **kw: {"prompt_id": "pid-9"}  # type: ignore[method-assign]
        pid = p.submit({"prompt": "p", "first_frame_url": "https://x/y.jpg"})
        self.assertEqual(pid, "pid-9")
        self.assertEqual(uploaded["url"], "https://x/y.jpg")

    def test_submit_no_prompt_id_raises(self):
        tmp = Path(tempfile.mkdtemp(prefix="comfyui-test-"))
        p = make_provider(tmp)
        p._request = lambda *a, **k: {}  # type: ignore[method-assign]
        with self.assertRaises(RuntimeError):
            p.submit({"prompt": "p"})


class TestQuery(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="comfyui-test-"))
        self.p = make_provider(tmp)

    def _hist(self, entry):
        self.p._request = lambda *a, **k: {"pid-1": entry} if entry else {}  # type: ignore[method-assign]

    def test_no_history_means_running(self):
        self._hist(None)
        self.assertEqual(self.p.query("pid-1"), ("running", None))

    def test_not_completed_means_running(self):
        self._hist({"status": {"completed": False, "status_str": "success"}, "outputs": {}})
        self.assertEqual(self.p.query("pid-1"), ("running", None))

    def test_error_status_means_failed(self):
        self._hist(
            {"status": {"completed": True, "status_str": "error", "messages": []}, "outputs": {}}
        )
        self.assertEqual(self.p.query("pid-1"), ("failed", None))

    def test_success_no_video_means_failed(self):
        self._hist({"status": {"completed": True, "status_str": "success"}, "outputs": {}})
        self.assertEqual(self.p.query("pid-1"), ("failed", None))

    def test_success_with_video(self):
        self._hist(
            {
                "status": {"completed": True, "status_str": "success"},
                "outputs": {
                    "10": {
                        "gifs": [
                            {
                                "filename": "vid_001.mp4",
                                "subfolder": "",
                                "type": "output",
                            }
                        ]
                    }
                },
            }
        )
        status, url = self.p.query("pid-1")
        self.assertEqual(status, "succeeded")
        self.assertIn("/view?", url or "")
        self.assertIn("vid_001.mp4", url or "")

    def test_success_with_video_in_images_animated(self):
        # 新版 ComfyUI 的 SaveVideo 把视频放在 images 下，用 animated 标记
        self._hist(
            {
                "status": {"completed": True, "status_str": "success"},
                "outputs": {
                    "92": {
                        "images": [
                            {
                                "filename": "h3_t2v_00001_.mp4",
                                "subfolder": "video",
                                "type": "output",
                            }
                        ],
                        "animated": True,
                    }
                },
            }
        )
        status, url = self.p.query("pid-1")
        self.assertEqual(status, "succeeded")
        self.assertIn("h3_t2v_00001_.mp4", url or "")
        self.assertIn("subfolder=video", url or "")

    def test_images_without_animated_not_video(self):
        # 纯静态图输出不应被当作成片
        self._hist(
            {
                "status": {"completed": True, "status_str": "success"},
                "outputs": {"5": {"images": [{"filename": "pic.png", "subfolder": "", "type": "output"}]}},
            }
        )
        self.assertEqual(self.p.query("pid-1"), ("failed", None))


class TestValidateConfig(unittest.TestCase):
    def test_missing_workflow_raises(self):
        p = ComfyUIProvider("http://127.0.0.1:8188", "/nope/t2v.json", "/nope/i2v.json")
        with self.assertRaises(RuntimeError):
            p.validate_config()

    def test_bad_url_raises(self):
        tmp = Path(tempfile.mkdtemp(prefix="comfyui-test-"))
        p = make_provider(tmp)
        p.base_url = "not-a-url"
        with self.assertRaises(RuntimeError):
            p.validate_config()

    def test_ok(self):
        tmp = Path(tempfile.mkdtemp(prefix="comfyui-test-"))
        make_provider(tmp).validate_config()


if __name__ == "__main__":
    unittest.main(verbosity=2)
