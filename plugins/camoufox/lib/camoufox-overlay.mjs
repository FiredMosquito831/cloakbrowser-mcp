// Windows overlay of the installed Camoufox build (2.16.0).
//
// The pinned Camoufox build locks Firefox's login manager off through its own
// `distribution/policies.json`. Launch prefs lose to that lock and the build has
// no readable per-user policy directory on Windows, so the only surgical route
// is an executable whose own install directory carries the policy: a plugin-owned
// overlay tree that shares every heavy byte with the machine-wide build.
//
// The proven recipe (2026-10-26 investigation):
//   - `distribution/` is a REAL directory, copied from the build, holding the
//     build's own policy document with only PasswordManagerEnabled and
//     OfferToSaveLogins true;
//   - every other top-level directory is a junction to the build;
//   - every top-level file is a hardlink on the same volume, or a copy when the
//     volumes differ (hardlinks fail with EXDEV across volumes);
//   - `overlay.json` is written last and is the ownership proof.
//
// Nothing here hashes or copies the whole 2.4 GB build, nothing writes into the
// source build, and a tree without our marker is never used, overwritten or
// removed. Node's recursive removal deletes junction entries, not their targets.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const OVERLAY_ROOT_NAME = 'camoufox-overlay';
export const OVERLAY_MARKER_FILENAME = 'overlay.json';
export const OVERLAY_MARKER_VERSION = 1;
export const OVERLAY_FORMAT = 1;
export const OVERLAY_ENGINE = 'camoufox';
export const OVERLAY_DISTRIBUTION_DIR = 'distribution';
export const OVERLAY_SOURCE_POLICY_PARTS = Object.freeze(['distribution', 'policies.json']);
export const OVERLAY_FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
export const OVERLAY_STALE_TEMP_MS = 60 * 60 * 1000;
export const OVERLAY_LINK_FALLBACK_CODES = Object.freeze([
  'EXDEV',
  'EPERM',
  'EACCES',
  'ENOSYS',
  'EINVAL',
  'EMLINK',
  'ENOTSUP',
]);
const LINK_FALLBACK = new Set(OVERLAY_LINK_FALLBACK_CODES);
const TEMP_NAME_PATTERN = /\.tmp-\d+-[0-9a-f]+$/iu;

export class OverlayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OverlayError';
    this.code = code;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Windows path semantics: case-insensitive, resolved. The overlay is Windows-only,
// but the unit suite runs on every CI platform against real temporary directories,
// so the comparison follows the host: on Windows two spellings of one path match.
function foldPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function sameOverlayPath(left, right) {
  if (!nonEmptyString(left) || !nonEmptyString(right)) {
    return false;
  }
  return foldPath(left) === foldPath(right);
}

// Containment, not equality: the target must be strictly inside `root`.
export function isPathInsideOverlayRoot(root, candidate) {
  if (!nonEmptyString(root) || !nonEmptyString(candidate)) {
    return false;
  }
  const foldedRoot = foldPath(root);
  const foldedCandidate = foldPath(candidate);
  return foldedCandidate.startsWith(`${foldedRoot}${path.sep}`) && foldedCandidate !== foldedRoot;
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  try {
    return sha256(readFileSync(file));
  } catch {
    return null;
  }
}

export function readJsonFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8').replace(/^﻿/u, '');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function writeFileAtomic(target, text) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8' });
    renameSync(temporary, target);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // A leftover temp file is harmless and never read; never mask the write.
    }
  }
}

export function overlayRoot(pluginDataDir) {
  return path.join(pluginDataDir, OVERLAY_ROOT_NAME);
}

// One directory per resolved build; the source directory basename already carries
// the build version and its hash, so a pin change naturally gets a new directory.
export function overlayTarget(pluginDataDir, buildDir) {
  return path.join(overlayRoot(pluginDataDir), path.basename(path.resolve(buildDir)));
}

export function overlayPolicyPath(overlayDir) {
  return path.join(overlayDir, ...OVERLAY_SOURCE_POLICY_PARTS);
}

export function overlayExecutablePath(overlayDir) {
  return path.join(overlayDir, 'camoufox.exe');
}

