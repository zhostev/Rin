import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants";
import { AIComposePanel } from "./writing-ai-compose";

// AI 写作（独立成页）：选题 / 截图 → AI 生成 → 直接发布。
// 人工编辑能力已下线：不再提供手写 markdown 编辑器与手动发布流程。
export function WritingPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();

  return (
    <>
      <Helmet>
        <title>{`${t("ai_compose.title")} - ${siteConfig.name}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={t("ai_compose.title")} />
        <meta property="og:image" content={siteConfig.avatar} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={document.URL} />
      </Helmet>
      <div className="mt-2 flex flex-col gap-4 t-primary sm:gap-6">
        <AIComposePanel />
      </div>
    </>
  );
}
