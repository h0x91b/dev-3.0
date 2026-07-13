# Codex readable workspace names

## Context

Codex OAuth stores the selected ChatGPT workspace as `tokens.account_id` / `chatgpt_account_id`, but the JWT does not carry its readable name. The JWT `organizations` array describes API organizations and can name a different organization than the selected ChatGPT workspace.

## Investigation

Two real logins for Wix and Base44 produced distinct workspace IDs while both JWTs reported Wix as the default API organization. ChatGPT's first-party accounts check endpoint returned the authoritative `account.id → account.name` mapping for both workspaces.

## Decision

`fetchCodexWorkspaceNames` in `src/bun/agent-accounts.ts` performs a best-effort accounts lookup after Codex login/import and once for legacy entries. The resolved name is stored additively as `workspaceName` in `accounts.json`; identity parsing itself no longer treats API organizations as workspaces.

## Risks

The accounts check endpoint is not a documented public API and may change, fail, or be unavailable offline. A five-second timeout and ID-based fallback keep login, listing, and account selection functional; access tokens remain only in the authorization header and are never logged or persisted again.

## Alternatives considered

Showing only short IDs was reliable but did not let users distinguish workspaces by sight. Reusing the JWT organization title was rejected because it caused the original mislabel, while requiring users to manually rename every account added unnecessary friction.
