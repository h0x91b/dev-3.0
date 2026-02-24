# 003 — Setup script через /tmp startup-файл + env vars

## Context

Нужно показывать setup-скрипт пользователю в отдельной tmux-панельке, пока агент
запускается в нижней. Два режима: foreground (агент ждёт завершения setup) и background
(оба параллельно).

## Investigation

Первый вариант — встроить setup-скрипт прямо в tmuxCmd через `bash -c "..."`. Проблема:
скрипт может содержать произвольные кавычки, переносы строк и спецсимволы. Экранирование
становится крайне хрупким, особенно при вложенных командах.

## Decision

Пишем временный shell-скрипт в `/tmp/dev3-startup-{taskId}.sh` через `Bun.write`.
Содержимое setup-скрипта и claude-команда передаются в него через env vars
(`DEV3_SETUP_SCRIPT`, `DEV3_CLAUDE_CMD`, `DEV3_WORKTREE_PATH`) — так никакого escaping не нужно.

Startup-скрипт сам вызывает `tmux split-window` для создания второй панельки и `exec bash`
в конце, чтобы pane 0 оставался живым.

**Foreground** (`setupScriptBackground = false`):
1. pane 0: запускает setup (`bash -x -c "$DEV3_SETUP_SCRIPT"`)
2. pane 0: после завершения делает `tmux split-window` → pane 1 с агентом
3. pane 0: `exec bash` — остаётся живым

**Background** (`setupScriptBackground = true`):
1. pane 0: сразу делает `tmux split-window` → pane 1 с агентом
2. pane 0: запускает setup параллельно
3. pane 0: `exec bash` — остаётся живым

Файл в `/tmp` не удаляется — ОС уберёт при перезагрузке, это приемлемо.

Логика живёт в `src/bun/rpc-handlers.ts` → `launchTaskPty` (параметр `runSetup`).
На reconnect (`getPtyUrl`) `runSetup = false` — setup не перезапускается.

## Risks

- Если `/tmp` недоступен для записи — скрипт не создастся и задача не запустится.
  На macOS/Linux это практически невозможно.
- `tmux split-window` внутри startup-скрипта предполагает, что скрипт уже выполняется
  внутри tmux-сессии (что гарантируется `spawnPty`).
- Если `DEV3_CLAUDE_CMD` содержит одинарные кавычки — `tmux split-window` может сломаться.
  Пока команды агентов одинарных кавычек не содержат.

## Alternatives considered

- **Inline escaping в tmuxCmd** — слишком хрупко для произвольного user input в setup-скрипте.
- **Запуск setup до PTY** (старый подход в `git.ts`) — работал в фоне без видимости пользователю.
- **Named pipe / socket для синхронизации** — избыточно сложно для данной задачи.
