---
name: hookify
description: "Use when adding automated hook behavior to Claude Code or Cursor from a natural language description."
triggers:
  - "/hookify"
  - "Create hook"
  - "Add hook"
  - "Run lint after edit"
  - "Notify when done"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "configuration"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Hookify

Create agent hooks from natural language descriptions.

## Arguments

- `/hookify <description>` — create hook from description
- `/hookify --list` — show all current hooks
- `/hookify --remove <event>` — remove a hook

## Workflow

### Step 1: Parse Request
Understand from natural language:
- **When**: what event triggers it (before edit, after bash, on stop)
- **What**: what should happen (run command, check, notify)
- **Condition**: optional matcher (specific tool, file pattern)

Examples:
- "Run lint after every file edit" → PostToolUse + Edit matcher + lint command
- "Notify me when done" → Stop + notification command
- "Check types before committing" → PreToolUse + Bash(git commit) + tsc

### Step 2: Read Current Settings
Check for existing hooks to avoid conflicts.

### Step 3: Generate Hook Config

```json
{
  "hooks": {
    "<event>": [
      {
        "matcher": "<tool name or pattern>",
        "command": "<shell command>",
        "timeout": 60000
      }
    ]
  }
}
```

### Step 4: Validate
1. Verify command exists and is executable
2. Test standalone if safe
3. Check for conflicts with existing hooks

### Step 5: Preview & Apply
```
🔧 New hook:
  Event: PostToolUse (Edit)
  Command: npm run lint --fix
  Timeout: 30s

Add to settings.json? [confirm]
```

After confirmation, merge into settings.

## Hook Event Reference

| Event | When | Matcher |
|-------|------|---------|
| PreToolUse | Before tool runs | Tool name: Edit, Bash, Write |
| PostToolUse | After tool runs | Tool name |
| Notification | Agent notifies | — |
| Stop | Response complete | — |
| SubagentStop | Sub-agent done | — |

## Common Patterns

- **Auto-lint**: PostToolUse(Edit) → `eslint --fix $FILE`
- **Auto-format**: PostToolUse(Write) → `prettier --write $FILE`
- **Type-check gate**: PreToolUse(Bash:git commit) → `npx tsc --noEmit`
- **Notify on done**: Stop → notification command

## Rules

- ALWAYS preview before applying
- NEVER overwrite existing hooks — merge or ask
- Keep timeouts reasonable (10-60s)
- Warn if hook could slow down every tool call
- Test commands before adding as hooks
