#!/usr/bin/env python3
"""wechat-relay/server.py 的单测（微信 API 全部 mock，不出网）。"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "relay_server", str(Path(__file__).parent / "server.py")
)
server = importlib.util.module_from_spec(SPEC)
sys.modules["relay_server"] = server
SPEC.loader.exec_module(server)


class TestExtractImageUrls(unittest.TestCase):
    def test_relative_resolved(self):
        md = "a ![]( /api/media/10/playback ) b ![](/abs.png)"
        pairs = server.extract_image_urls(md, "https://s7ea.com")
        self.assertEqual(
            pairs,
            [
                ("/api/media/10/playback", "https://s7ea.com/api/media/10/playback"),
                ("/abs.png", "https://s7ea.com/abs.png"),
            ],
        )

    def test_dedup_and_absolute_kept(self):
        md = "![](https://x.com/a.png)\n![](https://x.com/a.png)"
        pairs = server.extract_image_urls(md, "https://s7ea.com")
        self.assertEqual(pairs, [("https://x.com/a.png", "https://x.com/a.png")])

    def test_data_url_skipped(self):
        md = "![](data:image/png;base64,AAA)"
        self.assertEqual(server.extract_image_urls(md, "https://s7ea.com"), [])


class TestMarkdownToWechatHtml(unittest.TestCase):
    def test_basic(self):
        md = "# 标题\n\n段落**加粗**和*斜体*，`代码`。\n\n## 二级\n\n- a\n- b\n\n1. x\n2. y\n\n> 引用\n\n---\n\n[链接](https://x.com)"
        out = server.markdown_to_wechat_html(md, {})
        self.assertIn("<h1>标题</h1>", out)
        self.assertIn("<strong>加粗</strong>", out)
        self.assertIn("<em>斜体</em>", out)
        self.assertIn("<code>代码</code>", out)
        self.assertIn("<h2>二级</h2>", out)
        self.assertIn("<ul>", out)
        self.assertIn("<ol>", out)
        self.assertIn("<blockquote>引用</blockquote>", out)
        self.assertIn("<hr/>", out)
        self.assertIn('<a href="https://x.com">链接</a>', out)

    def test_code_block(self):
        md = "```python\nprint(1)\n```"
        out = server.markdown_to_wechat_html(md, {})
        self.assertIn("<pre><code>", out)
        self.assertIn("print(1)", out)

    def test_images_replaced_with_mmbiz(self):
        md = "看图：\n\n![猫](/api/media/10/playback)\n\n结束"
        url_map = {"/api/media/10/playback": "https://mmbiz.qpic.cn/abc"}
        out = server.markdown_to_wechat_html(md, url_map)
        self.assertIn('src="https://mmbiz.qpic.cn/abc"', out)
        self.assertIn('alt="猫"', out)
        self.assertNotIn("/api/media/10/playback", out)

    def test_html_escaped(self):
        md = "<script>alert(1)</script>"
        out = server.markdown_to_wechat_html(md, {})
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)


class TestPushDraftValidation(unittest.TestCase):
    def _body(self, **kw):
        base = {
            "title": "标题",
            "digest": "摘要",
            "author": "作者",
            "content_markdown": "正文 ![](https://x.com/a.png)",
            "site_base_url": "https://s7ea.com",
            "article_url": "https://s7ea.com/feed/1",
        }
        base.update(kw)
        return base

    def test_missing_title(self):
        with self.assertRaises(ValueError):
            server.push_draft(self._body(title=""))

    def test_title_too_long(self):
        with self.assertRaises(ValueError):
            server.push_draft(self._body(title="中" * 22))  # 66 字节

    def test_empty_content(self):
        with self.assertRaises(ValueError):
            server.push_draft(self._body(content_markdown="  "))

    def test_no_images(self):
        with self.assertRaisesRegex(ValueError, "封面图"):
            server.push_draft(self._body(content_markdown="纯文字正文"))

    def test_missing_site_base_url(self):
        with self.assertRaises(ValueError):
            server.push_draft(self._body(site_base_url=""))


class TestPushDraftFlow(unittest.TestCase):
    """完整流程：下载 / uploadimg / thumb / draft/add 全部 mock。"""

    def _body(self):
        return {
            "title": "测试标题",
            "digest": "摘要",
            "author": "作者",
            "content_markdown": "# 头\n\n![猫](/api/media/10/playback)\n\n![狗](https://x.com/dog.png)",
            "site_base_url": "https://s7ea.com",
            "article_url": "https://s7ea.com/feed/1",
        }

    def test_full_flow(self):
        calls = {"uploadimg": 0, "thumb": 0, "draft": None}

        def fake_download(url):
            return (b"\xff\xd8fake", "img.jpg")

        def fake_upload_inline(data, filename):
            calls["uploadimg"] += 1
            return f"https://mmbiz.qpic.cn/img{calls['uploadimg']}"

        def fake_upload_thumb(data, filename):
            calls["thumb"] += 1
            # 封面必须是第一张图
            self.assertEqual(data, b"\xff\xd8fake")
            return "THUMB_ID_1"

        def fake_wechat_api(path, payload=None):
            self.assertEqual(path, "/draft/add")
            article = payload["articles"][0]
            calls["draft"] = article
            return {"media_id": "DRAFT_ID_1"}

        with (
            patch.object(server, "download_image", side_effect=fake_download),
            patch.object(server, "upload_inline_image", side_effect=fake_upload_inline),
            patch.object(server, "upload_thumb", side_effect=fake_upload_thumb),
            patch.object(server, "wechat_api_call", side_effect=fake_wechat_api),
        ):
            result = server.push_draft(self._body())

        self.assertEqual(result["draft_media_id"], "DRAFT_ID_1")
        self.assertEqual(result["thumb_media_id"], "THUMB_ID_1")
        self.assertEqual(calls["uploadimg"], 2)
        article = calls["draft"]
        self.assertEqual(article["title"], "测试标题")
        self.assertEqual(article["content_source_url"], "https://s7ea.com/feed/1")
        # 两张图都被换成 mmbiz，且相对地址写法也被替换
        self.assertIn("https://mmbiz.qpic.cn/img1", article["content"])
        self.assertIn("https://mmbiz.qpic.cn/img2", article["content"])
        self.assertNotIn("/api/media/10/playback", article["content"])


class TestHandlerAuth(unittest.TestCase):
    def test_rejects_empty_secret(self):
        # Handler._authorized 在 secret 为空时必须返回 False（避免空密钥放行）
        server.CONFIG["secret"] = ""
        h = server.Handler.__new__(server.Handler)
        h.headers = {"Authorization": "Bearer "}
        self.assertFalse(h._authorized())
        server.CONFIG["secret"] = "test-secret"

    def test_bearer_compare(self):
        server.CONFIG["secret"] = "s3cr3t"
        h = server.Handler.__new__(server.Handler)
        h.headers = {"Authorization": "Bearer s3cr3t"}
        self.assertTrue(h._authorized())
        h.headers = {"Authorization": "Bearer wrong"}
        self.assertFalse(h._authorized())
        h.headers = {}
        self.assertFalse(h._authorized())


class TestAccessTokenStableEndpoint(unittest.TestCase):
    """token 必须走 stable_token（普通模式），否则会与每日 cron 的 /cgi-bin/token 互踢。"""

    def setUp(self):
        server._token_cache.clear()
        server._last_force_refresh = 0.0
        self.calls = []

        def fake_http_json(url, data=None, headers=None):
            self.calls.append({"url": url, "data": data, "headers": headers})
            return {"access_token": f"TOK{len(self.calls)}", "expires_in": 7200}

        for target, kwargs in (
            ("_read_wechat_config", {"return_value": {"app_id": "wx_test", "app_secret": "sec"}}),
            ("_http_json", {"side_effect": fake_http_json}),
        ):
            p = patch.object(server, target, **kwargs)
            p.start()
            self.addCleanup(p.stop)

    def test_normal_mode_posts_to_stable_token(self):
        server.get_access_token()
        self.assertEqual(len(self.calls), 1)
        call = self.calls[0]
        self.assertTrue(call["url"].endswith("/stable_token"), call["url"])
        self.assertNotIn("/token?", call["url"])
        self.assertEqual(call["headers"]["Content-Type"], "application/json")
        body = json.loads(call["data"].decode())
        self.assertEqual(body["appid"], "wx_test")
        self.assertIs(body["force_refresh"], False)

    def test_cache_hit_skips_http(self):
        server.get_access_token()
        server.get_access_token()
        self.assertEqual(len(self.calls), 1)

    def test_force_refresh_sets_cooldown(self):
        server.get_access_token(force_refresh=True)
        self.assertIs(json.loads(self.calls[0]["data"].decode())["force_refresh"], True)
        self.assertGreater(server._last_force_refresh, 0.0)
        # 30s 冷却内再次强制刷新 -> 退化成普通模式，避免撞微信「间隔 ≥30s」限制
        server.get_access_token(force_refresh=True)
        self.assertIs(json.loads(self.calls[1]["data"].decode())["force_refresh"], False)

    def test_token_error_raises(self):
        with patch.object(server, "_http_json", return_value={"errcode": 40013}):
            with self.assertRaises(RuntimeError):
                server.get_access_token()


if __name__ == "__main__":
    unittest.main()
