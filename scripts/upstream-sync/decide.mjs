// Pin and version-bump decisions. Pure functions only: the caller supplies the
// registry answer and the compatibility table, so the policy is unit-testable
// without a network, a clock or a checkout.
import { compareVersions, parseVersion } from '../lib/semver.mjs';
import { wrapperDecision } from './compatibility.mjs';
import { BUILD_PACKAGE, WRAPPER_PACKAGE } from './constants.mjs';

const UNSTABLE_PATTERN = /[-+]/;

/**
 * Decide whether the MCP bridge pin moves.
 *
 * @param {{current: string, latest: string}} input Current and registry versions.
 * @returns {{decision: 'bump'|'hold'|'none', target: string, latest: string, reason: string}} Verdict.
 */
export function decideBridgePin({ current, latest }) {
  const currentVersion = parseVersion(current).version;
  const latestVersion = parseVersion(latest).version;
  const common = { latest: latestVersion };
  if (UNSTABLE_PATTERN.test(latest)) {
    return { decision: 'hold', target: currentVersion, reason: 'held-prerelease', ...common };
  }
  if (parseVersion(latestVersion).major !== parseVersion(currentVersion).major) {
    return { decision: 'hold', target: currentVersion, reason: 'held-major-change', ...common };
  }
  if (compareVersions(latestVersion, currentVersion) < 0) {
    return { decision: 'hold', target: currentVersion, reason: 'held-registry-behind', ...common };
  }
  if (compareVersions(latestVersion, currentVersion) === 0) {
    return { decision: 'none', target: currentVersion, reason: 'registry-latest-equals-current', ...common };
  }
  return { decision: 'bump', target: latestVersion, reason: 'same-major-bump', ...common };
}

/**
 * Increment a version's patch component.
 *
 * @param {string} version Current version.
 * @returns {string} Patch-bumped version.
 */
export function patchBump(version) {
  const parsed = parseVersion(version);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/**
 * Read the lockstep plugin version from plugin manifests.
 *
 * @param {{plugin: string, version: string}[]} pluginVersions Versions read from every plugin.
 * @returns {string} The shared version.
 */
export function lockstepVersion(pluginVersions) {
  if (pluginVersions.length === 0) {
    throw new Error('no plugin manifests were found');
  }
  const versions = new Set(pluginVersions.map((entry) => parseVersion(entry.version).version));
  if (versions.size !== 1) {
    throw new Error(`plugin versions are not lockstep: ${[...versions].join(', ')}`);
  }
  return [...versions][0];
}

/**
 * Decide every version movement for one sync run.
 *
 * Order matters: the wrapper is looked up under the *new* bridge, because a new
 * bridge may widen the allowlist. The plugin version moves only when a pin does.
 *
 * @param {{currentPins: {bridge: string, wrapper: string, pluginVersions: {plugin: string, version: string}[]}, latestBridge: string, compatibility: {bridge: Record<string, {cloakbrowser: string[]}>}, now?: () => Date}} input Decision inputs.
 * @returns {object} A JSON-serialisable pin report.
 */
export function decideSync({ currentPins, latestBridge, compatibility, now = () => new Date() }) {
  const pluginCurrent = lockstepVersion(currentPins.pluginVersions);
  const bridge = decideBridgePin({ current: currentPins.bridge, latest: latestBridge });
  const effectiveBridge = bridge.decision === 'bump' ? bridge.target : currentPins.bridge;
  const wrapper = wrapperDecision({
    currentWrapper: currentPins.wrapper,
    bridge: effectiveBridge,
    table: compatibility,
  });
  const changed = bridge.target !== currentPins.bridge || wrapper.target !== currentPins.wrapper;
  const pluginVersion = changed
    ? {
        current: pluginCurrent,
        target: patchBump(pluginCurrent),
        decision: 'bump',
        reason: 'pin-change-patch-bump',
      }
    : {
        current: pluginCurrent,
        target: pluginCurrent,
        decision: 'none',
        reason: 'no-pin-change',
      };
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    changed,
    bridge: { package: BUILD_PACKAGE, current: currentPins.bridge, ...bridge },
    wrapper: { package: WRAPPER_PACKAGE, current: currentPins.wrapper, ...wrapper },
    pluginVersion,
  };
}
