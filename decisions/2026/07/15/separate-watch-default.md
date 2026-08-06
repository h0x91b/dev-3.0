# 131 — Separate Watch defaults from task overrides

## Context
Watch exists at two scopes: `GlobalSettings.watchByDefault` seeds future launches, while `Task.watched` controls notifications for one task. Persisting a preference from task-level controls made a local action silently change future behavior.

## Investigation
The launch modal can initialize its local Watch choice from the global default without coupling later clicks to that preference. Task cards, the inspector, and the launch flow all share the task-level `toggleTaskWatch` RPC, while Settings already owns durable behavior.

## Decision
Expose `watchByDefault` in Settings → Behavior and keep every task Watch control scoped to its task. Global settings saves emit `globalSettingsUpdated` so the launch picker receives preference changes without making task actions write global state; Watch tooltips direct users to the setting.

## Risks
Users accustomed to the old remember-last behavior must now change the explicit setting once. Existing stored values remain compatible, and an absent preference continues to default to off.

## Alternatives considered
Remembering every task toggle was rejected as a hidden global side effect. A launch-time “Save as default” action and tri-state inheritance were rejected because they add configuration complexity to a frequent transactional flow.
