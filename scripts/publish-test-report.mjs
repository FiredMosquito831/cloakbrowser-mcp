import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ciAggregate, ciPlan } from '#scripts/test-report';
import { sanitizeDiagnostic } from '#scripts/lib/test-diagnostics';

const sourceRepository = 'swimmwatch/cloakbrowser-mcp';
const reportPath = /^pr\/[1-9]\d*\/run\/[1-9]\d*-attempt-[1-9]\d*\/[a-f0-9]{40}$/;
const retention = 14 * 24 * 60 * 60 * 1000;
const marker = '<!-- cloakbrowser-report -->';

function checkedIdentity(identity) {
  const expected = `pr/${identity.pr}/run/${identity.run}-attempt-${identity.attempt}/${identity.sha}`;
  if (
    !reportPath.test(identity.path) ||
    expected !== identity.path ||
    ![identity.pr, identity.run, identity.attempt].every((id) => Number.isSafeInteger(id) && id > 0)
  )
    throw new Error('Report publication: invalid immutable identity');
  const fallback = `https://github.com/${sourceRepository}/actions/runs/${identity.run}/attempts/${identity.attempt}`;
  if (identity.fallback !== fallback) throw new Error('Report publication: invalid fallback');
  return identity;
}

async function directory(value, create = false) {
  const absolute = path.resolve(value);
  let current = path.parse(absolute).root;
  if (absolute === current) throw new Error('Report publication: unsafe root');
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Report publication: unsafe directory');
  }
  return fs.realpath(absolute);
}

async function jsonFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('Report publication: unsafe metadata');
  const text = await fs.readFile(filename, 'utf8');
  return JSON.parse(text);
}

