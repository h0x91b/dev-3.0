# Local diagnostic logs

The Bun backend and CLI write daily diagnostic files under `~/.dev3.0/logs/YYYY/MM/YYYY-MM-DD.log`. These files are local troubleshooting data; they are not a task-history store and are not uploaded by the logger.

## Retention

The logger keeps the current day's file and the previous 13 calendar days (14 days total). On the first successful write of each day, it removes dated `.log` files older than that window. Missing, unreadable, or concurrently removed files do not interrupt application work.

## Payload policy

Log entries keep structural diagnostics such as event names, task and project IDs, counts, timings, exit codes, error messages, stacks, and command output. Prompt-bearing fields (`description`, `prompt`, `title`, and related nested values), URLs, credentials, environment values, and command arguments are replaced with redaction markers; recognized command fields retain only the executable name and argument count. New diagnostics should keep event messages static and put commands in `command`, `cmd`, or another recognized command field.

File writes, serialization, and retention cleanup are best-effort. A diagnostic failure must never change the success or failure of the operation being diagnosed.
