import type { RinApp } from "./app-types";
import { AnalyticsService } from "../services/analytics";
import { PasswordAuthService } from "../services/auth";
import { CommentService } from "../services/comments";
import { ConfigService } from "../services/config";
import { FaviconService } from "../services/favicon";
import { FeedService, SearchService, WordPressService } from "../services/feed";
import { FriendService } from "../services/friends";
import { MomentsService } from "../services/moments";
import { MediaService } from "../services/media";
import { RSSService } from "../services/rss";
import { SharingReportService } from "../services/sharing-reports";
import { SitemapService } from "../services/sitemap";
import { BlobService, StorageService } from "../services/storage";
import { TagService } from "../services/tag";
import { UserService } from "../services/user";

export function registerRoutes(app: RinApp) {
  app.get("/", (c) => c.text("Hi"));

  app.route("/analytics", AnalyticsService());
  app.route("/reports", SharingReportService());
  app.route("/feed", FeedService());
  app.route("/search", SearchService());
  app.route("/wp", WordPressService());
  app.route("/tag", TagService());
  app.route("/comment", CommentService());
  app.route("/storage", StorageService());
  app.route("/blob", BlobService());
  app.route("/friend", FriendService());
  app.route("/moments", MomentsService());
  app.route("/media", MediaService());
  app.route("/user", UserService());
  app.route("/auth", PasswordAuthService());
  app.route("/config", ConfigService());
  app.route("/", RSSService());
  app.route("/", SitemapService());
  app.route("/favicon", FaviconService());
  app.route("/favicon.ico", FaviconService());
}
