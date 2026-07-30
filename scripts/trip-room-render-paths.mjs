import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 95 * 1024 * 1024;

function fail(label) {
  throw new Error(`Invalid Trip Room ${label}`);
}

function safeSegment(value, label) {
  const segment = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) fail(label);
  return segment;
}

function repositoryPath(rootPath, relativePath, label) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail(label);
  const root = path.resolve(rootPath);
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(label);
  return { relativePath: normalized, absolutePath: absolute };
}

function containedRepositoryPath(rootPath, candidatePath, label) {
  const relative = path.relative(rootPath, candidatePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(label);
  }
  return relative;
}

async function checkedOutRepositoryRoot(rootPath, label) {
  const root = path.resolve(rootPath);
  let details;
  try {
    details = await lstat(root);
  } catch {
    fail(label);
  }
  if (!details.isDirectory() || details.isSymbolicLink()) fail(label);
  try {
    return await realpath(root);
  } catch {
    fail(label);
  }
}

export async function validateCheckedOutRepositoryFile({
  rootPath = process.cwd(),
  relativePath,
  label = 'repository file'
}) {
  const candidate = repositoryPath(rootPath, relativePath, label);
  const repositoryRoot = await checkedOutRepositoryRoot(rootPath, label);
  let current = repositoryRoot;
  const segments = candidate.relativePath.split('/');
  let details;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      details = await lstat(current);
    } catch {
      fail(label);
    }
    if (details.isSymbolicLink()) fail(label);
    if (index < segments.length - 1 && !details.isDirectory()) fail(label);
    if (index === segments.length - 1 && !details.isFile()) fail(label);
    let resolved;
    try {
      resolved = await realpath(current);
    } catch {
      fail(label);
    }
    containedRepositoryPath(repositoryRoot, resolved, label);
  }
  return {
    relativePath: candidate.relativePath,
    absolutePath: current,
    size: details.size
  };
}

export async function prepareValidatedRepositoryOutput({
  rootPath = process.cwd(),
  relativePath
}) {
  const label = 'output path';
  const candidate = repositoryPath(rootPath, relativePath, label);
  const repositoryRoot = await checkedOutRepositoryRoot(rootPath, label);
  const segments = candidate.relativePath.split('/');
  const filename = segments.pop();
  let current = repositoryRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') fail(label);
      try {
        await mkdir(current);
        details = await lstat(current);
      } catch {
        fail(label);
      }
    }
    if (!details.isDirectory() || details.isSymbolicLink()) fail(label);
    let resolved;
    try {
      resolved = await realpath(current);
    } catch {
      fail(label);
    }
    containedRepositoryPath(repositoryRoot, resolved, label);
  }

  const outputFile = path.join(current, filename);
  let outputExists = false;
  try {
    await lstat(outputFile);
    outputExists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') fail(label);
  }
  if (outputExists) fail(label);
  containedRepositoryPath(repositoryRoot, outputFile, label);
  return {
    relativePath: candidate.relativePath,
    absolutePath: outputFile
  };
}

export function validateRenderManifestCandidate({
  manifestPath,
  rootPath = process.cwd()
}) {
  const candidate = repositoryPath(rootPath, manifestPath, 'manifest path');
  if (!/^data\/trip-room-video-renders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.json$/.test(candidate.relativePath)) {
    fail('manifest path');
  }
  return {
    manifestPath: candidate.relativePath,
    manifestFile: candidate.absolutePath
  };
}