export function isRealDirectory(candidate) {
  try {
    const stats = lstatSync(candidate);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

export function availableBytes(directory) {
  try {
    const stats = statfsSync(directory);
    const unit = Number(stats.bsize);
    const free = Number(stats.bavail ?? stats.bfree);
    if (Number.isFinite(unit) && Number.isFinite(free) && unit > 0) {
      return unit * free;
    }
    return null;
  } catch {
    return null;
  }
}

function safeEntryName(name) {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

// The ownership marker. Anything that is not a marker this plugin wrote is
// foreign: never used, never overwritten, never removed.
export function readOverlayMarker(target) {
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { state: 'missing', marker: null, reason: null };
    }
    return { state: 'foreign', marker: null, reason: 'the overlay path cannot be read' };
  }
  if (stats.isSymbolicLink()) {
    return { state: 'foreign', marker: null, reason: 'the overlay path is itself a link' };
  }
  if (!stats.isDirectory()) {
    return { state: 'foreign', marker: null, reason: 'the overlay path is not a directory' };
  }
  const marker = readJsonFile(path.join(target, OVERLAY_MARKER_FILENAME));
  if (!isPlainObject(marker)) {
    return { state: 'foreign', marker: null, reason: 'the overlay has no readable marker' };
  }
  if (marker.engine !== OVERLAY_ENGINE) {
    return { state: 'foreign', marker: null, reason: 'the marker names another engine' };
  }
  if (!Number.isInteger(marker.version) || marker.version < 1) {
    return { state: 'foreign', marker: null, reason: 'the marker version is not recognised' };
  }
  if (!Number.isInteger(marker.pluginOverlayFormat) || marker.pluginOverlayFormat < 1) {
    return { state: 'foreign', marker: null, reason: 'the overlay format is not recognised' };
  }
  return { state: 'ours', marker, reason: null };
}

// Top-level shape of a build: every file and directory the launch reads beside
// the executable. `distribution` is ours to copy; everything else is linked.
export function planOverlay(sourceDir) {
  if (!isRealDirectory(sourceDir)) {
    throw new OverlayError('source', `the Camoufox build directory ${sourceDir} is not a directory`);
  }
  let entries;
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw new OverlayError(
      'source',
      `the Camoufox build directory ${sourceDir} cannot be read (${error?.code ?? error.message})`,
    );
  }
  const files = [];
  const directories = [];
  let distribution = false;
  for (const entry of entries) {
    if (!safeEntryName(entry.name)) {
      throw new OverlayError(
        'source',
        `the Camoufox build has an unusable top-level name ${JSON.stringify(entry.name)}`,
      );
    }
    if (entry.name === OVERLAY_MARKER_FILENAME) {
      throw new OverlayError(
        'source',
        `the Camoufox build already carries ${OVERLAY_MARKER_FILENAME}, which the overlay uses for its own marker`,
      );
    }
    if (entry.name === OVERLAY_DISTRIBUTION_DIR) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        throw new OverlayError(
          'source',
          'the Camoufox build has a distribution entry that is not a directory',
        );
      }
      distribution = true;
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      directories.push({ name: entry.name });
      continue;
    }
    if (entry.isFile()) {
      let stats;
      try {
        stats = statSync(path.join(sourceDir, entry.name));
      } catch (error) {
        throw new OverlayError(
          'source',
          `cannot read ${entry.name} in the Camoufox build (${error?.code ?? error.message})`,
        );
      }
      files.push({ name: entry.name, size: stats.size, mtimeMs: stats.mtimeMs });
      continue;
    }
    throw new OverlayError('source', `the Camoufox build has an unsupported top-level entry ${entry.name}`);
  }
  if (!distribution) {
    throw new OverlayError('source', 'the Camoufox build has no distribution directory');
  }
  if (!files.some((file) => file.name === 'camoufox.exe')) {
    throw new OverlayError('source', 'the Camoufox build has no camoufox.exe');
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return { files, directories, distribution, totalBytes };
}

function ensureCopyBudget(remainingBytes, directory, freeBytes, marginBytes) {
  const free = freeBytes(directory);
  if (free === null || free === undefined) {
    return;
  }
  if (free < remainingBytes + marginBytes) {
    throw new OverlayError(
      'space',
      `not enough free space to copy the build files: ${Math.ceil(remainingBytes / (1024 * 1024))} MiB are ` +
        `needed plus a ${Math.ceil(marginBytes / (1024 * 1024))} MiB margin, and ` +
        `${Math.floor(free / (1024 * 1024))} MiB are free`,
    );
  }
}

