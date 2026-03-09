#!/bin/bash
# PreToolUse hook that auto-approves safe operations:
# - Bash commands starting with "unset " (harmless env var removal, enables
#   compound commands like "unset GH_TOKEN && git push ...")
# - Bash commands starting with "gh " (GitHub CLI)
# - Read tool accessing /tmp/ or any screenshots/ directory

ALLOW='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-approved by project hook"}}'
PASS='{}'

input=$(cat)
tool=$(echo "$input" | jq -r '.tool_name // empty')

case "$tool" in
  Bash)
    cmd=$(echo "$input" | jq -r '.tool_input.command // empty')
    case "$cmd" in
      unset\ *|gh\ *)
        echo "$ALLOW"
        ;;
      *)
        echo "$PASS"
        ;;
    esac
    ;;
  Read)
    path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
    case "$path" in
      /tmp/*|*/screenshots/*)
        echo "$ALLOW"
        ;;
      *)
        echo "$PASS"
        ;;
    esac
    ;;
  *)
    echo "$PASS"
    ;;
esac
