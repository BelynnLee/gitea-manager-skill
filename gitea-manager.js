#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      let value = argv[++i];
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (!isNaN(value) && value !== '') value = Number(value);
      args[key] = value;
    }
  }
  return args;
}

class Logger {
  constructor(verbose = false) {
    this.verbose = verbose;
    const workspace = process.env.OPENCLAW_WORKSPACE || process.env.HOME || process.cwd();
    this.logFile = path.resolve(workspace, '.clawdbot', 'gitea-manager.log');
    this.ensureLogDir();
  }
  ensureLogDir() {
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  format(level, msg, meta = {}) {
    const ts = new Date().toISOString();
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] [${level}] ${msg}${metaStr}\n`;
  }
  write(level, msg, meta = {}) {
    fs.appendFileSync(this.logFile, this.format(level, msg, meta), 'utf8');
    if (this.verbose || ['ERROR','WARN'].includes(level)) console.log(`${level}: ${msg}`);
  }
  info(msg, meta) { this.write('INFO', msg, meta); }
  warn(msg, meta) { this.write('WARN', msg, meta); }
  error(msg, meta) { this.write('ERROR', msg, meta); }
}

function loadConfig() {
  const defaultConfig = {
    gitea: { url: process.env.GITEA_URL || 'http://localhost:3000', token: process.env.GITEA_TOKEN || '', api_version: 'v1', timeout: 30000 },
    backup: { dir: '/backup/gitea', retention_days: 30 },
    cleanup: { dry_run: true, keep_releases: 5, stale_days: 30 }
  };
  const possiblePaths = [
    process.env.OPENCLAW_WORKSPACE ? path.resolve(process.env.OPENCLAW_WORKSPACE, '.clawdbot', 'gitea-manager.json') : null,
    path.resolve(process.env.HOME || process.cwd(), '.openclaw', 'workspace', '.clawdbot', 'gitea-manager.json'),
    path.resolve(process.env.HOME || process.cwd(), '.clawdbot', 'gitea-manager.json')
  ].filter(Boolean);
  for (const configPath of possiblePaths) {
    if (fs.existsSync(configPath)) {
      try {
        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        Object.assign(defaultConfig, userConfig);
        break;
      } catch (e) {}
    }
  }
  if (process.env.GITEA_URL) defaultConfig.gitea.url = process.env.GITEA_URL;
  if (process.env.GITEA_TOKEN) defaultConfig.gitea.token = process.env.GITEA_TOKEN;
  if (!defaultConfig.gitea.token) throw new Error('GITEA_TOKEN required');
  if (!defaultConfig.gitea.url) throw new Error('GITEA_URL required');
  return defaultConfig;
}

class GiteaAPI {
  constructor(config) {
    this.base = `${config.gitea.url}/api/${config.gitea.api_version}`;
    this.token = config.gitea.token;
    this.timeout = config.gitea.timeout || 30000;
  }
  async request(method, endpoint, body = null) {
    const url = new URL(`${this.base}${endpoint}`);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = { method, headers: { 'Accept':'application/json', 'Content-Type':'application/json', 'Authorization': `token ${this.token}` }, timeout: this.timeout };
    if (body) opts.body = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = lib.request(url, opts, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : null;
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
            else reject(new Error(`HTTP ${res.statusCode}: ${json?.message || data}`));
          } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${this.timeout}ms`)); });
      if (body) req.write(opts.body);
      req.end();
    });
  }
  async get(endpoint) { return this.request('GET', endpoint); }
  async post(endpoint, body) { return this.request('POST', endpoint, body); }
  async delete(endpoint) { return this.request('DELETE', endpoint); }
  async patch(endpoint, body) { return this.request('PATCH', endpoint, body); }

  async getUser() { return this.get('/user'); }
  async listRepos(username, params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/users/${encodeURIComponent(username)}/repos${q ? '?'+q : ''}`);
  }
  async listBranches(owner, repo) {
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
  }
  async deleteBranch(owner, repo, branch) {
    return this.delete(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`);
  }
  async listPRs(owner, repo, params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls${q ? '?'+q : ''}`);
  }
  async getPR(owner, repo, index) {
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}`);
  }
  async addReviewer(owner, repo, index, reviewers) {
    return this.post(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/request-reviewers`, { reviewers: Array.isArray(reviewers) ? reviewers : [reviewers] });
  }
  async getPRReviews(owner, repo, index) {
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/reviews`);
  }
  async listIssues(owner, repo, params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues${q ? '?'+q : ''}`);
  }
  async closeIssue(owner, repo, index) {
    return this.patch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}`, { state: 'closed' });
  }
  async addLabel(owner, repo, issueIndex, labels) {
    return this.post(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueIndex}/labels`, { labels: Array.isArray(labels) ? labels : [labels] });
  }
  async assignIssue(owner, repo, index, assignees) {
    return this.post(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/assignees`, { assignees: Array.isArray(assignees) ? assignees : [assignees] });
  }
  async listReleases(owner, repo) {
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`);
  }
  async deleteRelease(owner, repo, releaseId) {
    return this.delete(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${releaseId}`);
  }
  async listActions(owner, repo, params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions${q ? '?'+q : ''}`);
  }
  async listCommits(owner, repo, params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits${q ? '?'+q : ''}`);
  }
  async getCommitStatus(owner, repo, sha) {
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/statuses`);
  }
  async mergePR(owner, repo, index, data = {}) {
    return this.post(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/merge`, data);
  }
}

