// The checked-in wrapper compatibility table is the second source of truth for
// the CloakBrowser wrapper pin. It transcribes the bridge's own humanize
// allowlist; a wrapper version outside it silently breaks humanised input, so
// the sync holds rather than guessing.
import { compareVersions, parseVersion } from '../lib/semver.mjs';

const SCHEMA_VERSION = 1;
const UNSTABLE_PATTERN = /[-+]/;

/**
 * Validate a parsed compatibility document.
 *
 * @param {unknown} document Parsed JSON value.
 * @returns {{schemaVersion: number, bridge: Record<string, {cloakbrowser: string[]}>}} Validated table.
 */
export function parseCompatibilityDocument(document) {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('wrapper-compatibility.json must be an object');
  }
  const { schemaVersion, bridge } = /** @type {Record<string, unknown>} */ (document);
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`wrapper-compatibility.json schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (typeof bridge !== 'object' || bridge === null || Array.isArray(bridge)) {
    throw new Error('wrapper-compatibility.json "bridge" must be an object');
  }
  const normalized = {};
  for (const [bridgeVersion, entry] of Object.entries(bridge)) {
    parseVersion(bridgeVersion);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`wrapper-compatibility.json bridge ${bridgeVersion} must be an object`);
    }
    const { cloakbrowser } = /** @type {Record<string, unknown>} */ (entry);
    if (!Array.isArray(cloakbrowser) || cloakbrowser.length === 0) {
      throw new Error(`wrapper-compatibility.json bridge ${bridgeVersion} must list cloakbrowser versions`);
    }
    for (const wrapperVersion of cloakbrowser) {
      if (typeof wrapperVersion !== 'string') {
        throw new Error(`wrapper-compatibility.json bridge ${bridgeVersion} lists a non-string version`);
      }
      parseVersion(wrapperVersion);
    }
    normalized[bridgeVersion] = { cloakbrowser: [...cloakbrowser] };
  }
  return { schemaVersion: SCHEMA_VERSION, bridge: normalized };
}

/**
 * Decide the wrapper pin under an effective bridge version.
 *
 * @param {{currentWrapper: string, bridge: string, table: {bridge: Record<string, {cloakbrowser: string[]}>}}} input Decision inputs.
 * @returns {{decision: 'bump'|'hold', reason: string, bridge: string, target: string, allowed: string[], currentAllowed: boolean}} Verdict.
 */
export function wrapperDecision({ currentWrapper, bridge, table }) {
  const entry = table.bridge[bridge];
  if (entry === undefined) {
    return {
      decision: 'hold',
      reason: 'bridge-not-in-compatibility-table',
      bridge,
      target: currentWrapper,
      allowed: [],
      currentAllowed: true,
    };
  }
  const stable = entry.cloakbrowser.filter((version) => !UNSTABLE_PATTERN.test(version));
  if (stable.length === 0) {
    return {
      decision: 'hold',
      reason: 'no-stable-wrapper-allowed',
      bridge,
      target: currentWrapper,
      allowed: [],
      currentAllowed: false,
    };
  }
  const sorted = [...stable].sort(compareVersions);
  const currentAllowed = sorted.some((version) => compareVersions(version, currentWrapper) === 0);
  const target = sorted.at(-1);
  const common = { bridge, allowed: sorted, currentAllowed };
  if (!currentAllowed) {
    return { decision: 'hold', reason: 'current-wrapper-not-allowed', target: currentWrapper, ...common };
  }
  if (parseVersion(target).major !== parseVersion(currentWrapper).major) {
    return { decision: 'hold', reason: 'held-major-change', target: currentWrapper, ...common };
  }
  if (compareVersions(target, currentWrapper) > 0) {
    return { decision: 'bump', reason: 'within-bridge-allowlist', target, ...common };
  }
  if (compareVersions(target, currentWrapper) === 0) {
    return { decision: 'hold', reason: 'bridge-allowlist', target: currentWrapper, ...common };
  }
  return { decision: 'hold', reason: 'registry-behind', target: currentWrapper, ...common };
}
