import { useState, useEffect } from "react";
import { useT, useLocale, ALL_LOCALES, LOCALE_LABELS } from "../i18n";
import type { Locale } from "../i18n";
import type { CodingAgent } from "../../shared/types";
import { BUILTIN_AGENTS } from "../../shared/types";
import { api } from "../rpc";

type Theme = "dark" | "light";

function GlobalSettings() {
	const t = useT();
	const [locale, setLocale] = useLocale();

	const [theme, setTheme] = useState<Theme>(
		() => (localStorage.getItem("dev3-theme") as Theme) || "dark",
	);

	const [customAgents, setCustomAgents] = useState<CodingAgent[]>([]);
	const [addingAgent, setAddingAgent] = useState(false);
	const [newAgentName, setNewAgentName] = useState("");
	const [newAgentCommand, setNewAgentCommand] = useState("");

	useEffect(() => {
		api.request.getAgents().then((all) => {
			setCustomAgents(all.filter((a) => a.kind === "custom"));
		});
	}, []);

	function applyTheme(th: Theme) {
		setTheme(th);
		document.documentElement.dataset.theme = th;
		localStorage.setItem("dev3-theme", th);
	}

	async function handleAddAgent() {
		if (!newAgentName.trim() || !newAgentCommand.trim()) return;
		const agent: CodingAgent = {
			id: crypto.randomUUID(),
			kind: "custom",
			name: newAgentName.trim(),
			command: newAgentCommand.trim(),
		};
		const updated = [...customAgents, agent];
		setCustomAgents(updated);
		await api.request.saveAgents({ agents: [...BUILTIN_AGENTS, ...updated] });
		setNewAgentName("");
		setNewAgentCommand("");
		setAddingAgent(false);
	}

	async function handleDeleteAgent(agentId: string) {
		const updated = customAgents.filter((a) => a.id !== agentId);
		setCustomAgents(updated);
		await api.request.saveAgents({ agents: [...BUILTIN_AGENTS, ...updated] });
	}

	return (
		<div className="h-full w-full flex flex-col bg-base">
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-xl space-y-8">
					{/* Theme */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-3">
							{t("settings.theme")}
						</label>
						<div className="flex gap-3">
							<ThemeCard
								name={t("settings.themeDark")}
								description={t("settings.themeDarkDesc")}
								active={theme === "dark"}
								onClick={() => applyTheme("dark")}
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
								onClick={() => applyTheme("light")}
								preview={{
									bg: "#f5f6fa",
									raised: "#ffffff",
									text: "#1a1d2e",
									accent: "#5e9eff",
								}}
							/>
						</div>
					</div>

					{/* Coding Agents */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-3">
							{t("settings.agents")}
						</label>

						{/* Built-in agents */}
						<div className="text-fg-3 text-xs font-semibold uppercase tracking-wide mb-2">
							{t("settings.builtinAgents")}
						</div>
						<div className="space-y-2 mb-4">
							{BUILTIN_AGENTS.map((agent) => (
								<div
									key={agent.id}
									className="flex items-center gap-3 px-4 py-3 bg-raised border border-edge rounded-xl"
								>
									<span className="text-fg text-sm font-medium flex-1">
										{agent.name}
									</span>
									<span className="text-fg-muted text-xs px-2 py-0.5 bg-elevated rounded-md">
										{t("settings.builtinBadge")}
									</span>
								</div>
							))}
						</div>

						{/* Custom agents */}
						<div className="text-fg-3 text-xs font-semibold uppercase tracking-wide mb-2">
							{t("settings.customAgents")}
						</div>
						{customAgents.length === 0 && !addingAgent && (
							<p className="text-fg-muted text-sm mb-3">
								{t("settings.noCustomAgents")}
							</p>
						)}
						<div className="space-y-2 mb-3">
							{customAgents.map((agent) => (
								<div
									key={agent.id}
									className="flex items-center gap-3 px-4 py-3 bg-raised border border-edge rounded-xl"
								>
									<div className="flex-1 min-w-0">
										<div className="text-fg text-sm font-medium">
											{agent.name}
										</div>
										<div className="text-fg-3 text-xs font-mono truncate">
											{agent.command}
										</div>
									</div>
									<button
										onClick={() => handleDeleteAgent(agent.id)}
										className="text-danger text-xs hover:underline shrink-0"
									>
										{t("settings.deleteAgent")}
									</button>
								</div>
							))}
						</div>

						{addingAgent ? (
							<div className="space-y-3 p-4 bg-raised border border-edge rounded-xl">
								<div>
									<label className="block text-fg-2 text-xs mb-1">
										{t("settings.customAgentName")}
									</label>
									<input
										type="text"
										value={newAgentName}
										onChange={(e) => setNewAgentName(e.target.value)}
										placeholder="My Agent"
										className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
										autoFocus
									/>
								</div>
								<div>
									<label className="block text-fg-2 text-xs mb-1">
										{t("settings.customAgentCommand")}
									</label>
									<input
										type="text"
										value={newAgentCommand}
										onChange={(e) => setNewAgentCommand(e.target.value)}
										placeholder="my-agent --prompt $DEV3_TASK_TITLE"
										className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
									/>
									<p className="text-fg-muted text-xs mt-1.5">
										{t("settings.customAgentCommandHint")}
									</p>
								</div>
								<div className="flex gap-2">
									<button
										onClick={handleAddAgent}
										disabled={
											!newAgentName.trim() || !newAgentCommand.trim()
										}
										className="px-4 py-1.5 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-all"
									>
										{t("kanban.add")}
									</button>
									<button
										onClick={() => {
											setAddingAgent(false);
											setNewAgentName("");
											setNewAgentCommand("");
										}}
										className="px-4 py-1.5 text-fg-3 text-sm hover:text-fg transition-colors"
									>
										{t("kanban.cancel")}
									</button>
								</div>
							</div>
						) : (
							<button
								onClick={() => setAddingAgent(true)}
								className="px-4 py-2 text-accent text-sm font-semibold hover:bg-accent/10 rounded-lg transition-colors"
							>
								+ {t("settings.addCustomAgent")}
							</button>
						)}
					</div>

					{/* Language */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-3">
							{t("settings.language")}
						</label>
						<div className="flex gap-3">
							{ALL_LOCALES.map((loc) => (
								<LanguageCard
									key={loc}
									locale={loc}
									label={LOCALE_LABELS[loc]}
									active={locale === loc}
									onClick={() => setLocale(loc)}
								/>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
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
			className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
				active
					? "border-accent shadow-lg shadow-accent/10"
					: "border-edge hover:border-edge-active"
			}`}
		>
			{/* Mini preview */}
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
			className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
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

export default GlobalSettings;