async function healthCheck({ config, logger, args }) {
  const owner = args.owner || 'belynn';
  const daysThreshold = args.days || 7;
  const api = new GiteaAPI(config);
  logger.info('Starting health check...', { owner, daysThreshold });
  const repos = await api.listRepos(owner, { type: 'private' });
  if (!Array.isArray(repos) || repos.length === 0) {
    logger.warn('No repositories found');
    return { total_repos: 0, healthy: 0 };
  }
  const report = { timestamp: new Date().toISOString(), total_repos: repos.length, repos: [], summary: { active:0, inactive:0, open_prs:0, open_issues:0, failed_actions:0 } };
  for (const repo of repos) {
    const repoInfo = { name: repo.name, html_url: repo.html_url, default_branch: repo.default_branch, size: repo.size, private: repo.private, archived: repo.archived, last_updated: repo.updated_at, open_prs: 0, open_issues: 0, failed_actions: 0, status: 'healthy' };
    try {
      const prs = await api.listPRs(owner, repo.name, { state: 'open' });
      repoInfo.open_prs = prs.length;
      report.summary.open_prs += prs.length;
      const issues = await api.listIssues(owner, repo.name, { state: 'open' });
      repoInfo.open_issues = issues.length;
      report.summary.open_issues += issues.length;
      try {
        const actions = await api.listActions(owner, repo.name, { per_page: 10 });
        if (actions && Array.isArray(actions)) {
          const failed = actions.filter(a => a.conclusion === 'failure');
          repoInfo.failed_actions = failed.length;
          report.summary.failed_actions += failed.length;
        }
      } catch (e) {}
      const lastUpdated = new Date(repo.updated_at);
      const daysSince = (Date.now() - lastUpdated) / (1000*60*60*24);
      repoInfo.days_since_update = Math.floor(daysSince);
      if (daysSince > daysThreshold) {
        repoInfo.status = 'inactive';
        repoInfo.warnings = [`Inactive for ${Math.floor(daysSince)} days`];
        report.summary.inactive++;
      } else {
        report.summary.active++;
      }
      if (repo.size > 500*1024*1024) {
        repoInfo.warnings = repoInfo.warnings || [];
        repoInfo.warnings.push(`Large repository: ${(repo.size/1024/1024/1024).toFixed(1)} GB`);
      }
    } catch (err) {
      logger.warn(`Failed to fetch ${repo.name}: ${err.message}`);
      repoInfo.error = err.message;
      repoInfo.status = 'error';
    }
    report.repos.push(repoInfo);
  }
  const md = generateHealthMarkdown(report);
  report.markdown = md;
  logger.info('Health check completed', { total: report.total_repos, active: report.summary.active, inactive: report.summary.inactive });
  return report;
}

