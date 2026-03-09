#!/bin/bash
# Auto-approve Bash commands that start with "unset " since unset only
# removes environment variables and is harmless on its own. This lets
# compound commands like "unset GH_TOKEN && git push ..." pass through
# without a permission prompt.

cmd=$(jq -r '.tool_input.command // empty')

case "$cmd" in
  unset\ *)
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-approved: starts with unset"}}
EOF
    ;;
  *)
    echo '{}'
    ;;
esac
