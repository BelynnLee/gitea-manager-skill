# Gitea Manager Skill

A comprehensive tool for managing Gitea repositories.

## Quick Start

1. Configure Gitea credentials:
   ```bash
   export GITEA_URL="http://localhost:3000"
   export GITEA_TOKEN="your-token"
   ```
   or create `~/.openclaw/workspace/.clawdbot/gitea-manager.json`

2. Use from OpenClaw agent:
   ```
   /skill:gitea-manager --action health-check
   ```

## Actions

- `health-check`: Generate health report
- `backup-all`: Backup all repositories
- `cleanup-merged-branches`: Delete merged branches
- `list-stale-prs`: List inactive PRs
- ... and more

See `SKILL.md` for full documentation.