function generateHealthMarkdown(report) {
  const lines = [
    `# Gitea Health Report`,
    ``,
    `**Generated:** ${new Date(report.timestamp).toLocaleString('zh-CN')}`,
    `**Total Repositories:** ${report.total_repos}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Count |`,
    `|--------|-------|`,
    `| 🟢 Active (≤7 days) | ${report.summary.active} |`,
    `| 🔴 Inactive (>7 days) | ${report.summary.inactive || 0} |`,
    `| 🔀 Open PRs | ${report.summary.open_prs} |`,
    `| 🐛 Open Issues | ${report.summary.open_issues} |`,
    `| ⚠️ Failed Actions | ${report.summary.failed_actions} |`,
    ``,
    `## Repository Details`,
    ``,
    `| Repository | Branch | Last Updated | Status | PRs | Issues | Size |`,
    `|------------|--------|--------------|--------|-----|--------|------|`
  ];
  for (const repo of report.repos) {
    const lastUpdated = new Date(repo.last_updated).toLocaleDateString('zh-CN');
    const statusIcon = repo.status === 'healthy' ? '✅' : (repo.status === 'inactive' ? '⚠️' : '❌');
    const sizeGB = (repo.size / 1024 / 1024 / 1024).toFixed(1);
    lines.push(`| [${repo.name}](${repo.html_url}) | ${repo.default_branch} | ${lastUpdated} | ${statusIcon} | ${repo.open_prs} | ${repo.open_issues} | ${sizeGB} GB |`);
  }
  lines.push(``);
  lines.push(`## Warnings`);
  lines.push(``);
  let hasWarn = false;
  for (const repo of report.repos) {
    if (repo.warnings && repo.warnings.length) {
      hasWarn = true;
      lines.push(`- **${repo.name}**: ${repo.warnings.join(', ')}`);
    }
  }
  if (!hasWarn) lines.push(`✅ All repositories are healthy!`);
  return lines.join('\n');
}

async function backupAllRepos({ config, logger, args }) {
  const { dryRun = false } = args;
  const backupDir = path.resolve(config.backup.dir);
  const owner = args.owner || 'belynn';
  const api = new GiteaAPI(config);
  const repos = await api.listRepos(owner, { type: 'private' });
  if (!fs.existsSync(backupDir) && !dryRun) fs.mkdirSync(backupDir, { recursive: true });
  const results = { backed_up: 0, skipped: 0, errors: [] };
  for (const repo of repos) {
    const repoName = repo.name;
    const cloneUrl = repo.clone_url || repo.ssh_url;
    const mirrorPath = path.join(backupDir, `${repoName}.git`);
    logger.info(`Processing: ${repoName}`);
    if (dryRun) {
      logger.info(`[DRY RUN] Would backup ${repoName} to ${mirrorPath}`);
      results.backed_up++;
      continue;
    }
    try {
      if (fs.existsSync(mirrorPath)) {
        const update = spawnSync('git', ['-C', mirrorPath, 'remote', 'update', '--prune'], { encoding: 'utf8' });
        if (update.status !== 0) throw new Error(update.stderr);
      } else {
        const clone = spawnSync('git', ['clone', '--mirror', cloneUrl, mirrorPath], { encoding: 'utf8', timeout: 300000 });
        if (clone.status !== 0) throw new Error(clone.stderr);
      }
      results.backed_up++;
      logger.info(`✅ Backed up ${repoName}`);
    } catch (err) {
      logger.error(`Backup failed: ${repoName} - ${err.message}`);
      results.errors.push({ repo: repoName, error: err.message });
      results.skipped++;
    }
  }
  return results;
}

async function cleanupMergedBranches({ config, logger, args }) {
  const { dryRun = true, owner = 'belynn' } = args;
  const api = new GiteaAPI(config);
  const repos = await api.listRepos(owner);
  const results = { total: 0, deleted: 0, skipped: 0, errors: [] };
  for (const repo of repos) {
    const repoName = repo.name;
    const defaultBranch = repo.default_branch || 'main';
    try {
      const branches = await api.listBranches(owner, repoName);
      const mergedBranches = branches.filter(b => b.name !== defaultBranch && b.merged === true);
      if (mergedBranches.length === 0) continue;
      logger.info(`${repoName}: ${mergedBranches.length} merged branch(es)`);
      if (dryRun) {
        results.total += mergedBranches.length;
        results.deleted += mergedBranches.length;
        logger.info(`[DRY RUN] Would delete: ${mergedBranches.map(b=>b.name).join(', ')}`);
      } else {
        for (const branch of mergedBranches) {
          try {
            await api.deleteBranch(owner, repoName, branch.name);
            logger.info(`Deleted branch: ${repoName}/${branch.name}`);
            results.deleted++;
          } catch (err) {
            logger.error(`Failed to delete ${repoName}/${branch.name}: ${err.message}`);
            results.errors.push({ repo: repoName, branch: branch.name, error: err.message });
          }
        }
        results.total += mergedBranches.length;
      }
    } catch (err) {
      logger.error(`Error processing ${repoName}: ${err.message}`);
      results.errors.push({ repo: repoName, error: err.message });
    }
  }
  return results;
}