/** Derive public identity from GitHub API records, never producer metadata. */
export function reportIdentity(run, pr, source) {
  if (
    source.full_name !== sourceRepository ||
    run.repository?.id !== source.id ||
    run.repository?.full_name !== sourceRepository ||
    pr.base?.repo?.id !== source.id ||
    pr.head?.repo?.id !== run.head_repository?.id ||
    pr.head?.sha !== run.head_sha ||
    pr.state !== 'open' ||
    run.status !== 'completed' ||
    run.event !== 'pull_request' ||
    run.path !== '.github/workflows/ci.yml' ||
    !/^[a-f0-9]{40}$/.test(run.head_sha) ||
    ![run.id, run.run_attempt, pr.number].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error('Report publication: API identity mismatch');
  const sha = run.head_sha;
  const number = pr.number;
  const id = run.id;
  const attempt = run.run_attempt;
  const path = `pr/${number}/run/${id}-attempt-${attempt}/${sha}`;
  const fallback = `https://github.com/${sourceRepository}/actions/runs/${id}/attempts/${attempt}`;
  return { pr: number, run: id, attempt, sha, path, fallback };
}

/** Keep publication separate from source and documentation ownership. */
export function reportDestination(repository, source = sourceRepository) {
  const match = /^([\w-]+)\/([\w.-]+)$/.exec(repository);
  const owner = source.split('/')[0];
  if (
    !match ||
    source !== sourceRepository ||
    match[1] !== owner ||
    repository === source ||
    ['.', '..'].includes(match[2])
  )
    throw new Error('Report publication: unsafe destination');
  return `https://${owner}.github.io/${match[2]}/`;
}

/** Pending newer executions also prevent replacement by stale reports. */
export function freshPublication(identity, pr, runs, comments) {
  if (pr.state !== 'open' || pr.head?.sha !== identity.sha || pr.number !== identity.pr) return false;
  const eligible = runs.filter(
    (run) =>
      run.head_sha === identity.sha &&
      run.event === 'pull_request' &&
      run.path === '.github/workflows/ci.yml',
  );
  const newest = eligible.sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
  if (!newest || newest.id !== identity.run || newest.run_attempt !== identity.attempt) return false;
  const pattern = /<!-- cloakbrowser-report:(\d+):(\d+):([a-f0-9]{40}) -->/;
  return !comments.some((comment) => {
    if (comment.user?.login !== 'github-actions[bot]' || comment.user?.type !== 'Bot') return false;
    const marker = pattern.exec(comment.body || '');
    return (
      marker &&
      marker[3] === identity.sha &&
      (Number(marker[1]) > identity.run ||
        (Number(marker[1]) === identity.run && Number(marker[2]) > identity.attempt))
    );
  });
}

/** Ignore foreign content; remove only validated expired report roots. */
export function expiredReports(entries, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Report publication: invalid clock');
  return entries
    .filter(
      (entry) =>
        reportPath.test(entry.path) &&
        Number.isSafeInteger(entry.created) &&
        entry.created >= 0 &&
        entry.created < now - retention,
    )
    .map((entry) => entry.path);
}

/** Rebuild from validated producer data and expose only trusted generated HTML. */
export async function preparePublicReport({ input, output, identity, expected, secretValues = [] }) {
  checkedIdentity(identity);
  const parent = await directory(path.dirname(path.resolve(output)), true);
  const stage = await fs.mkdtemp(path.join(parent, '.publisher-'));
  try {
    const report = path.join(stage, 'report');
    const options = {
      input,
      output: report,
      runId: `run-${identity.run}-attempt-${identity.attempt}`,
      expected,
      secretValues,
    };
    const summary = await ciAggregate(options);
    const environments = [];
    for (const filename of await fs.readdir(path.join(report, 'results'))) {
      if (!filename.endsWith('-result.json')) continue;
      const result = await jsonFile(path.join(report, 'results', filename));
      const labels = ['os', 'arch', 'node', 'browser', 'lane'];
      const id = labels
        .map((name) => result.labels.find((label) => label.name === name)?.value || 'missing')
        .join('/');
      let environment = environments.find((entry) => entry.id === id);
      if (!environment) {
        environment = { id, failed: 0 };
        environments.push(environment);
      }
      if (['failed', 'broken'].includes(result.status)) environment.failed += 1;
    }
    summary.environments = environments;
    const html = await fs.readFile(path.join(report, 'index.html'));
    const digest = createHash('sha256').update(html).digest('hex');
    const tree = path.join(stage, 'public');
    const target = path.join(tree, identity.path);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(target, 'index.html'), html, { flag: 'wx', mode: 0o600 });
    const publication = { version: 1, identity, created: Date.now(), digest, summary };
    const encoded = JSON.stringify(publication);
    await fs.writeFile(path.join(target, 'publication.json'), encoded, { flag: 'wx', mode: 0o600 });
    // rename refuses to merge into an existing tree; no producer-provided files are copied.
    try {
      await fs.lstat(output);
      throw new Error('Report publication: output already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.rename(tree, output);
    return summary;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

function commentBody(identity, summary, href) {
  const ownership = `<!-- cloakbrowser-report:${identity.run}:${identity.attempt}:${identity.sha} -->`;
  const introduction = `${marker}\n${ownership}\n## Test report\n\nTested SHA: \`${identity.sha}\`\n\n`;
  if (!summary || !href)
    return `${introduction}Public report unavailable or expired.\n\n[Actions run and retained artifacts](${identity.fallback})`;
  const status = summary.missing.length ? 'incomplete' : summary.status;
  const stats = `Status: **${status}**. Total: ${summary.total}; passed: ${summary.passed}; failed: ${summary.failed}; broken: ${summary.broken}; skipped: ${summary.skipped}.`;
  const environments = summary.environments
    .map((entry) => `${entry.id}: ${entry.failed} failed/broken`)
    .join('\n');
  const text = `${introduction}${stats}\n\n[View merged Allure report](${href})\n\nEnvironments:\n\n${environments}\n\nMissing producers: ${summary.missing.length}.\n\n[Actions run and retained artifacts](${identity.fallback})`;
  const safe = sanitizeDiagnostic(text.slice(introduction.length));
  return `${introduction}${safe}`;
}

async function list(api, endpoint, key) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const response = await api('GET', `${endpoint}${separator}per_page=100&page=${page}`);
    const entries = key ? response[key] : response;
    if (!Array.isArray(entries)) throw new Error('Report publication: invalid API collection');
    values.push(...entries);
    if (entries.length < 100) return values;
  }
  throw new Error('Report publication: API collection exceeds limit');
}

/** Fetch current identity immediately before updating only our bot-owned comment. */
export async function updateReportComment(api, identity, summary, href) {
  checkedIdentity(identity);
  if (href) {
    const expected = `https://swimmwatch.github.io/`;
    const url = new URL(href);
    if (!href.startsWith(expected) || url.search || url.hash || !url.pathname.endsWith(`/${identity.path}/`))
      throw new Error('Report publication: unsafe report URL');
  }
  const base = `/repos/${sourceRepository}`;
  const comments = await list(api, `${base}/issues/${identity.pr}/comments`);
  const runs = await list(
    api,
    `${base}/actions/workflows/ci.yml/runs?head_sha=${identity.sha}`,
    'workflow_runs',
  );
  const pr = await api('GET', `${base}/pulls/${identity.pr}`);
  if (!freshPublication(identity, pr, runs, comments)) return 'stale';
  const owned = comments.filter(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      comment.user?.type === 'Bot' &&
      comment.body?.startsWith(marker),
  );
  if (owned.length > 1) throw new Error('Report publication: multiple bot-owned report comments');
  const body = commentBody(identity, summary, href);
  if (owned[0]?.body === body) return 'unchanged';
  if (owned[0]) {
    const id = owned[0].id;
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Report publication: invalid comment identity');
    await api('PATCH', `${base}/issues/comments/${id}`, { body });
  } else await api('POST', `${base}/issues/${identity.pr}/comments`, { body });
  return body;
}

/** Verify successful branch Pages build and the exact regenerated entrypoint. */
export async function verifyPublicReport(api, request, { repository, commit, url, digest }) {
  const base = reportDestination(repository);
  if (!url.startsWith(base) || !/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error('Report publication: invalid deployment identity');
  const build = await api('GET', `/repos/${repository}/pages/builds/latest`);
  if (build.status !== 'built' || build.commit !== commit)
    throw new Error('Report publication: deployment not complete');
  const bytes = await request(url);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) throw new Error('Report publication: entrypoint does not match generated report');
}

/** Delete only expired validated owned report directories, without following links. */
export async function cleanPublicTree(tree, now) {
  const root = await directory(tree);
  const removed = [];
  let visited = 0;
  const visit = async (current, depth) => {
    if (depth > 5 || visited++ > 10000) throw new Error('Report publication: oversized report tree');
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Report publication: symlink in owned tree');
      const target = path.join(current, entry.name);
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (!entry.isDirectory()) continue;
      if (reportPath.test(relative)) {
        const metadata = await jsonFile(path.join(target, 'publication.json'));
        if (metadata.version !== 1 || checkedIdentity(metadata.identity).path !== relative)
          throw new Error('Report publication: wrong retention identity');
        const expired = expiredReports([{ path: relative, created: metadata.created }], now);
        if (expired.length) {
          await fs.rm(target, { recursive: true });
          removed.push(metadata.identity);
        }
      } else await visit(target, depth + 1);
    }
  };
  const owned = path.join(root, 'pr');
  try {
    await fs.lstat(owned);
  } catch (error) {
    if (error.code === 'ENOENT') return removed;
    throw error;
  }
  await directory(owned);
  await visit(owned, 1);
  return removed;
}

async function responseBytes(response, limit) {
  if (!response.ok) throw new Error(`Report publication: HTTP status ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.length;
      if (size > limit) throw new Error('Report publication: oversized response');
      chunks.push(value.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export function githubApi(token, destination, request = fetch) {
  if (!token) throw new Error('Report publication: missing scoped API credential');
  return async (method, endpoint, body) => {
    const prefix = `/repos/${destination || sourceRepository}/`;
    if ((!endpoint.startsWith(prefix) && endpoint !== prefix.slice(0, -1)) || endpoint.includes('..'))
      throw new Error('Report publication: API ownership mismatch');
    if (
      method !== 'GET' &&
      (destination ||
        !['POST', 'PATCH'].includes(method) ||
        !/^\/repos\/swimmwatch\/cloakbrowser-mcp\/issues\/(?:[1-9]\d*\/comments|comments\/[1-9]\d*)$/.test(
          endpoint,
        ))
    )
      throw new Error('Report publication: forbidden API write');
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
    const options = {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      body: body ? JSON.stringify(body) : undefined,
    };
    const response = await request(`https://api.github.com${endpoint}`, options);
    const bytes = await responseBytes(response, 2 * 1024 * 1024);
    return bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
  };
}

async function publicBytes(href) {
  const url = new URL(href);
  if (url.origin !== 'https://swimmwatch.github.io' || url.username || url.password)
    throw new Error('Report publication: unsafe public origin');
  const options = { redirect: 'error', signal: AbortSignal.timeout(15000), cache: 'no-store' };
  const response = await fetch(href, options);
  return responseBytes(response, 32 * 1024 * 1024);
}

async function resolveIdentity(api, id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Report publication: invalid trigger run');
  const base = `/repos/${sourceRepository}`;
  const source = await api('GET', base);
  const workflow = await api('GET', `${base}/actions/workflows/ci.yml`);
  const run = await api('GET', `${base}/actions/runs/${id}`);
  if (
    run.workflow_id !== workflow.id ||
    run.repository?.id !== source.id ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  )
    throw new Error('Report publication: unexpected workflow identity');
  const associations = await list(api, `${base}/commits/${run.head_sha}/pulls`);
  const eligible = associations.filter(
    (pr) =>
      pr.state === 'open' &&
      pr.head?.sha === run.head_sha &&
      pr.head?.repo?.id === run.head_repository?.id &&
      pr.base?.repo?.id === source.id,
  );
  if (eligible.length !== 1) throw new Error('Report publication: no unique current PR association');
  const pr = await api('GET', `${base}/pulls/${eligible[0].number}`);
  return reportIdentity(run, pr, source);
}

async function writeOutput(values) {
  const lines = Object.entries(values)
    .map(([name, value]) => {
      if (!/^[\w-]+$/.test(name) || /[\r\n]/.test(String(value)))
        throw new Error('Report publication: unsafe workflow output');
      return `${name}=${value}\n`;
    })
    .join('');
  await fs.appendFile(process.env.GITHUB_OUTPUT, lines);
}

async function saveState(filename, state) {
  const root = await directory(path.dirname(filename), true);
  const target = path.join(root, path.basename(filename));
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Report publication: unsafe state');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const encoded = JSON.stringify(state);
  await fs.writeFile(target, encoded, { mode: 0o600 });
}

async function finishComment(api, state, available) {
  const summary = available ? state.publication.summary : undefined;
  const href = available ? `${reportDestination(state.repository)}${state.identity.path}/` : undefined;
  const result = await updateReportComment(api, state.identity, summary, href);
  const text = ['stale', 'unchanged'].includes(result) ? `Report comment: ${result}.\n` : result + '\n';
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, text);
}

