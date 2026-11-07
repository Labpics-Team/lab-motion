import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// TEST launcher only; public transition runner has no dependency on this host policy.
export const TRANSITION_CONTRACT_LIMITS = Object.freeze({ runtimeMs: 180_000, startupMs: 15_000, stopMs: 10_000, reportMs: 5_000 });

export function assertTransitionContractHost() {
  if (process.platform !== 'linux') throw new Error('Transition contract launcher requires hosted Ubuntu 24.04 systemd/cgroup v2');
  const controllers = readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8');
  const membership = readFileSync('/proc/self/cgroup', 'utf8');
  assert.ok(controllers.trim().length > 0, 'Unified cgroup v2 controllers required');
  assert.ok(/^0::\//m.test(membership), 'Unified cgroup v2 membership required');
  const manager = execFileSync('sudo', ['-n', 'systemctl', '--system', 'show', '--property=Version', '--value'], {
    encoding: 'utf8', timeout: TRANSITION_CONTRACT_LIMITS.startupMs,
  });
  const match = /^(\d+)(?:\.\S+)?$/.exec(manager.trim());
  const version = match ? Number(match[1]) : NaN;
  assert.ok(Number.isSafeInteger(version) && version >= 255, 'systemd >=255 required; malformed version rejected; no fallback');
  return { platform: 'linux', systemdVersion: version, cgroupVersion: 2, managerRaw: manager, controllersRaw: controllers, membershipRaw: membership };
}