async function cleanupStaleIssues({ config, logger, args }) {
  const { dryRun = true, days = 30, owner = 'belynn', label = 'stale' } = args;
  const api = new GiteaAPI(config);
  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const repos = await api.listRepos(owner);
  const results = { total: 0, closed: 0, errors: [] };
  for (const repo of repos) {
    const repoName = repo.name;
    try {
      const issues = await api.listIssues(owner, repoName, { state: 'open' });
      const stale = issues.filter(i => new Date(i.updated_at) < threshold);
      if (stale.length === 0) continue;
      if (dryRun) {
        results.total += stale.length;
        results.closed += stale.length;
        for (const i of stale) logger.info(`[DRY RUN] Would close ${repoName}#${i.number}: ${i.title}`);
      } else {
        for (const i of stale) {
          try {
            await api.addLabel(owner, repoName, i.number, [label]);
            await api.closeIssue(owner, repoName, i.number);
            logger.info(`Closed ${repoName}#${i.number} (added '${label}')`);
            results.closed++;
          } catch (err) {
            logger.error(`Failed to close ${repoName}#${i.number}: ${err.message}`);
            results.errors.push({ repo: repoName, issue: i.number, error: err.message });
          }
        }
        results.total += stale.length;
      }
    } catch (err) {
      logger.error(`Error in ${repoName}: ${err.message}`);
      results.errors.push({ repo: repoName, error: err.message });
    }
  }
  return results;
}

async function listStalePRs({ config, logger, args }) {
  const { days = 14, owner = 'belynn' } = args;
  const api = new GiteaAPI(config);
  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const repos = await api.listRepos(owner);
  const stale = [];
  for (const repo of repos) {
    try {
      const prs = await api.listPRs(owner, repo.name, { state: 'open' });
      for (const pr of prs) {
        if (new Date(pr.updated_at) < threshold) {
          stale.push({
            repo: repo.name, number: pr.number, title: pr.title, updated_at: pr.updated_at,
            url: pr.html_url, days_inactive: Math.floor((Date.now() - new Date(pr.updated_at)) / (1000*60*60*24))
          });
        }
      }
    } catch (e) {}
  }
  stale.sort((a,b) => b.days_inactive - a.days_inactive);
  return { count: stale.length, threshold_days: days, prs: stale };
}

async function listStaleIssues({ config, logger, args }) {
  const { days = 30, owner = 'belynn' } = args;
  const api = new GiteaAPI(config);
  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const repos = await api.listRepos(owner);
  const stale = [];
  for (const repo of repos) {
    try {
      const issues = await api.listIssues(owner, repo.name, { state: 'open' });
      for (const issue of issues) {
        if (new Date(issue.updated_at) < threshold) {
          stale.push({
            repo: repo.name, number: issue.number, title: issue.title, updated_at: issue.updated_at,
            url: issue.html_url, days_inactive: Math.floor((Date.now() - new Date(issue.updated_at)) / (1000*60*60*24))
          });
        }
      }
    } catch (e) {}
  }
  stale.sort((a,b) => b.days_inactive - a.days_inactive);
  return { count: stale.length, threshold_days: days, issues: stale };
}