async function cleanupCommand(api, repository) {
  const tree = await directory(process.env.REPORTS_CHECKOUT);
  const removed = await cleanPublicTree(tree, Date.now());
  if (!removed.length) return;
  const git = promisify(execFile);
  const token = process.env.REPORTS_TOKEN;
  if (!token) throw new Error('Report publication: missing reports-only Git credential');
  const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
  };
  const options = { cwd: tree, env, timeout: 30000, maxBuffer: 1024 * 1024 };
  const remote = await git('git', ['remote', 'get-url', 'origin'], options);
  if (
    remote.stdout.trim() !== `https://github.com/${repository}` &&
    remote.stdout.trim() !== `https://github.com/${repository}.git`
  )
    throw new Error('Report publication: cleanup Git ownership mismatch');
  for (const args of [
    ['-c', 'core.hooksPath=/dev/null', 'add', '-u', '--', 'pr'],
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '-m',
      'chore: expire owned test reports',
    ],
    ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'HEAD:gh-pages'],
  ])
    await git('git', args, options);
  // A cleanup only replaces a pointer to the exact expired run, never a newer comment.
  for (const identity of removed) {
    const comments = await list(api, `/repos/${sourceRepository}/issues/${identity.pr}/comments`);
    const exact = `<!-- cloakbrowser-report:${identity.run}:${identity.attempt}:${identity.sha} -->`;
    const owned = comments.filter(
      (comment) =>
        comment.user?.login === 'github-actions[bot]' &&
        comment.user?.type === 'Bot' &&
        comment.body?.startsWith(marker) &&
        comment.body.includes(exact),
    );
    if (owned.length > 1) throw new Error('Report publication: ambiguous expired comment');
    if (owned[0])
      await api('PATCH', `/repos/${sourceRepository}/issues/comments/${owned[0].id}`, {
        body: commentBody(identity),
      });
  }
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `Expired owned reports: ${removed.length}.\n`);
}

