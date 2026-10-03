import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { TFunction, TranslationKey } from "../../i18n";
import type { ShellPromptPreview } from "../../../shared/types";
import {
	DEFAULT_SHELL_PROMPT_STYLE,
	SHELL_PROMPT_CUSTOM,
	SHELL_PROMPT_OWN,
	SHELL_PROMPT_STYLES,
} from "../../../shared/shell-prompt-styles";
import { api } from "../../rpc";
import { useResolvedTheme } from "../../hooks/useResolvedTheme";
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from "../../terminal-themes";
import { terminalFontStack } from "../../terminal-font";

/** What a style can read, listed for whoever writes their own. Not localized: they are zsh names. */
const PROMPT_VARIABLES =
	"$dev3_task $dev3_project $dev3_path $dev3_where $dev3_branch $dev3_git $dev3_dirty $dev3_dur $dev3_segments $dev3_icon_branch $dev3_icon_clock $dev3_sep";

type Palette = typeof DARK_TERMINAL_THEME;

function ansiColors(p: Palette): string[] {
	return [
		p.black, p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan, p.white,
		p.brightBlack, p.brightRed, p.brightGreen, p.brightYellow, p.brightBlue, p.brightMagenta, p.brightCyan, p.brightWhite,
	];
}

/**
 * The solid powerline separators, drawn as shapes. As font glyphs they stand taller
 * than an HTML span's background, leaving a step at every segment edge — the
 * terminal fits them to the cell (`terminal-glyph-cell-fit.ts`), a preview cannot.
 */
const POWERLINE_SHAPES: Record<string, string> = {
	"\ue0b0": "polygon(0 0, 100% 50%, 0 100%)",
	"\ue0b2": "polygon(100% 0, 0 50%, 100% 100%)",
	"\ue0b8": "polygon(0 0, 100% 100%, 0 100%)",
	"\ue0ba": "polygon(100% 0, 100% 100%, 0 100%)",
	"\ue0bc": "polygon(0 0, 100% 0, 0 100%)",
	"\ue0be": "polygon(0 0, 100% 0, 100% 100%)",
};
const POWERLINE_SHAPE_RUN = /([\ue0b0\ue0b2\ue0b8\ue0ba\ue0bc\ue0be])/u;

/** SGR colours, bold and reverse video — all a zsh prompt emits. Anything else is dropped. */
function renderAnsiLine(line: string, palette: Palette): ReactNode[] {
	const colors = ansiColors(palette);
	const out: ReactNode[] = [];
	let fg: string | undefined;
	let bg: string | undefined;
	let bold = false;
	let inverse = false;
	let last = 0;
	const flush = (text: string) => {
		if (!text) return;
		const style: CSSProperties = inverse
			? { color: bg ?? palette.background, background: fg ?? palette.foreground }
			: { color: fg, background: bg };
		if (bold) style.fontWeight = 700;
		// Inline blocks fill the whole line box, so backgrounds meet the shapes edge to edge.
		Object.assign(style, { display: "inline-block", verticalAlign: "top" });
		for (const part of text.split(POWERLINE_SHAPE_RUN)) {
			if (!part) continue;
			const shape = POWERLINE_SHAPES[part];
			out.push(
				shape ? (
					<span key={out.length} data-powerline-shape="" style={{ ...style, width: "1ch", height: "1lh" }}>
						{/* Half a pixel past each side, so no antialiased seam opens against the segment it closes. */}
						<span style={{ display: "block", height: "100%", marginInline: "-0.5px", background: style.color ?? palette.foreground, clipPath: shape }} />
					</span>
				) : (
					<span key={out.length} style={style}>{part}</span>
				),
			);
		}
	};
	for (const m of line.matchAll(/\u001b\[([0-9;]*)m/g)) {
		flush(line.slice(last, m.index));
		last = (m.index ?? 0) + m[0].length;
		const codes = (m[1] || "0").split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i];
			if (c === 0) [fg, bg, bold, inverse] = [undefined, undefined, false, false];
			else if (c === 1) bold = true;
			else if (c === 7) inverse = true;
			else if (c === 27) inverse = false;
			else if (c === 22) bold = false;
			else if (c >= 30 && c <= 37) fg = colors[c - 30];
			else if (c >= 90 && c <= 97) fg = colors[c - 90 + 8];
			else if (c === 39) fg = undefined;
			else if (c >= 40 && c <= 47) bg = colors[c - 40];
			else if (c >= 100 && c <= 107) bg = colors[c - 100 + 8];
			else if (c === 49) bg = undefined;
			else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
				const color = colors[codes[i + 2]];
				if (c === 38) fg = color;
				else bg = color;
				i += 2;
			}
		}
	}
	flush(line.slice(last));
	return out;
}