function safeRepositoryIdentity(repository) {
  const match = String(repository || '').match(/^([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/);
  if (!match) fail('scene source');
  return { owner: match[1], repo: match[2] };
}

function safeSourcePath(rawPath) {
  const raw = String(rawPath || '');
  if (!raw || raw.includes('\\')) fail('scene source');
  const decoded = raw.split('/').map(segment => {
    if (!segment) fail('scene source');
    let value;
    try {
      value = decodeURIComponent(segment);
    } catch {
      fail('scene source');
    }
    if (
      !value
      || value === '.'
      || value === '..'
      || value.includes('/')
      || value.includes('\\')
      || value.includes('?')
      || value.includes('#')
      || /[\u0000-\u001f\u007f]/.test(value)
      || /%[0-9a-f]{2}/i.test(value)
    ) {
      fail('scene source');
    }
    return value;
  });
  return decoded.join('/');
}

export function validateRenderSceneSource({
  sourceUrl,
  bookingId,
  repository,
  branch,
  rootPath = process.cwd()
}) {
  const safeBookingId = safeSegment(bookingId, 'scene source');
  const target = safeRepositoryIdentity(repository);
  const safeBranch = safeSegment(branch, 'scene source');
  let parsed;
  try {
    parsed = new URL(String(sourceUrl || ''));
  } catch {
    fail('scene source');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
  ) {
    fail('scene source');
  }

  let rawPath = '';
  if (parsed.hostname === `${target.owner.toLowerCase()}.github.io`) {
    if (safeBranch !== 'main') fail('scene source');
    const repositoryPrefix = `/${target.repo}/`;
    if (!parsed.pathname.startsWith(repositoryPrefix)) fail('scene source');
    rawPath = parsed.pathname.slice(repositoryPrefix.length);
  } else if (parsed.hostname === 'raw.githubusercontent.com') {
    const repositoryPrefix = `/${target.owner}/${target.repo}/${safeBranch}/`;
    if (!parsed.pathname.startsWith(repositoryPrefix)) fail('scene source');
    rawPath = parsed.pathname.slice(repositoryPrefix.length);
  } else {
    fail('scene source');
  }

  const sourcePath = safeSourcePath(rawPath);
  const expectedPrefix = `assets/bookings/${safeBookingId}/captains-log/`;
  if (!sourcePath.startsWith(expectedPrefix) || sourcePath.length === expectedPrefix.length) {
    fail('scene source');
  }
  const checkedOut = repositoryPath(rootPath, sourcePath, 'scene source');
  return {
    sourcePath: checkedOut.relativePath,
    sourceFile: checkedOut.absolutePath
  };
}

export function validateRenderOutputBytes(value) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail('output size');
  if (bytes > MAX_OUTPUT_BYTES) {
    throw new Error('Output media exceeds the 95 MiB render boundary');
  }
  return bytes;
}

export function validateRenderPaths({ manifestPath, manifest, rootPath = process.cwd() }) {
  const bookingId = safeSegment(manifest?.bookingId, 'booking identity');
  const renderId = safeSegment(manifest?.id, 'render identity');
  const safeManifest = repositoryPath(rootPath, manifestPath, 'manifest path');
  const safeOutput = repositoryPath(rootPath, manifest?.outputPath, 'output path');
  const expectedManifest = `data/trip-room-video-renders/${bookingId}/${renderId}.json`;
  const expectedOutput = `assets/bookings/${bookingId}/trip-room-videos/${renderId}.mp4`;
  if (safeManifest.relativePath !== expectedManifest) fail('manifest path');
  if (safeOutput.relativePath !== expectedOutput) fail('output path');
  return {
    manifestPath: safeManifest.relativePath,
    manifestFile: safeManifest.absolutePath,
    outputPath: safeOutput.relativePath,
    outputFile: safeOutput.absolutePath,
    bookingId,
    renderId
  };
}

export function validatePendingRenderManifest(options) {
  const { manifest } = options;
  if (
    manifest?.schemaVersion !== 1
    || manifest?.status !== 'pending'
    || !Array.isArray(manifest?.scenes)
    || manifest.scenes.length < 1
    || manifest.scenes.length > 6
  ) {
    fail('manifest eligibility');
  }
  return validateRenderPaths(options);
}

function validateTerminalRenderManifest(options) {
  if (!['completed', 'failed'].includes(options.manifest?.status)) {
    fail('manifest terminal status');
  }
  return validateRenderPaths(options);
}

export async function readValidatedRenderManifest({
  manifestPath,
  rootPath = process.cwd(),
  readFileImpl = readFile
}) {
  const candidate = validateRenderManifestCandidate({ manifestPath, rootPath });
  const checkedOut = await validateCheckedOutRepositoryFile({
    rootPath,
    relativePath: candidate.manifestPath,
    label: 'manifest path'
  });
  let manifest;
  try {
    manifest = JSON.parse(await readFileImpl(checkedOut.absolutePath, 'utf8'));
  } catch {
    fail('manifest');
  }
  const paths = validateRenderPaths({
    manifestPath: candidate.manifestPath,
    manifest,
    rootPath
  });
  return { manifest, paths };
}

async function runGit(args, { rootPath, stdio }) {
  return await new Promise(resolveRun => {
    const child = spawn('git', args, { cwd: rootPath, stdio });
    child.on('error', () => resolveRun(127));
    child.on('exit', code => resolveRun(Number.isInteger(code) ? code : 1));
  });
}

export async function pushRenderCommit({
  branch,
  rootPath = process.cwd(),
  attempts = 3,
  stdio = 'inherit'
}) {
  const safeBranch = safeSegment(branch, 'render branch');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) fail('push attempts');
  const remoteTrackingRef = `refs/remotes/origin/${safeBranch}`;
  const fetchRefspec = `refs/heads/${safeBranch}:${remoteTrackingRef}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await runGit(['fetch', 'origin', fetchRefspec], { rootPath, stdio }) !== 0) continue;
    if (await runGit(['rebase', remoteTrackingRef], { rootPath, stdio }) !== 0) {
      await runGit(['rebase', '--abort'], { rootPath, stdio: 'ignore' });
      throw new Error('Render commit conflicts with newer repository state');
    }
    if (await runGit(['push', 'origin', `HEAD:${safeBranch}`], { rootPath, stdio }) === 0) return;
  }
  throw new Error(`Could not publish the render commit after ${attempts} attempts`);
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error('Usage: node scripts/trip-room-render-paths.mjs <manifest.json>');
  if (manifestPath === '--push-render-commit') {
    await pushRenderCommit({ branch: process.argv[3] });
    return;
  }
  const mode = process.argv[3] || '--output';
  const { manifest } = await readValidatedRenderManifest({ manifestPath });
  const options = { manifestPath, manifest };
  if (mode === '--pending') {
    process.stdout.write(validatePendingRenderManifest(options).outputPath);
    return;
  }
  if (mode === '--terminal') {
    process.stdout.write(validateTerminalRenderManifest(options).outputPath);
    return;
  }
  if (mode === '--status') {
    validateTerminalRenderManifest(options);
    process.stdout.write(manifest.status);
    return;
  }
  if (mode === '--id') {
    process.stdout.write(validateRenderPaths(options).renderId);
    return;
  }
  if (mode !== '--output') fail('manifest command');
  process.stdout.write(validateRenderPaths(options).outputPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