async function main() {
  const [command] = process.argv.slice(2);
  const env = process.env;
  if (env.GITHUB_REPOSITORY !== sourceRepository)
    throw new Error('Report publication: wrong source repository');
  const repository = env.REPORTS_REPOSITORY;
  reportDestination(repository);
  const api = githubApi(env.GITHUB_TOKEN);
  const filename = path.join(env.RUNNER_TEMP, 'cloak-report-publication.json');
  if (command === 'config')
    return writeOutput({ 'repository-name': repository.split('/')[1], owner: repository.split('/')[0] });
  if (command === 'identity') {
    const event = await jsonFile(env.GITHUB_EVENT_PATH);
    const identity = await resolveIdentity(api, event.workflow_run?.id);
    await saveState(filename, { repository, identity });
    return writeOutput({
      'run-id': identity.run,
      'repository-name': repository.split('/')[1],
      owner: repository.split('/')[0],
    });
  }
  if (command === 'cleanup') return cleanupCommand(api, repository);
  const state = await jsonFile(filename);
  if (state.repository !== repository) throw new Error('Report publication: destination changed');
  checkedIdentity(state.identity);
  if (command === 'prepare') {
    const platforms = JSON.parse(env.CLOAK_REPORT_PLATFORMS);
    const nodes = JSON.parse(env.NODE_CHECK_VERSIONS);
    const expected = ciPlan('pr', platforms, nodes);
    const options = {
      input: env.REPORT_INPUT,
      output: env.REPORT_PUBLIC_TREE,
      identity: state.identity,
      expected,
    };
    await preparePublicReport(options);
    state.publication = await jsonFile(
      path.join(env.REPORT_PUBLIC_TREE, state.identity.path, 'publication.json'),
    );
    return saveState(filename, state);
  }
  if (command === 'stage') {
    const tree = await directory(env.REPORTS_CHECKOUT);
    const target = path.join(tree, state.identity.path);
    let exists = false;
    try {
      await fs.lstat(target);
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (exists) {
      await directory(target);
      const previous = await jsonFile(path.join(target, 'publication.json'));
      if (JSON.stringify(checkedIdentity(previous.identity)) !== JSON.stringify(state.identity))
        throw new Error('Report publication: immutable path collision');
      state.publication = previous;
      await saveState(filename, state);
    }
    return writeOutput({ publish: exists ? 'false' : 'true' });
  }
  if (command === 'link') {
    const destinationApi = githubApi(env.REPORTS_TOKEN, repository);
    const reference = await destinationApi('GET', `/repos/${repository}/git/ref/heads/gh-pages`);
    const options = {
      repository,
      commit: reference.object.sha,
      url: `${reportDestination(repository)}${state.identity.path}/`,
      digest: state.publication.digest,
    };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await verifyPublicReport(destinationApi, publicBytes, options);
        return await finishComment(api, state, true);
      } catch {
        if (attempt === 29) throw new Error('Report publication: deployment verification deadline exceeded');
      }
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
  if (command === 'unavailable') return finishComment(api, state, false);
  throw new Error('Report publication: unknown command');
}

const entry = process.argv[1] && path.resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'Report publication failed';
    const message = sanitizeDiagnostic(raw);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