// Build one overlay tree in `tempDir`. The marker is written last, after the
// policy and every link, so a crashed build never looks like a usable overlay.
export function createOverlay(options) {
  const {
    sourceDir,
    tempDir,
    probePolicyText,
    markerBase,
    link = linkSync,
    copy = copyFileSync,
    junction = symlinkSync,
    freeBytes = availableBytes,
    minFreeBytes = OVERLAY_FREE_SPACE_MARGIN_BYTES,
  } = options;
  const plan = planOverlay(sourceDir);
  mkdirSync(tempDir, { recursive: true });
  const distributionSource = path.join(sourceDir, OVERLAY_DISTRIBUTION_DIR);
  const distributionTarget = path.join(tempDir, OVERLAY_DISTRIBUTION_DIR);
  try {
    cpSync(distributionSource, distributionTarget, { recursive: true, dereference: false, force: true });
  } catch (error) {
    throw new OverlayError(
      'distribution',
      `cannot copy the build's distribution directory (${error?.code ?? error.message})`,
    );
  }
  const junctionRecords = [];
  for (const entry of plan.directories) {
    const target = path.join(sourceDir, entry.name);
    const destination = path.join(tempDir, entry.name);
    try {
      junction(target, destination, 'junction');
    } catch (error) {
      throw new OverlayError(
        'junction',
        `cannot link the build directory ${entry.name} (${error?.code ?? error.message}); the overlay needs ` +
          'junctions and will not copy the whole build',
      );
    }
    junctionRecords.push({ name: entry.name, target: path.resolve(target) });
  }
  const fileRecords = [];
  let copiedAny = false;
  let copyBudget = null;
  for (const file of plan.files) {
    const source = path.join(sourceDir, file.name);
    const destination = path.join(tempDir, file.name);
    let linked = true;
    try {
      link(source, destination);
    } catch (error) {
      if (!LINK_FALLBACK.has(error?.code)) {
        throw new OverlayError('link', `cannot hardlink ${file.name} (${error?.code ?? error.message})`);
      }
      linked = false;
      if (copyBudget === null) {
        copyBudget = plan.totalBytes;
        ensureCopyBudget(copyBudget, tempDir, freeBytes, minFreeBytes);
      }
      try {
        copy(source, destination);
      } catch (copyError) {
        throw new OverlayError('copy', `cannot copy ${file.name} (${copyError?.code ?? copyError.message})`);
      }
      try {
        const stats = statSync(source);
        utimesSync(destination, stats.atime, stats.mtime);
      } catch {
        // The recorded size/mtime still decide the integrity check below.
      }
    }
    let stats;
    try {
      stats = statSync(destination);
    } catch (error) {
      throw new OverlayError(
        'link',
        `the overlay entry ${file.name} was not created (${error?.code ?? error.message})`,
      );
    }
    if (linked) {
      fileRecords.push({
        name: file.name,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        link: true,
        ino: String(stats.ino),
        dev: String(stats.dev),
      });
    } else {
      copiedAny = true;
      fileRecords.push({ name: file.name, size: stats.size, mtimeMs: stats.mtimeMs, link: false });
    }
  }
  writeFileAtomic(overlayPolicyPath(tempDir), probePolicyText);
  const marker = {
    ...markerBase,
    mode: copiedAny ? 'copy' : 'hardlink',
    files: fileRecords,
    junctions: junctionRecords,
  };
  writeFileAtomic(path.join(tempDir, OVERLAY_MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

// Integrity, cheap: no file is hashed except the two small policy documents.
// Any mismatch on a tree carrying our marker means rebuild; a tree without a
// marker never reaches this function.
export function inspectOverlay(options) {
  const { target, marker, sourceDir, sourcePolicyHash, managedPolicyHash, probePolicyHash } = options;
  if (!isPlainObject(marker)) {
    return { ok: false, reason: 'the overlay marker is unreadable' };
  }
  if (marker.version !== OVERLAY_MARKER_VERSION) {
    return { ok: false, reason: 'the overlay marker version changed' };
  }
  if (marker.pluginOverlayFormat !== OVERLAY_FORMAT) {
    return { ok: false, reason: 'the overlay format changed' };
  }
  if (!sameOverlayPath(marker.sourceBuild, sourceDir)) {
    return { ok: false, reason: 'the overlay was built from a different Camoufox build' };
  }
  const sourcePolicy = path.join(sourceDir, ...OVERLAY_SOURCE_POLICY_PARTS);
  if (sha256File(sourcePolicy) !== sourcePolicyHash) {
    return { ok: false, reason: 'the Camoufox build policy changed' };
  }
  if (!isRealDirectory(target)) {
    return { ok: false, reason: 'the overlay is not a real directory' };
  }
  const policyFile = overlayPolicyPath(target);
  const policyHash = sha256File(policyFile);
  let needsFinalPolicy = false;
  if (policyHash === managedPolicyHash) {
    needsFinalPolicy = false;
  } else if (nonEmptyString(probePolicyHash) && policyHash === probePolicyHash) {
    needsFinalPolicy = true;
  } else {
    return { ok: false, reason: 'the overlay policy file changed' };
  }
  if (!existsSync(overlayExecutablePath(target))) {
    return { ok: false, reason: 'the overlay has no camoufox.exe' };
  }
  const files = Array.isArray(marker.files) ? marker.files : [];
  if (files.length === 0) {
    return { ok: false, reason: 'the overlay marker lists no files' };
  }
  for (const file of files) {
    if (!isPlainObject(file) || !safeEntryName(file.name)) {
      return { ok: false, reason: 'the overlay marker lists an unusable file name' };
    }
    const destination = path.join(target, file.name);
    let stats;
    try {
      stats = statSync(destination);
    } catch {
      return { ok: false, reason: `the overlay file ${file.name} is missing` };
    }
    if (!stats.isFile()) {
      return { ok: false, reason: `the overlay entry ${file.name} is not a file` };
    }
    if (stats.size !== file.size) {
      return { ok: false, reason: `the overlay file ${file.name} changed size` };
    }
    if (typeof file.mtimeMs === 'number' && Math.abs(stats.mtimeMs - file.mtimeMs) > 2) {
      return { ok: false, reason: `the overlay file ${file.name} changed` };
    }
    if (file.link === true) {
      let sourceStats;
      try {
        sourceStats = statSync(path.join(sourceDir, file.name));
      } catch {
        return { ok: false, reason: `the source build file ${file.name} is gone` };
      }
      if (String(sourceStats.dev) !== String(stats.dev) || String(sourceStats.ino) !== String(stats.ino)) {
        return { ok: false, reason: `the overlay file ${file.name} no longer shares the build's file` };
      }
    }
  }
  const junctions = Array.isArray(marker.junctions) ? marker.junctions : [];
  for (const junctionEntry of junctions) {
    if (!isPlainObject(junctionEntry) || !safeEntryName(junctionEntry.name)) {
      return { ok: false, reason: 'the overlay marker lists an unusable directory name' };
    }
    const linkPath = path.join(target, junctionEntry.name);
    let stats;
    try {
      stats = lstatSync(linkPath);
    } catch {
      return { ok: false, reason: `the overlay directory ${junctionEntry.name} is missing` };
    }
    if (!stats.isSymbolicLink()) {
      return { ok: false, reason: `the overlay entry ${junctionEntry.name} is no longer a junction` };
    }
    let actual;
    try {
      actual = readlinkSync(linkPath);
    } catch {
      return { ok: false, reason: `the overlay directory ${junctionEntry.name} cannot be read` };
    }
    if (!sameOverlayPath(actual, junctionEntry.target)) {
      return { ok: false, reason: `the overlay directory ${junctionEntry.name} points somewhere else` };
    }
  }
  return { ok: true, reason: null, needsFinalPolicy };
}

function defaultRemove(target) {
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// Replace `target` with `tempDir` atomically as far as Windows allows: build in a
// sibling, move the old tree aside (never force), rename the new one in, then
// remove the old tree best-effort. A browser holding the old tree leaves it in
// place and is reported by the caller.
export function swapOverlay(options) {
  const { tempDir, target, readMarker = readOverlayMarker, rm = defaultRemove, log = () => {} } = options;
  let old = null;
  const hadTarget = readMarker(target).state !== 'missing';
  if (hadTarget) {
    old = `${target}.old-${process.pid}`;
    try {
      renameSync(target, old);
    } catch (error) {
      throw new OverlayError(
        'swap',
        `cannot move the existing overlay aside (${error?.code ?? error.message}); it may be in use by a running browser`,
      );
    }
  }
  try {
    renameSync(tempDir, target);
  } catch (error) {
    if (old !== null) {
      try {
        renameSync(old, target);
      } catch {
        // Another start may already have produced a usable target; checked below.
      }
    }
    if (readMarker(target).state === 'ours') {
      try {
        rm(tempDir);
      } catch {
        // A leftover temp tree is pruned by age on a later start.
      }
      return { reused: true };
    }
    throw new OverlayError(
      'swap',
      `cannot move the new overlay into place (${error?.code ?? error.message})`,
    );
  }
  if (old !== null) {
    try {
      rm(old);
    } catch (error) {
      log(
        `the previous overlay ${old} is still in use (${error?.code ?? error.message}); it is left in place`,
      );
    }
  }
  return { reused: false };
}

// Remove one overlay only when it is a real directory strictly inside the plugin
// overlay root and its marker is this plugin's. Never a reparse point, never a
// foreign tree, never forced: an in-use tree is left and reported.
export function removeOverlay(options) {
  const { target, pluginDataDir, rm = defaultRemove } = options;
  if (!isPathInsideOverlayRoot(overlayRoot(pluginDataDir), target)) {
    return { removed: false, reason: 'the path is not inside the plugin overlay directory' };
  }
  const state = readOverlayMarker(target);
  if (state.state === 'missing') {
    return { removed: true, reason: null };
  }
  if (state.state !== 'ours') {
    return { removed: false, reason: state.reason ?? 'the overlay is not this plugin’s' };
  }
  try {
    rm(target);
    return { removed: true, reason: null };
  } catch (error) {
    return {
      removed: false,
      reason: `the overlay is in use or cannot be removed (${error?.code ?? error.message})`,
    };
  }
}

function markerCreatedAt(marker) {
  return marker !== null && typeof marker.createdAt === 'string' ? marker.createdAt : '';
}

// Keep the current overlay and `keepCount` previous builds; remove older trees
// only when their marker is ours. An in-use tree is left and named, never forced.
export function pruneOverlays(options) {
  const { pluginDataDir, currentName, keepCount = 1, rm = defaultRemove, log = () => {} } = options;
  const root = overlayRoot(pluginDataDir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed: [], kept: [], failed: [] };
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === currentName || TEMP_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    const target = path.join(root, entry.name);
    const state = readOverlayMarker(target);
    if (state.state !== 'ours') {
      continue;
    }
    candidates.push({ name: entry.name, target, createdAt: markerCreatedAt(state.marker) });
  }
  candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const kept = candidates.slice(0, keepCount).map((candidate) => candidate.name);
  const removed = [];
  const failed = [];
  for (const candidate of candidates.slice(keepCount)) {
    try {
      rm(candidate.target);
      removed.push(candidate.name);
    } catch (error) {
      failed.push({ name: candidate.name, reason: `${error?.code ?? error.message}` });
      log(
        `the previous overlay ${candidate.name} is still in use or cannot be removed ` +
          `(${error?.code ?? error.message}); it is left in place`,
      );
    }
  }
  return { removed, kept, failed };
}

// A build interrupted between the marker write and the rename leaves a temp
// sibling with our own name and no guarantee of a marker. Only such names, only
// real directories, only inside our root, and only after an hour are removed.
export function cleanStaleTemps(options) {
  const {
    pluginDataDir,
    olderThanMs = OVERLAY_STALE_TEMP_MS,
    now = Date.now(),
    rm = defaultRemove,
  } = options;
  const root = overlayRoot(pluginDataDir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed: [] };
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TEMP_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    const target = path.join(root, entry.name);
    let stats;
    try {
      stats = lstatSync(target);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (now - stats.mtimeMs < olderThanMs) {
      continue;
    }
    try {
      rm(target);
      removed.push(entry.name);
    } catch {
      // An in-use temp is left; a later start retries.
    }
  }
  return { removed };
}
