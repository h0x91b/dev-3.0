# Refresh an expired AWS SSO session for a picked Bedrock profile

## Context

A Claude task launched on Bedrock with an expired AWS SSO session stopped at "Could not load AWS credentials" and the user had to run `aws sso login` by hand. Claude Code has an `awsAuthRefresh` setting for exactly this, but nothing set it.

## Investigation

Claude Code 2.1.319 runs `awsAuthRefresh` when Bedrock credentials fail, and the command inherits the process env, so the `AWS_PROFILE` a launch injects reaches it (tested with a marker command against an expired profile). A second `--settings` flag replaces the first instead of merging with it, so a separate per-launch flag would drop dev3's hooks and status line.

## Decision

`ensureClaudeStatusLineSettings` (`src/bun/rate-limit-monitor.ts`) writes a second managed file, `claude-bedrock-sso-settings.json`, which adds `awsAuthRefresh: "aws sso login"`. `applyStatusLineOption` (`src/bun/agents.ts`) picks it only when `applyBedrockProfileEnv` injected a profile. The command takes no `--profile` because `AWS_PROFILE` already names it. The Claude adapter passes whichever file it gets as the launch's single `--settings`; hooks live in the worktree's own settings file, so nothing else competes for the flag.

## Risks

Flag settings outrank user settings, so a user's own `awsAuthRefresh` is shadowed on launches with a picked profile. A picked profile that is not SSO-based makes the refresh fail with Claude's "awsAuthRefresh failed" message, which only adds to an error that already happens.

## Alternatives considered

Adding the key to the shared managed file would shadow every Bedrock user's own refresh command. A pre-flight `aws sso login` in the launch wrapper covers only expiry at launch, not mid-session, and adds a shell-specific step for Windows.
