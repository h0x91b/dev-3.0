# Claude store names: every non-alphanumeric becomes `-`, long names are cut and hashed

## Context
`claudeEncodePath` (`src/shared/conversation-search-core.ts`) maps a working dir to its Claude Code transcript store, `<config dir>/projects/<name>`. It replaced only `/` and `.`, so any path with `_`, a space, a comma or a Windows separator pointed at a store that does not exist. Search, import, resume verification and `stats usage --task` all silently found nothing there; the per-task usage report showed it as a wrong $0.

## Investigation
On this machine `~/.claude/projects` holds no name with a character outside `[A-Za-z0-9-]`, and a working dir containing `5qkl_yy11` lives under `5qkl-yy11`. One name is 207 characters: the encoded path cut at 200, then `-` and a 6-character suffix. Hashing the transcript's own `cwd` reproduced that suffix with a Java-style 32-bit string hash (`h = (h << 5) - h + charCode | 0`), `Math.abs`, base 36. `Bun.hash`, CRC32 and djb2 did not.

## Decision
`claudeEncodePath` now replaces `[^a-zA-Z0-9]` and applies the 200-character cut plus that hash. It is still the only place the algorithm lives, so every caller is fixed at once. `src/bun/__tests__/conversation-search-core.test.ts` pins the real 207-character name.

## Risks
The algorithm is reverse-engineered. If Claude Code changes it (for example to `Bun.hash` in some build), stores past 200 characters go missing again while short ones keep working.

## Alternatives considered
Scanning `projects/` for a name with a matching prefix: robust to a hash change, but it costs a directory read per lookup, and two long paths that share their first 200 characters would collide.
