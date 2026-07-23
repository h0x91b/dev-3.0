import type { Locale } from "../../i18n";
import {
	ALL_LOCALES,
	LOCALE_LABELS,
	type TFunction,
} from "../../i18n";
import {
	adjustZoom,
	applyZoom,
	DEFAULT_ZOOM,
	MAX_ZOOM,
	MIN_ZOOM,
	ZOOM_STEP,
} from "../../zoom";
import SettingsSection from "./SettingsSection";
import SettingsEntry from "./SettingsEntry";
import SettingsToggle from "./SettingsToggle";
import HelpSpot from "../HelpSpot";
import { setStreamerMode, useStreamerMode } from "../../streamer-mode";
import type { Theme } from "./utils";

interface AppearanceSettingsSectionProps {
	t: TFunction;
	locale: Locale;
	theme: Theme;
	zoomLevel: number;
	onThemeChange: (theme: Theme) => void;
	onLocaleChange: (locale: Locale) => void;
}

export default function AppearanceSettingsSection({
	t,
	locale,
	theme,
	zoomLevel,
	onThemeChange,
	onLocaleChange,
}: AppearanceSettingsSectionProps) {
	const streamerMode = useStreamerMode();
	return (
		<SettingsSection title={t("settings.categoryAppearance")} helpTopicId="settings.appearance">
			<SettingsEntry anchor="theme">
				<div>
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("settings.theme")}
					</label>
					<p className="text-fg-3 text-sm mb-3">{t("settings.themeDesc")}</p>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
					<ThemeCard
						name={t("settings.themeDark")}
						description={t("settings.themeDarkDesc")}
						active={theme === "dark"}
						onClick={() => onThemeChange("dark")}
						preview={{
							bg: "#171924",
							raised: "#1e2133",
							text: "#eceef8",
							accent: "#5e9eff",
						}}
					/>
					<ThemeCard
						name={t("settings.themeLight")}
						description={t("settings.themeLightDesc")}
						active={theme === "light"}
						onClick={() => onThemeChange("light")}
						preview={{
							bg: "#f5f6fa",
							raised: "#ffffff",
							text: "#1a1d2e",
							accent: "#5e9eff",
						}}
					/>
					<ThemeCard
						name={t("settings.themeSystem")}
						description={t("settings.themeSystemDesc")}
						active={theme === "system"}
						onClick={() => onThemeChange("system")}
						preview={{
							bg: "linear-gradient(135deg, #171924 50%, #f5f6fa 50%)",
							raised: "#1e2133",
							text: "#eceef8",
							accent: "#5e9eff",
						}}
					/>
				</div>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="language">
				<div>
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("settings.language")}
					</label>
					<p className="text-fg-3 text-sm mb-3">{t("settings.languageDesc")}</p>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
					{ALL_LOCALES.map((loc) => (
						<LanguageCard
							key={loc}
							locale={loc}
							label={LOCALE_LABELS[loc]}
							active={locale === loc}
							onClick={() => onLocaleChange(loc)}
						/>
					))}
				</div>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="zoom">
				<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.zoom")}
				</label>
				<p className="text-fg-3 text-sm mb-3">{t("settings.zoomDesc")}</p>
				<div className="flex items-center gap-3">
					<button
						onClick={() => adjustZoom(-ZOOM_STEP)}
						disabled={zoomLevel <= MIN_ZOOM}
						className="w-10 h-10 flex items-center justify-center rounded-lg bg-raised border border-edge text-fg text-lg font-bold hover:border-edge-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
					>
						−
					</button>
					<div className="flex-1 text-center">
						<span className="text-fg text-lg font-semibold tabular-nums">
							{Math.round(zoomLevel * 100)}%
						</span>
					</div>
					<button
						onClick={() => adjustZoom(ZOOM_STEP)}
						disabled={zoomLevel >= MAX_ZOOM}
						className="w-10 h-10 flex items-center justify-center rounded-lg bg-raised border border-edge text-fg text-lg font-bold hover:border-edge-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
					>
						+
					</button>
					<button
						onClick={() => applyZoom(DEFAULT_ZOOM)}
						disabled={zoomLevel === DEFAULT_ZOOM}
						className="px-3 h-10 rounded-lg bg-raised border border-edge text-fg-2 text-sm hover:border-edge-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
					>
						{t("settings.zoomReset")}
					</button>
				</div>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="streamer-mode">
				<div data-help-id="field.streamer-mode">
					<label className="flex items-center gap-1.5 text-fg text-sm font-semibold mb-2">
						{t("settings.streamerMode")}
						<HelpSpot topicId="field.streamer-mode" />
					</label>
					<p className="text-fg-3 text-sm mb-3">{t("settings.streamerModeDesc")}</p>
					<SettingsToggle
						checked={streamerMode}
						ariaLabel={t("settings.streamerMode")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => setStreamerMode(!streamerMode)}
					/>
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}

function ThemeCard({
	name,
	description,
	active,
	onClick,
	preview,
}: {
	name: string;
	description: string;
	active: boolean;
	onClick: () => void;
	preview: { bg: string; raised: string; text: string; accent: string };
}) {
	return (
		<button
			onClick={onClick}
			className={`min-w-0 p-4 rounded-xl border-2 transition-all text-left ${
				active
					? "border-accent shadow-lg shadow-accent/10"
					: "border-edge hover:border-edge-active"
			}`}
		>
			<div
				className="w-full h-20 rounded-lg mb-3 p-3 flex flex-col justify-between"
				style={{ background: preview.bg }}
			>
				<div className="flex items-center gap-2">
					<div
						className="w-2 h-2 rounded-full"
						style={{ background: preview.accent }}
					/>
					<div
						className="h-1.5 w-12 rounded-full opacity-60"
						style={{ background: preview.text }}
					/>
				</div>
				<div className="flex gap-1.5">
					<div
						className="h-6 flex-1 rounded"
						style={{ background: preview.raised }}
					/>
					<div
						className="h-6 flex-1 rounded"
						style={{ background: preview.raised }}
					/>
				</div>
			</div>

			<div className="text-fg text-sm font-semibold">{name}</div>
			<div className="text-fg-3 text-xs mt-0.5">{description}</div>
		</button>
	);
}

function LanguageCard({
	locale,
	label,
	active,
	onClick,
}: {
	locale: Locale;
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	const flags: Record<Locale, string> = {
		en: "EN",
		ru: "RU",
		es: "ES",
	};

	return (
		<button
			onClick={onClick}
			className={`min-w-0 p-4 rounded-xl border-2 transition-all text-left ${
				active
					? "border-accent shadow-lg shadow-accent/10"
					: "border-edge hover:border-edge-active"
			}`}
		>
			<div className="text-2xl mb-2 font-mono text-fg-2 font-bold">
				{flags[locale]}
			</div>
			<div className="text-fg text-sm font-semibold">{label}</div>
		</button>
	);
}
