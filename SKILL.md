---
name: gitea-manager
description: Gitea repository management and automation (backup, health check, cleanup, PR/Issue automation)
version: 0.1.0
author: Coco
license: MIT
---

# Gitea Manager Skill

## 功能概览

Gitea Manager 提供完整的 Gitea 仓库管理能力，包括备份、健康监控、清理维护、PR/Issue 自动化。

## 快速开始

### 1. 配置

确保环境变量或配置文件中设置了：

```bash
export GITEA_URL="http://localhost:3000"
export GITEA_TOKEN="your-api-token-here"
```

或者在 `~/.openclaw/workspace/.clawdbot/gitea-manager.json` 中配置：

```json
{
  "gitea": {
    "url": "http://localhost:3000",
    "token": "3d269e4232c12c68427dc1bbc4607b08fa3d9c48",
    "api_version": "v1"
  },
  "backup": {
    "dir": "/backup/gitea",
    "retention_days": 30,
    "compression": "tar.gz"
  },
  "cleanup": {
    "dry_run": true,
    "keep_releases": 5,
    "stale_days": 30
  },
  "notifications": {
    "telegram_enabled": true,
    "chat_id": "7626833436"
  }
}
```

Token 需要的权限：
- `repo` (读写仓库)
- `admin:repo` (管理分支、保护规则等)

### 2. 测试连接

```bash
openclaw skill run gitea-manager --action health-check
```

---

## 命令参考

### 备份与恢复

#### `backup-all`
镜像所有仓库到本地备份。

```bash
openclaw skill run gitea-manager --action backup-all
```

**行为**：
- 使用 `git clone --mirror` 克隆每个仓库
- 已存在的备份执行 `git remote update --prune`
- 压缩旧备份（保留最近30天）
- 备份目录：`/backup/gitea/`（可配置）

#### `backup-repo <repo-name>`
备份单个仓库。

```bash
openclaw skill run gitea-manager --action backup-repo --target cloudreve
```

#### `restore <repo-name>`
从备份恢复仓库（未实现，待开发）。

---

### 健康监控

#### `health-check`
生成健康报告（JSON + Markdown）。

```bash
openclaw skill run gitea-manager --action health-check
```

报告包含：
- 仓库列表及最后 commit 时间
- 开放 PR 数量及状态
- CI/Actions 失败数量
- Issues 统计（开放/关闭/平均解决时间）
- 仓库大小增长趋势

#### `list-stale-prs`
列出长时间未活动的 PR。

```bash
openclaw skill run gitea-manager --action list-stale-prs --days 14
```

#### `list-stale-issues`
列出未解决的陈旧 Issues。

```bash
openclaw skill run gitea-manager --action list-stale-issues --days 30
```

---

### 清理维护

#### `cleanup-merged-branches`
删除已合并的分支（保留默认分支）。

```bash
# 先 dry-run 查看哪些分支会被删除
openclaw skill run gitea-manager --action cleanup-merged-branches --dryRun true

# 确认后执行删除
openclaw skill run gitea-manager --action cleanup-merged-branches --dryRun false
```

**安全机制**：
- 默认 dry-run 模式
- 只删除已合并且不是默认分支的分支
- 记录操作日志到 `.clawdbot/gitea-manager.log`

#### `cleanup-stale-issues`
关闭长期未活动的 Issues。

```bash
openclaw skill run gitea-manager --action cleanup-stale-issues --days 30 --dryRun false
```

#### `cleanup-old-releases`
删除旧版本的 Releases（保留最近 N 个）。

```bash
openclaw skill run gitea-manager --action cleanup-old-releases --keep 5
```

---

### PR 自动化

#### `check-pr-status <pr-number>`
检查 PR 是否满足合并条件。

```bash
openclaw skill run gitea-manager --action check-pr-status --target 123 --owner belynn
```

检查项：
- CI/Actions 全部通过
- 至少 1 个 reviewer 批准
- 无冲突（branch synced）
- 描述格式合规

#### `auto-merge <pr-number>`
自动合并满足所有条件的 PR。

```bash
openclaw skill run gitea-manager --action auto-merge --target 123
```