async function cleanupOldReleases({ config, logger, args }) {
  const { keep = 5, owner = 'belynn', dryRun = true } = args;
  const api = new GiteaAPI(config);
  const repos = await api.listRepos(owner);
  const results = { total: 0, deleted: 0, errors: [] };
  for (const repo of repos) {
    try {
      const releases = await api.listReleases(owner, repo.name);
      if (!releases || releases.length <= keep) continue;
      releases.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
      const toDelete = releases.slice(0, releases.length - keep);
      if (dryRun) {
        results.total += toDelete.length;
        results.deleted += toDelete.length;
        for (const rel of toDelete) logger.info(`[DRY RUN] Would delete ${repo.name}: ${rel.tag_name}`);
      } else {
        for (const rel of toDelete) {
          try {
            await api.deleteRelease(owner, repo.name, rel.id);
            logger.info(`Deleted release ${repo.name}: ${rel.tag_name}`);
            results.deleted++;
          } catch (err) {
            logger.error(`Failed to delete ${rel.tag_name}: ${err.message}`);
            results.errors.push({ repo: repo.name, release: rel.tag_name, error: err.message });
          }
        }
        results.total += toDelete.length;
      }
    } catch (err) {
      logger.error(`Error processing repo: ${err.message}`);
      results.errors.push({ repo: repo.name, error: err.message });
    }
  }
  return results;
}

async function checkPRStatus({ config, logger, args }) {
  const { target: prNumber, owner = 'belynn', repo } = args;
  if (!prNumber) throw new Error('--target <pr-number> required');
  if (!repo) throw new Error('--repo <repo-name> required');
  const api = new GiteaAPI(config);
  const pr = await api.getPR(owner, repo, prNumber);
  const checks = { pr_created: true, branch_synced: !pr.mergeable, ci_passed: false, review_approved: false, description_valid: false };
  try {
    const actions = await api.listActions(owner, repo, { head: pr.head.sha });
    if (actions && actions.length > 0) {
      checks.ci_passed = actions[0].conclusion === 'success';
    }
  } catch (e) {}
  try {
    const reviews = await api.getPRReviews(owner, repo, prNumber);
    if (reviews && Array.isArray(reviews)) {
      const approved = reviews.filter(r => r.state === 'approved');
      checks.review_approved = approved.length >= 1;
      checks.review_count = reviews.length;
      checks.approved_count = approved.length;
    }
  } catch (e) {}
  const body = pr.body || '';
  checks.description_valid = (
    body.length > 50 &&
    /(?:test|testing|steps?|repro|reproduce)/i.test(body) &&
    /(?:fixes|closes|related)/i.test(body)
  );
  if (/ui|frontend|style|css|component/i.test(pr.title)) {
    checks.has_screenshots = /(?:screenshot|screenshots|image|img|\.png|\.jpg)/i.test(body);
  } else {
    checks.has_screenshots = true;
  }
  const isMergeable = checks.ci_passed && checks.review_approved && (checks.branch_synced || pr.mergeable) && checks.description_valid && checks.has_screenshots;
  const result = { pr: prNumber, repo, html_url: pr.html_url, title: pr.title, state: pr.state, mergeable: pr.mergeable, checks, is_mergeable, recommendations: [] };
  if (!checks.ci_passed) result.recommendations.push('Wait for CI');
  if (!checks.review_approved) result.recommendations.push('Request approval');
  if (!checks.branch_synced) result.recommendations.push('Sync branch');
  if (!checks.description_valid) result.recommendations.push('Improve description');
  if (!checks.has_screenshots) result.recommendations.push('Add screenshots');
  return result;
}

async function autoMerge({ config, logger, args }) {
  const { target: prNumber, owner = 'belynn', dryRun = false } = args;
  if (!prNumber) throw new Error('--target <pr-number> required');
  const repo = args.repo;
  if (!repo) throw new Error('--repo <repo-name> required');
  const api = new GiteaAPI(config);
  const status = await checkPRStatus({ config, logger, args });
  if (!status.is_mergeable) {
    return { pr: prNumber, merged: false, reason: 'Not ready', recommendations: status.recommendations };
  }
  if (dryRun) {
    return { pr: prNumber, merged: false, dry_run: true, message: 'PR ready to merge (dry run)' };
  }
  const mergeResult = await api.mergePR(owner, repo, prNumber, { merge_method: 'squash', delete_branch_after_merge: true });
  logger.info(`✅ PR ${prNumber} merged: ${mergeResult.sha}`);
  return { pr: prNumber, merged: true, sha: mergeResult.sha };
}

