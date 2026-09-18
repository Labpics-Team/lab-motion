/**
 * Trusted PROFILE-01 pilot admission record.
 *
 * A pilot is intentionally not trusted merely because it is well-shaped or
 * self-identifies a commit SHA. The first real admissible pilot must be
 * content-addressed here in a reviewed commit after acquisition. Until then
 * candidate admission is fail-closed.
 */
export const PROFILE_PILOT_REGISTRATION = Object.freeze({
  schemaVersion: 1,
  profileId: 'r11-profile-20260915-v1',
  baselineRevision: 'fe11daa407de396fad952be7679650f63dabd4dd',
  status: 'UNREGISTERED',
  pilotId: null,
  pilotArtifactSha256: null,
  harnessRevision: null,
  evidencePath: null,
});