const previewCache = new Map<string, Promise<ShellPromptPreview>>();

/** Previews never change within a session; tests start from an empty cache. */
export function clearShellPromptPreviewCache(): void {
	previewCache.clear();
}

function loadPreview(source: string): Promise<ShellPromptPreview> {
	let cached = previewCache.get(source);
	if (!cached) {
		cached = Promise.resolve()
			.then(() => api.request.previewShellPrompt({ source }))
			.catch(
			(): ShellPromptPreview => ({ ok: false, reason: "no-zsh" }),
		);
		previewCache.set(source, cached);
	}
	return cached;
}

function usePreview(source: string | null): ShellPromptPreview | null {
	const [preview, setPreview] = useState<ShellPromptPreview | null>(null);
	useEffect(() => {
		if (source === null) return;
		let live = true;
		setPreview(null);
		loadPreview(source).then((p) => live && setPreview(p));
		return () => {
			live = false;
		};
	}, [source]);
	return preview;
}

function PromptPreview({ t, source, failed }: { t: TFunction; source: string; failed?: boolean }) {
	const preview = usePreview(source);
	const theme = useResolvedTheme();
	const palette = theme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
	const raw = preview?.ok ? (failed ? preview.afterFailedCommand : preview.afterSlowCommand) : null;
	// A style's leading newline separates it from the previous command's output; alone in a preview it is just a gap.
	const lines = raw?.slice(raw.findIndex((line) => line.replace(/\u001b\[[0-9;]*m/g, "") !== ""));
	return (
		<span
			className="mt-1.5 block rounded-lg ring-1 ring-inset ring-edge/60 px-2.5 py-1.5 overflow-x-auto"
			// "normal" is the font's own line box — what a terminal cell uses, so box-drawing frames join up.
			style={{ background: palette.background, color: palette.foreground, fontFamily: terminalFontStack(), fontSize: 13, lineHeight: "normal" }}
		>
			{lines ? (
				lines.map((line, i) => (
					<span key={i} className="block whitespace-pre min-h-[1.2em]">
						{renderAnsiLine(line, palette)}
					</span>
				))
			) : (
				<span className="block whitespace-pre text-fg-muted">
					{preview && !preview.ok && preview.reason === "no-zsh" ? t("settings.shellPromptNoPreview") : " "}
				</span>
			)}
		</span>
	);
}

function SourceBlock({ source }: { source: string }) {
	return (
		<pre className="mt-2 rounded-lg bg-base ring-1 ring-inset ring-edge/60 px-2.5 py-1.5 text-micro font-mono text-fg-2 whitespace-pre-wrap break-all">
			{source}
		</pre>
	);
}

const ROW_CLASS = "w-full rounded-xl border px-3 py-2.5 text-left transition-colors";
const rowState = (selected: boolean) =>
	selected ? "border-accent bg-accent/10" : "border-edge bg-raised hover:border-edge-active";

/**
 * Every prompt style rendered by real zsh, plus "keep my own" and a custom editor.
 * Rows like the font gallery: a prompt is judged by its line, which a card would crop.
 */
export default function ShellPromptGallery({
	t,
	value,
	custom,
	shell,
	onSelect,
	onSaveCustom,
}: {
	t: TFunction;
	/** The stored choice; undefined means the default style. */
	value: string | undefined;
	custom: string | undefined;
	/** The shell dev3 actually runs, when known. */
	shell: string | null;
	onSelect: (choice: string) => void;
	onSaveCustom: (source: string) => void;
}) {
	const current = value ?? DEFAULT_SHELL_PROMPT_STYLE;
	const [draft, setDraft] = useState(custom ?? "");
	const [error, setError] = useState<string | null>(null);
	const [applied, setApplied] = useState(false);
	const [checking, setChecking] = useState(false);

	useEffect(() => setDraft(custom ?? ""), [custom]);

	const editCopy = (source: string) => {
		setDraft(source);
		setError(null);
		setApplied(false);
		onSelect(SHELL_PROMPT_CUSTOM);
	};

	const apply = async () => {
		setChecking(true);
		setApplied(false);
		const result = await api.request
			.previewShellPrompt({ source: draft })
			.catch((): ShellPromptPreview => ({ ok: false, reason: "no-zsh" }));
		setChecking(false);
		if (!result.ok && result.reason === "invalid") {
			setError(result.error);
			return;
		}
		setError(null);
		previewCache.set(draft, Promise.resolve(result));
		onSaveCustom(draft);
		setApplied(true);
	};

	const customSelected = current === SHELL_PROMPT_CUSTOM;
	return (
		<div>
			{shell && shell !== "zsh" && (
				<p className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-strong">
					{t("settings.shellPromptNotZsh", { shell })}
				</p>
			)}
			<div role="radiogroup" aria-label={t("settings.shellPromptGallery")} className="flex flex-col gap-2">
				{SHELL_PROMPT_STYLES.map((style) => {
					const selected = style.id === current;
					return (
						<div key={style.id} className={`${ROW_CLASS} ${rowState(selected)}`}>
							<button
								type="button"
								role="radio"
								aria-checked={selected}
								onClick={() => onSelect(style.id)}
								className="block w-full text-left"
							>
								<span className="flex items-baseline gap-2 flex-wrap">
									<span className={`text-sm font-semibold ${selected ? "text-accent" : "text-fg"}`}>
										{style.label}
									</span>
									<span className="text-fg-3 text-xs">
										{t(`settings.shellPromptStyle.${style.id}` as TranslationKey)}
									</span>
								</span>
								<PromptPreview t={t} source={style.source} />
								{selected && <PromptPreview t={t} source={style.source} failed />}
							</button>
							{selected && (
								<div className="mt-2">
									<SourceBlock source={style.source} />
									<button
										type="button"
										onClick={() => editCopy(style.source)}
										className="mt-2 text-sm text-fg-3 hover:text-accent px-3 py-1.5 rounded-lg ring-1 ring-inset ring-edge hover:ring-accent/30 active:scale-[0.96] transition-[color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)]"
									>
										{t("settings.shellPromptCustomize")}
									</button>
								</div>
							)}
						</div>
					);
				})}

				<div className={`${ROW_CLASS} ${rowState(customSelected)}`}>
					<button
						type="button"
						role="radio"
						aria-checked={customSelected}
						onClick={() => onSelect(SHELL_PROMPT_CUSTOM)}
						className="block w-full text-left"
					>
						<span className={`block text-sm font-semibold ${customSelected ? "text-accent" : "text-fg"}`}>
							{t("settings.shellPromptCustom")}
						</span>
						<span className="block text-fg-3 text-xs mt-0.5">{t("settings.shellPromptCustomDesc")}</span>
					</button>
					{customSelected && (
						<div className="mt-2">
							<textarea
								aria-label={t("settings.shellPromptCustom")}
								value={draft}
								onChange={(e) => {
									setDraft(e.target.value);
									setApplied(false);
								}}
								rows={4}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								className="w-full px-3 py-2 bg-base border border-edge rounded-lg text-fg text-xs font-mono outline-none focus:border-accent/40 transition-colors resize-y"
							/>
							<p className="mt-1 text-micro text-fg-muted">
								{t("settings.shellPromptVariables")}: <span className="font-mono">{PROMPT_VARIABLES}</span>
							</p>
							<div className="mt-2 flex items-center gap-3 flex-wrap">
								<button
									type="button"
									disabled={checking || !draft.trim() || (draft === custom && !error)}
									onClick={apply}
									className="px-3 py-1.5 rounded-lg bg-accent-fill text-white text-xs font-semibold hover:bg-accent-fill-hover disabled:opacity-50 enabled:active:scale-[0.96] transition-[background-color,opacity,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)]"
								>
									{t("settings.shellPromptApply")}
								</button>
								{applied && <span className="text-fg-3 text-xs">{t("settings.shellPromptApplied")}</span>}
							</div>
							{error && (
								<p role="alert" className="mt-2 text-danger text-xs font-mono">
									{t("settings.shellPromptInvalid", { error })}
								</p>
							)}
							{custom?.trim() && <PromptPreview t={t} source={custom} />}
						</div>
					)}
				</div>

				<button
					type="button"
					role="radio"
					aria-checked={current === SHELL_PROMPT_OWN}
					onClick={() => onSelect(SHELL_PROMPT_OWN)}
					className={`${ROW_CLASS} ${rowState(current === SHELL_PROMPT_OWN)}`}
				>
					<span className={`block text-sm font-semibold ${current === SHELL_PROMPT_OWN ? "text-accent" : "text-fg"}`}>
						{t("settings.shellPromptOwn")}
					</span>
					<span className="block text-fg-3 text-xs mt-0.5">{t("settings.shellPromptOwnDesc")}</span>
				</button>
			</div>
		</div>
	);
}