async function requestReview({ config, logger, args }) {
  const { target: branchOrPr, owner = 'belynn', reviewers, repo } = args;
  if (!branchOrPr) throw new Error('--target <branch|pr> required');
  if (!repo) throw new Error('--repo required');
  const api = new GiteaAPI(config);
  let prNumber = args.prNumber;
  if (!prNumber) {
    const prs = await api.listPRs(owner, repo, { head: `${owner}:${branchOrPr}` });
    if (!prs || prs.length === 0) throw new Error(`No PR for branch ${branchOrPr}`);
    prNumber = prs[0].number;
  }
  if (!reviewers || !Array.isArray(reviewers)) {
    throw new Error('No reviewers specified');
  }
  await api.addReviewer(owner, repo, prNumber, reviewers);
  logger.info(`Review requested: ${prNumber} → ${reviewers.join(', ')}`);
  return { pr: prNumber, repo, reviewers, success: true };
}

async function assignIssue({ config, logger, args }) {
  const { target: issueNumber, owner = 'belynn', assignee, repo } = args;
  if (!issueNumber) throw new Error('--target required');
  if (!assignee) throw new Error('--assignee required');
  if (!repo) throw new Error('--repo required');
  const api = new GiteaAPI(config);
  await api.assignIssue(owner, repo, issueNumber, assignee);
  logger.info(`Issue ${repo}#${issueNumber} assigned to ${assignee}`);
  return { issue: issueNumber, repo, assignee, success: true };
}

async function labelIssue({ config, logger, args }) {
  const { target: issueNumber, owner = 'belynn', label, repo } = args;
  if (!issueNumber) throw new Error('--target required');
  if (!label) throw new Error('--label required');
  if (!repo) throw new Error('--repo required');
  const api = new GiteaAPI(config);
  await api.addLabel(owner, repo, issueNumber, label);
  logger.info(`Added label '${label}' to ${repo}#${issueNumber}`);
  return { issue: issueNumber, repo, label, success: true };
}

async function closeStale({ config, logger, args }) {
  const { dryRun = true, days = 30, owner = 'belynn', label = 'stale' } = args;
  return await cleanupStaleIssues({ config, logger, args });
}

const COMMANDS = {
  'backup-all': backupAllRepos,
  'backup-repo': backupAllRepos,
  'health-check': healthCheck,
  'list-stale-prs': listStalePRs,
  'list-stale-issues': listStaleIssues,
  'cleanup-merged-branches': cleanupMergedBranches,
  'cleanup-stale-issues': cleanupStaleIssues,
  'cleanup-old-releases': cleanupOldReleases,
  'check-pr-status': checkPRStatus,
  'auto-merge': autoMerge,
  'request-review': requestReview,
  'assign-issue': assignIssue,
  'label-issue': labelIssue,
  'close-stale': closeStale
};

// Only auto-run when executed directly (not when required by OpenClaw as a skill)
if (require.main === module) {
  // Check dependencies only in CLI mode
  const deps = ['git', 'curl', 'jq'];
  for (const dep of deps) {
    try { spawnSync(dep, ['--version'], { stdio: 'ignore' }); }
    catch (e) {
      console.error(`Missing dependency: ${dep}. Please install it.`);
      process.exit(1);
    }
  }
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}

async function main() {
  const logger = new Logger({ verbose: process.env.VERBOSE === 'true' });
  let config;

  const args = parseArgs(process.argv);

  // If no action provided, show help (for skill discovery)
  if (!args.action) {
    console.log(`
Gitea Manager Skill
Usage: gitea-manager --action <action> [options]

Actions:
  health-check                Generate health report
  backup-all [--dryRun=false] Backup all repositories
  cleanup-merged-branches [--dryRun=false] Delete merged branches
  list-stale-prs [--days=14]  List PRs inactive for N days
  ... and more (see SKILL.md)

Common options:
  --owner <username>          Repository owner (default: belynn)
  --target <name>             Target repo/issue/PR
  --dryRun <true|false>       Dry run mode (default: true)
`);
    process.exit(0);
  }

  // Load config only when command executes
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Configuration error:', err.message);
    process.exit(1);
  }

  const { action } = args;
  const command = COMMANDS[action];
  if (!command) {
    console.error(`Error: Unknown action "${action}"`);
    console.log('Available actions:', Object.keys(COMMANDS).join(', '));
    process.exit(1);
  }

  try {
    logger.info(`Executing: ${action}`, args);
    const result = await command({ config, logger, args });
    logger.info(`Completed: ${action}`);
    if (result) console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    logger.error(`Failed: ${action} - ${err.message}`, { stack: err.stack });
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}
