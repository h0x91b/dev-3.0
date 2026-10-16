import { useState, useEffect } from "react";
import type { DevServerConfig } from "../../../shared/types";
import { DEV_SERVER_NAME_PATTERN } from "../../../shared/dev-servers";
import { parseEnvText, serializeEnvText } from "../../../shared/env-text";
import { useT } from "../../i18n";
import { AddRowButton, Field } from "./fields";

// ---- Dev servers editor (devScript + the named `devServers` map) ----

/**
 * A server's name, committed when the field is left rather than on every
 * keystroke. The name IS the key of the `devServers` map, so renaming per
 * keystroke would rewrite the map (and remount this input) between characters.
 */
function DevServerNameInput({ name, disabled, onCommit }: {
	name: string;
	disabled: boolean;
	onCommit: (next: string) => void;
}) {
	const t = useT();
	const [draft, setDraft] = useState(name);
	useEffect(() => { setDraft(name); }, [name]);
	const invalid = draft !== "" && !DEV_SERVER_NAME_PATTERN.test(draft);
	return (
		<input
			value={draft}
			disabled={disabled}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => { if (draft && draft !== name && !invalid) onCommit(draft); else setDraft(name); }}
			onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
			aria-label={t("projectSettings.devServerName")}
			className={`w-40 px-2.5 py-1.5 bg-base border rounded-lg text-fg text-sm font-mono outline-none focus:border-accent/40 disabled:text-fg-3 ${invalid ? "border-danger" : "border-edge"}`}
		/>
	);
}

/**
 * A server's named ports, as free text. Committed on blur like the name: the
 * list round-trips through `join(", ")`, so parsing per keystroke eats the
 * separator the user is in the middle of typing.
 */
function DevServerPortsInput({ ports, onCommit }: { ports: string[]; onCommit: (next: string[]) => void }) {
	const t = useT();
	const text = ports.join(", ");
	const [draft, setDraft] = useState(text);
	useEffect(() => { setDraft(text); }, [text]);
	return (
		<input
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => onCommit(draft.split(/[\s,]+/).filter(Boolean))}
			onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
			placeholder={t("projectSettings.devServerPortsPlaceholder")}
			aria-label={t("projectSettings.devServerPorts")}
			className="flex-1 min-w-0 px-2.5 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40"
		/>
	);
}

/**
 * One row per dev server. The first row is the project's `devScript` under its
 * fixed name `dev`; every other row is an entry of `devServers`. Two storage
 * shapes, one list — the user never has to know which field a server lives in,
 * and nothing is migrated between them.
 */
export function DevServersEditor({ devScript, devServers, placeholder, onChange }: {
	devScript: string | undefined;
	devServers: Record<string, DevServerConfig> | undefined;
	placeholder: string;
	onChange: (patch: { devScript?: string; devServers?: Record<string, DevServerConfig> }) => void;
}) {
	const t = useT();
	const [expanded, setExpanded] = useState<string | null>(null);
	const named = devServers ?? {};
	const entries = Object.entries(named);

	function patchServer(name: string, patch: Partial<DevServerConfig>) {
		const current: DevServerConfig = named[name] ?? { script: "" };
		onChange({ devServers: { ...named, [name]: { ...current, ...patch } } });
	}

	function renameServer(from: string, to: string) {
		const next: Record<string, DevServerConfig> = {};
		for (const [key, value] of entries) next[key === from ? to : key] = value;
		onChange({ devServers: next });
	}

	function removeServer(name: string) {
		const next = { ...named };
		delete next[name];
		onChange({ devServers: next });
	}

	function addServer() {
		let name = "server";
		for (let i = 2; named[name]; i++) name = `server${i}`;
		onChange({ devServers: { ...named, [name]: { script: "" } } });
		setExpanded(name);
	}

	function row(name: string, server: DevServerConfig, isDefault: boolean) {
		return (
			<div key={isDefault ? "__dev" : name} data-testid={`dev-server-row-${name}`} className="rounded-xl border border-edge bg-raised p-3 space-y-2">
				<div className="flex items-center gap-2">
					<DevServerNameInput
						name={name}
						disabled={isDefault}
						onCommit={(next) => renameServer(name, next)}
					/>
					{isDefault && !devServers?.[name]
						// `devScript` has no place to keep a port list, so the default
						// server declares none until it moves into `devServers`.
						? <span className="flex-1 min-w-0 text-fg-muted text-xs">{t("projectSettings.devServerPortsPlaceholder")}</span>
						: <DevServerPortsInput ports={server.ports ?? []} onCommit={(ports) => patchServer(name, { ports })} />}
					{/* `devScript` is a bare string with nowhere to keep a label, a cwd or
					    an env, so the default row has no advanced half to open. */}
					{!isDefault && (
						<button
							type="button"
							onClick={() => setExpanded(expanded === name ? null : name)}
							className="px-2 py-1.5 rounded-lg text-sm text-fg-3 hover:text-fg hover:bg-elevated-hover"
						>
							{t("projectSettings.devServerAdvanced")}
						</button>
					)}
					{!isDefault && (
						<button
							type="button"
							onClick={() => removeServer(name)}
							aria-label={t("projectSettings.devServerRemove")}
							className="px-2 py-1.5 rounded-lg text-sm text-danger hover:bg-danger/10"
						>
							&#10005;
						</button>
					)}
				</div>
				<textarea
					value={isDefault ? devScript ?? "" : server.script}
					onChange={(e) => isDefault ? onChange({ devScript: e.target.value }) : patchServer(name, { script: e.target.value })}
					rows={isDefault ? 4 : 2}
					placeholder={isDefault ? placeholder : "bun run api"}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-label={t("projectSettings.devServerScript", { name })}
					className="w-full px-3 py-2 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
				{expanded === name && !isDefault && (
					<div className="space-y-2 border-t border-edge pt-2">
						<input
							value={server.title ?? ""}
							onChange={(e) => patchServer(name, { title: e.target.value })}
							placeholder={t("projectSettings.devServerTitle")}
							aria-label={t("projectSettings.devServerTitle")}
							className="w-full px-2.5 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40"
						/>
						<input
							value={server.cwd ?? ""}
							onChange={(e) => patchServer(name, { cwd: e.target.value })}
							placeholder={t("projectSettings.devServerCwd")}
							aria-label={t("projectSettings.devServerCwd")}
							className="w-full px-2.5 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40"
						/>
						<textarea
							value={serializeEnvText(server.env ?? {})}
							onChange={(e) => patchServer(name, { env: parseEnvText(e.target.value).env })}
							rows={2}
							placeholder="API_TOKEN=..."
							aria-label={t("projectSettings.devServerEnv")}
							className="w-full px-3 py-2 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 resize-y"
						/>
					</div>
				)}
			</div>
		);
	}

	return (
		<Field title={t("projectSettings.devServers")} description={t("projectSettings.devServersDesc")}>
			<div className="space-y-2" data-testid="dev-servers-editor">
				{row("dev", named.dev ?? { script: devScript ?? "" }, true)}
				{entries.filter(([name]) => name !== "dev").map(([name, server]) => row(name, server, false))}
			</div>
			<AddRowButton onClick={addServer}>{t("projectSettings.devServerAdd")}</AddRowButton>
		</Field>
	);
}
