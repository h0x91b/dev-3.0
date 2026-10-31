import { useState, useEffect, useRef } from "react";
import { hasEnvLineBreak, parseEnvText, serializeEnvText } from "../../../shared/env-text";
import { useT } from "../../i18n";

// ---- Env vars editor (dotenv-style textarea backed by config.env) ----

/** `defaults` is the global Default agent environment, edited under Settings -> Agents. */
export type EnvStorageScope = "project" | "repo" | "local" | "defaults";

const NOTICE_KEYS = {
	project: "projectSettings.envVarsProjectNotice",
	local: "projectSettings.envVarsLocalNotice",
	defaults: "settings.agentEnvDefaultsNotice",
} as const;

function envWithoutLineBreaks(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter(([, value]) => !hasEnvLineBreak(value)));
}

export function EnvVarsEditor({ env, storageScope, onChange, onErrorChange }: {
	env: Record<string, string> | undefined;
	storageScope: EnvStorageScope;
	onChange: (env: Record<string, string> | undefined) => void;
	onErrorChange?: (hasError: boolean) => void;
}) {
	const t = useT();
	const lineBreakEntries = Object.entries(env ?? {}).filter(([, value]) => hasEnvLineBreak(value));
	const [text, setText] = useState(() => serializeEnvText(envWithoutLineBreaks(env ?? {})));
	const [errorLines, setErrorLines] = useState<number[]>([]);
	// Tracks the env value this editor last emitted (or was initialized from);
	// an external change (tab switch, async config load) reinitializes the text.
	const emittedRef = useRef(JSON.stringify(env ?? {}));

	useEffect(() => {
		const incoming = JSON.stringify(env ?? {});
		if (incoming !== emittedRef.current) {
			emittedRef.current = incoming;
			setText(serializeEnvText(envWithoutLineBreaks(env ?? {})));
			setErrorLines([]);
		}
	}, [env]); // eslint-disable-line react-hooks/exhaustive-deps

	// The cleanup clears the parent's gate on unmount (config-layer switch): child
	// effects run before parent ones, so a parent-side reset would overwrite the
	// value this editor just reported for the layer it mounted with.
	useEffect(() => {
		onErrorChange?.(errorLines.length > 0 || lineBreakEntries.length > 0);
		return () => onErrorChange?.(false);
	}, [errorLines.length, lineBreakEntries.length, onErrorChange]);

	function handleChange(next: string) {
		setText(next);
		const { env: parsed, errors } = parseEnvText(next);
		setErrorLines(errors.map((e) => e.line));
		if (errors.length === 0) {
			// Always emit an object (never undefined): the save handlers skip
			// undefined params, which would make a cleared env impossible to persist.
			const preserved = Object.fromEntries(lineBreakEntries);
			const updated = { ...preserved, ...parsed };
			emittedRef.current = JSON.stringify(updated);
			onChange(updated);
		}
	}

	function removeLineBreakEntry(key: string) {
		const updated = { ...(env ?? {}) };
		delete updated[key];
		emittedRef.current = JSON.stringify(updated);
		onChange(updated);
	}

	return (
		<div>
			{storageScope !== "defaults" && (
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.envVars")}
				</p>
			)}
			<p className="text-fg-3 text-sm mb-3">
				{t(storageScope === "defaults" ? "settings.agentEnvDefaultsDesc" : "projectSettings.envVarsDesc")}
			</p>
			{storageScope === "repo" ? (
				<div role="note" className="mb-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-danger-strong">
					<span aria-hidden="true" className="shrink-0 text-sm leading-5">&#9888;</span>
					<p className="text-xs leading-5">{t("projectSettings.envVarsRepoWarning")}</p>
				</div>
			) : (
				<p className="mb-3 text-xs leading-5 text-fg-3">
					{t(NOTICE_KEYS[storageScope])}
				</p>
			)}
			<textarea
				value={text}
				onChange={(e) => handleChange(e.target.value)}
				rows={4}
				placeholder={t(storageScope === "defaults" ? "settings.agentEnvDefaultsPlaceholder" : "projectSettings.envVarsPlaceholder")}
				aria-label={t(storageScope === "defaults" ? "settings.agentEnvDefaults" : "projectSettings.envVars")}
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				className={`w-full px-4 py-3 bg-raised border rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none transition-colors resize-y ${
					errorLines.length > 0 ? "border-danger/60 focus:border-danger" : "border-edge focus:border-accent/40"
				}`}
			/>
			{lineBreakEntries.length > 0 && (
				<div role="note" className="mt-2 rounded-lg border border-edge bg-elevated/50 px-3 py-2.5">
					<p className="text-xs font-medium text-fg-2">
						{t("projectSettings.envVarsLineBreakTitle")}
					</p>
					<p className="mt-1 text-xs leading-5 text-fg-3">
						{t("projectSettings.envVarsLineBreakDesc")}
					</p>
					<div className="mt-2 divide-y divide-edge/60">
						{lineBreakEntries.map(([key]) => (
							<div key={key} className="flex min-w-0 items-center justify-between gap-3 py-1.5">
								<code className="min-w-0 break-all text-xs text-fg-2">{key}</code>
								<button
									type="button"
									onClick={() => removeLineBreakEntry(key)}
									aria-label={t("projectSettings.envVarsRemoveLineBreakAria", { key })}
									className="shrink-0 rounded px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
								>
									{t("projectSettings.envVarsRemoveLineBreak")}
								</button>
							</div>
						))}
					</div>
				</div>
			)}
			{errorLines.length > 0 && (
				<p className="text-danger text-sm mt-2">
					{t("projectSettings.envVarsInvalidLines", { lines: errorLines.join(", ") })}
				</p>
			)}
		</div>
	);
}
