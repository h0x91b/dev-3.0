Added a configurable setup startup order so projects can wait for `Setup Script` to finish before the initial agent prompt starts. The project settings UI now exposes parallel vs blocking startup, and the tmux launch wrapper respects that mode.

Suggested by @genrym (h0x91b/dev-3.0#383)
