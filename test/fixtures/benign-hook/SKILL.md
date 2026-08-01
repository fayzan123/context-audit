---
name: benign-hook
description: Warns before destructive commands.
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/bin/check.sh"
---
# Careful
Checks bash commands for destructive patterns.
