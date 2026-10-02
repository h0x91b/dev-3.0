# Shell prompt styles: one engine, many one-line styles

## Context
Settings → Terminal → Shell prompt lets the user pick a prompt style for zsh shell panes, write their own, or keep the prompt from their own `.zshrc`. The user wanted every style to be small enough to copy and tweak.

## Decision
`ZSH_PROMPT_ENGINE` (`src/bun/shell-init.ts`) does all the work in `precmd` — one git call, the timer, the narrow-pane fitting — and publishes `dev3_*` variables. A style (`src/shared/shell-prompt-styles.ts`) is only `PROMPT=` (and maybe `RPROMPT=`) lines reading them, written to `prompt.zsh` next to the generated `.zshrc`, which sources it and falls back to the default style if it fails to load. Only zsh gets styles; bash keeps dev3's built-in prompt, `sh` its plain frame, and "own" turns all of them off. Previews run the real engine against a throwaway demo repo (`src/bun/shell-prompt-preview.ts`), so a custom style is shown — and parse-checked with `zsh -n` — exactly as a pane would render it. The Nerd Font glyphs are byte escapes (`$'\xee\x82\xbc'`), because `$'\u…'` aborts the whole `.zshrc` under a non-UTF-8 locale.

## Risks
`/tmp/dev3-shell` is shared by every installed dev3; an older build started later rewrites it with its own prompt until this one starts again. A custom style that parses but misbehaves at prompt time is not caught. Previews print the real login name for `%n`; the preview swaps it for `you`.

## Alternatives considered
A token template (`{task} {path}`) compiled to zsh and bash — portable but far less expressive, and the user asked for zsh only. Separate bash styles — doubles every style for a shell the user chose not to support. Hand-drawn HTML previews — would drift from what zsh actually prints.