**注意**：仅在所有 DoD 检查通过后才执行 merge。

#### `request-review <branch>`
为分支的 PR 请求审查（自动查找 PR 并添加 reviewer）。

```bash
openclaw skill run gitea-manager --action request-review --target feat/new-feature
```

---

### Issue 分类

#### `assign-issue <issue-number> <username>`
分配 Issue 给指定用户。

```bash
openclaw skill run gitea-manager --action assign-issue --target 45 --owner belynn
# 需要额外参数？暂未定义，待实现
```

#### `label-issue <issue-number> <label>`
为 Issue 添加标签。

```bash
openclaw skill run gitea-manager --action label-issue --target 45 --label "bug" --owner belynn
```

#### `close-stale`
批量关闭陈旧 Issues（与 `cleanup-stale-issues` 类似，但可自定义标签）。

```bash
openclaw skill run gitea-manager --action close-stale --days 30 --label "stale"
```

---

## 配置文件详解

位置：`~/.openclaw/workspace/.clawdbot/gitea-manager.json`

```json
{
  "gitea": {
    "url": "http://localhost:3000",
    "token": "YOUR_TOKEN",
    "api_version": "v1",
    "timeout": 30000
  },
  "backup": {
    "dir": "/backup/gitea",
    "retention_days": 30,
    "compression": "tar.gz",
    "schedule": "0 2 * * *"  // 每天凌晨2点（可配置cron）
  },
  "cleanup": {
    "dry_run": true,
    "keep_releases": 5,
    "stale_days": 30,
    "auto_delete_merged_branches": false
  },
  "notifications": {
    "telegram_enabled": true,
    "chat_id": "7626833436",
    "notify_on_failure": true,
    "notify_on_success": false
  },
  "repositories": {
    "exclude": ["archived"],  // 跳过已归档仓库
    "include_private": true
  }
}
```

---

## 安全注意事项

1. **Token 存储**：配置文件权限设为 `600`（仅所有者可读写）
2. **删除操作**：默认 `dryRun: true`，必须显式设置 `--dryRun false` 才执行
3. **操作审计**：所有操作记录在 `.clawdbot/gitea-manager.log`
4. **最小权限**：Token 只需 `repo` 和 `admin:repo`，不需要全局 admin

---

## 集成到 OpenClaw

### 作为独立 Skill

```bash
# 列出仓库
openclaw skill run gitea-manager --action health-check

# 备份所有
openclaw skill run gitea-manager --action backup-all

# 每周自动清理（通过cron）
openclaw cron add --name "Gitea Cleanup" --cron "0 2 * * 1" \
  --message "openclaw skill run gitea-manager --action cleanup-merged-branches --dryRun false"
```

### 用于 AI 日报 Orchestrator

在 AI 日报生成后，自动：
1. 将日报备份到 Gitea（作为新的 release）
2. 检查备份仓库的健康状态
3. 清理30天前的旧日报文件

---

## 故障排除

### 错误：`Only signed in user is allowed to call APIs.`
- 检查 `GITEA_TOKEN` 是否正确设置
- 确认 Token 权限包含 `repo`

### 错误：`404 page not found`
- 检查 `GITEA_URL` 是否正确（包括端口）
- API 版本是否正确（默认 `v1`）

### 备份失败：`repository not found`
- 确认仓库是否存在且你有访问权限
- SSH 克隆可能需要在本地配置 SSH 密钥

---

## 示例输出

### health-check 报告

```markdown
# Gitea Health Report (2026-03-04)

## 概览
- 总仓库数: 6
- 活跃仓库（7天内）: 4
- 开放 PRs: 0
- 开放 Issues: 0
- 失败 Actions: 0

## 仓库详情

| 仓库 | 最后更新 | 分支 | 大小 | 状态 |
|------|----------|------|------|------|
| cloudreve | 2026-02-26 | main | 17.8 MB | ✅ |
| telegram-service | 2026-03-01 | main | 2.2 MB | ✅ |
| ... | ... | ... | ... | ... |

## 建议
- ✅ 所有仓库状态健康
- ⚠️ belynn-admin 超过7天未更新（2026-01-11）
```

---

## License

MIT