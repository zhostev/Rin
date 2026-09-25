import { SettingsBadge, SettingsCard, SettingsCardBody, SettingsCardHeader, SettingsCardRow } from "@rin/ui";
import * as Switch from "@radix-ui/react-switch";
import { useTranslation } from "react-i18next";
import { ItemTitle } from "./settings-items";

export type AIWriterSettingsValue = {
  enabled: boolean;
  provider: string;
  model: string;
  apiKey: string;
  apiKeySet: boolean;
  apiUrl: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  pexelsApiKey: string;
  pexelsApiKeySet: boolean;
};

const TEXT_INPUT_CLASS =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-3 text-sm t-primary outline-none transition-colors placeholder:text-neutral-400 focus:border-black/20 focus:ring-2 focus:ring-theme/10 dark:border-white/10 dark:placeholder:text-neutral-500 dark:focus:border-white/20";

export function AIWriterSettings({
  value,
  onChange,
}: {
  value: AIWriterSettingsValue;
  onChange: (updates: Partial<AIWriterSettingsValue>) => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <ItemTitle title={t("settings.ai_writer.title")} />
      <SettingsCard>
        <SettingsCardRow
          header={<SettingsCardHeader title={t("settings.ai_writer.enable.title")} description={t("settings.ai_writer.enable.desc")} />}
          action={
            <Switch.Root
              className="SwitchRoot"
              checked={value.enabled}
              onCheckedChange={(checked) => {
                onChange({ enabled: checked });
              }}
            >
              <Switch.Thumb className="SwitchThumb" />
            </Switch.Root>
          }
        />
      </SettingsCard>

      {value.enabled && (
        <SettingsCard>
          <SettingsCardRow
            header={
              <SettingsCardHeader
                title={t("settings.ai_writer.provider.title")}
                description={t("settings.ai_writer.inherit_hint")}
              />
            }
            action={
              <input
                type="text"
                value={value.provider}
                onChange={(event) => {
                  onChange({ provider: event.target.value });
                }}
                placeholder={t("settings.ai_writer.provider.desc")}
                className={TEXT_INPUT_CLASS}
              />
            }
          />
          <SettingsCardBody>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="text-sm font-medium t-primary">{t("settings.ai_writer.model.title")}</p>
                <input
                  type="text"
                  value={value.model}
                  onChange={(event) => {
                    onChange({ model: event.target.value });
                  }}
                  placeholder={t("settings.ai_writer.model.desc")}
                  className={TEXT_INPUT_CLASS}
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium t-primary">
                  {t("settings.ai_writer.api_key.title")}
                  {value.apiKeySet && (
                    <span className="ml-2">
                      <SettingsBadge tone="success">{t("settings.ai_writer.api_key.set")}</SettingsBadge>
                    </span>
                  )}
                </p>
                <input
                  type="password"
                  name="rin-ai-writer-api-key"
                  autoComplete="new-password"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={value.apiKey}
                  onChange={(event) => {
                    onChange({ apiKey: event.target.value });
                  }}
                  placeholder={value.apiKeySet ? t("settings.ai_writer.api_key.placeholder_set") : t("settings.ai_writer.api_key.desc")}
                  className={TEXT_INPUT_CLASS}
                />
              </div>
              <div className="space-y-2 lg:col-span-2">
                <p className="text-sm font-medium t-primary">{t("settings.ai_writer.api_url.title")}</p>
                <input
                  type="text"
                  value={value.apiUrl}
                  onChange={(event) => {
                    onChange({ apiUrl: event.target.value });
                  }}
                  placeholder={t("settings.ai_writer.api_url.desc")}
                  className={TEXT_INPUT_CLASS}
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium t-primary">{t("settings.ai_writer.temperature.title")}</p>
                <input
                  type="number"
                  step="0.1"
                  value={value.temperature}
                  onChange={(event) => {
                    onChange({ temperature: Number(event.target.value) });
                  }}
                  className={TEXT_INPUT_CLASS}
                />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("settings.ai_writer.temperature.desc")}</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium t-primary">{t("settings.ai_writer.max_tokens.title")}</p>
                <input
                  type="number"
                  step="1"
                  value={value.maxTokens}
                  onChange={(event) => {
                    onChange({ maxTokens: Number(event.target.value) });
                  }}
                  className={TEXT_INPUT_CLASS}
                />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("settings.ai_writer.max_tokens.desc")}</p>
              </div>
              <div className="space-y-2 lg:col-span-2">
                <p className="text-sm font-medium t-primary">
                  {t("settings.ai_writer.pexels_api_key.title")}
                  {value.pexelsApiKeySet && (
                    <span className="ml-2">
                      <SettingsBadge tone="success">{t("settings.ai_writer.pexels_api_key.set")}</SettingsBadge>
                    </span>
                  )}
                </p>
                <input
                  type="password"
                  name="rin-ai-writer-pexels-api-key"
                  autoComplete="new-password"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={value.pexelsApiKey}
                  onChange={(event) => {
                    onChange({ pexelsApiKey: event.target.value });
                  }}
                  placeholder={value.pexelsApiKeySet ? t("settings.ai_writer.pexels_api_key.placeholder_set") : t("settings.ai_writer.pexels_api_key.desc")}
                  className={TEXT_INPUT_CLASS}
                />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("settings.ai_writer.pexels_api_key.hint")}</p>
              </div>
              <div className="space-y-2 lg:col-span-2">
                <p className="text-sm font-medium t-primary">{t("settings.ai_writer.system_prompt.title")}</p>
                <textarea
                  value={value.systemPrompt}
                  onChange={(event) => {
                    onChange({ systemPrompt: event.target.value });
                  }}
                  placeholder={t("settings.ai_writer.system_prompt.desc")}
                  rows={4}
                  className={TEXT_INPUT_CLASS}
                />
              </div>
            </div>
          </SettingsCardBody>
        </SettingsCard>
      )}
    </>
  );
}
