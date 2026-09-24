import type { RinApp } from "./app-types";
import { PasswordAuthService } from "../services/auth";
import { CommentService } from "../services/comments";
import { ConfigService } from "../services/config";
import { FaviconService } from "../services/favicon";
import { FeedService, SearchService, WordPressService } from "../services/feed";
import { FriendService } from "../services/friends";
import { MomentsService } from "../services/moments";
import { RSSService } from "../services/rss";
import { SitemapService } from "../services/sitemap";
import { BlobService, StorageService } from "../services/storage";
import { AdminStoryService, StoryService } from "../services/story";
import { AdminMediaService, StreamWebhookService } from "../services/media";
import { MediaCenterService } from "../features/media-center/media-routes";
import { SeriesService } from "../features/media-center/series-routes";
import { EventsService } from "../features/media-center/events-routes";
import { AIStudioService } from "../features/ai-studio/routes";
import { AskService } from "../features/ai-studio/ask-routes";
import { TagService } from "../services/tag";
import { UserService } from "../services/user";
import { AnalyticsService } from "../services/analytics";
import { SharingReportService } from "../services/sharing-reports";

export function registerRoutes(app: RinApp) {
  app.get("/", (c) => c.text("Hi"));

  app.route("/feed", FeedService());
  app.route("/story", StoryService());
  app.route("/admin/stories", AdminStoryService());
  app.route("/admin/media", AdminMediaService());
  app.route("/webhooks", StreamWebhookService());
  app.route("/search", SearchService());
  app.route("/media", MediaCenterService());
  app.route("/series", SeriesService());
  app.route("/events", EventsService());
  app.route("/admin/ai-studio", AIStudioService());
  app.route("/ask", AskService());
  app.route("/wp", WordPressService());
  app.route("/tag", TagService());
  app.route("/comment", CommentService());
  app.route("/storage", StorageService());
  app.route("/blob", BlobService());
  app.route("/friend", FriendService());
  app.route("/moments", MomentsService());
  // GET /analytics/overview | /analytics/top-feeds | /analytics/dimensions |
  //     /analytics/live | /analytics/visits（全部 adminOnly）
  app.route("/analytics", AnalyticsService());
  // GET /reports/published | GET /reports/published/:slug（公开）
  // GET/POST /reports | GET/PATCH /reports/:id | POST /reports/:id/snapshot |
  // POST/PATCH /reports/transactions/:id（adminOnly）
  app.route("/reports", SharingReportService());
  app.route("/user", UserService());
  app.route("/auth", PasswordAuthService());
  app.route("/config", ConfigService());
  app.route("/", RSSService());
  app.route("/", SitemapService());
  app.route("/favicon", FaviconService());
  app.route("/favicon.ico", FaviconService());
}
