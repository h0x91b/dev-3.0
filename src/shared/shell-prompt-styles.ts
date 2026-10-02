/**
 * Prompt styles a user can pick for dev3 shell panes (Settings → Terminal).
 * Each source is plain zsh, evaluated after dev3's prompt engine has filled
 * the `dev3_*` variables (see `ZSH_PROMPT_ENGINE` in `src/bun/shell-init.ts`),
 * so a style is one or two `PROMPT=` lines a user can copy and tweak.
 */

export interface ShellPromptStyle {
	/** Stored in `GlobalSettings.shellPrompt`. */
	id: string;
	/** A style's name, deliberately not localized — like a font name. */
	label: string;
	source: string;
}

/** dev3 leaves the prompt from the user's own `~/.zshrc` alone. */
export const SHELL_PROMPT_OWN = "own";
/** The user's own zsh code, stored in `GlobalSettings.shellPromptCustom`. */
export const SHELL_PROMPT_CUSTOM = "custom";
export const DEFAULT_SHELL_PROMPT_STYLE = "dev3";

export const SHELL_PROMPT_STYLES: readonly ShellPromptStyle[] = [
	{ id: "dev3", label: "dev3", source: "PROMPT=$'%F{8}┌─${dev3_segments}\\n%F{8}└─%(?.%F{magenta}.%F{red})▶%f '" },
	{ id: "powerline", label: "Powerline", source: "PROMPT='${dev3_segments} %(?.%F{magenta}.%F{red})❯%f '" },
	{ id: "minimal", label: "Minimal", source: "PROMPT='%(?.%F{magenta}.%F{red})❯%f '" },
	{ id: "classic", label: "Classic", source: "PROMPT='%F{blue}${dev3_path:-.}%f%F{yellow}${dev3_branch:+ ($dev3_branch)}%f %# '" },
	{ id: "pure", label: "Pure", source: "PROMPT=$'\\n%F{blue}${dev3_where}%f %8F${dev3_branch}%f%5F${dev3_dirty:+*}%f %3F${dev3_dur}%f\\n%(?.%F{magenta}.%F{red})❯%f '" },
	{ id: "box", label: "Box", source: "PROMPT=$'%F{8}╭─%f %F{blue}${dev3_where}%f %F{magenta}${dev3_icon_branch} ${dev3_git}%f %3F${dev3_dur}%f\\n%F{8}╰─%(?.%F{green}.%F{red})❯%f '" },
	{ id: "brackets", label: "Brackets", source: "PROMPT=$'%F{8}┌[%(?.%F{green}✔.%F{red}✘ %?)%F{8}]─[%F{blue}${dev3_where}%F{8}]─[%F{magenta}${dev3_git}%F{8}]${dev3_dur:+─[%3F$dev3_dur%8F]}─[%D{%H:%M}]%f\\n%F{8}└─%F{blue}▶%f '" },
	{ id: "starship", label: "Starship", source: "PROMPT=$'\\n%B%F{cyan}${dev3_where}%f%b${dev3_branch:+ on %B%5F$dev3_icon_branch $dev3_branch%f%b}${dev3_dirty:+ %B%1F[$dev3_git]%f%b}${dev3_dur:+ took %B%3F$dev3_dur%f%b}\\n%(?.%B%F{green}.%B%F{red})❯%f%b '" },
	{ id: "right", label: "Right side", source: "PROMPT='%F{blue}${dev3_path:-$dev3_project}%f %(?.%F{green}.%F{red})❯%f '\nRPROMPT='%(?..%F{red}✘%? %f)%F{yellow}${dev3_dur}%f %F{magenta}${dev3_git}%f %F{8}%D{%H:%M}%f'" },
	{ id: "lambda", label: "Lambda", source: "PROMPT='%F{magenta}λ%f %F{cyan}${dev3_path:-$dev3_project}%f %(?.%F{8}.%F{red})→%f '" },
	{ id: "retro", label: "Retro", source: "PROMPT='%F{green}[%F{white}${dev3_where}%F{green}]%(?..%F{red}[%?]%F{green})$%f '" },
	{ id: "unix", label: "Unix", source: "PROMPT='%F{green}%n@%m%f:%F{blue}${dev3_where}%f%# '" },
];

/**
 * The zsh code that sets the prompt for a stored choice, or `null` when dev3
 * must not touch the prompt at all. An unknown id (a style a newer dev3 wrote)
 * and an empty custom both fall back to the default style.
 */
export function shellPromptSource(choice: string | undefined, custom: string | undefined): string | null {
	if (choice === SHELL_PROMPT_OWN) return null;
	if (choice === SHELL_PROMPT_CUSTOM && custom?.trim()) return custom;
	const style = SHELL_PROMPT_STYLES.find((s) => s.id === choice) ?? defaultStyle();
	return style.source;
}

export function defaultStyle(): ShellPromptStyle {
	return SHELL_PROMPT_STYLES.find((s) => s.id === DEFAULT_SHELL_PROMPT_STYLE)!;
}
