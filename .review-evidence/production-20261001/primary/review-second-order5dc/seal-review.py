from pathlib import Path
import hashlib
import json
import re
from datetime import datetime, timezone

OUT = Path('/workspace/scratch/server-method-second-order-final-20261001/closure-144242Z')
PACKET = Path('/workspace/scratch/motion-server-method-final-20261001T144242Z')
BASE = OUT.parent
OLD_PACKET = Path('/workspace/scratch/motion-server-method-final-20261001T105048Z')
manifest = json.loads((PACKET / 'manifest.json').read_text())
old_manifest = json.loads((OLD_PACKET / 'manifest.json').read_text())
prior = json.loads((BASE / 'closure-105048Z/readset.json').read_text())
prior_by_source = {row['path'].split('/source/', 1)[1]: row for row in prior['files'] if '/source/' in row['path']}

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        while block := f.read(1024 * 1024):
            h.update(block)
    return {'sha256': h.hexdigest(), 'bytes': path.stat().st_size}

def write(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def packet_entry(relative, role, scope, read_mode='fresh selected read', already_verified=False):
    path = PACKET / relative
    binding = manifest['files'].get(relative)
    actual = dict(binding) if already_verified and binding else digest(path)
    if binding:
        assert actual == binding, relative
    value = {'path': str(path), 'role': role, 'reviewScope': scope, 'readMode': read_mode, **actual}
    if binding:
        value['manifestBinding'] = dict(binding)
    else:
        value['rootReceiptNotSelfListedInManifest'] = relative == 'receipt.json'
    if already_verified:
        value['byteVerificationReceipt'] = str(OUT / 'immutable-verification.json')
    return value

owner_scopes = {
    'bench/profile/server-profile-registration.mjs': 'complete old-to-current affected diff; current clock-policy 58-109 and own deep equality/identity probes; unchanged sections bound to prior selected readset',
    'bench/profile/server-profile-contract.mjs': 'complete old-to-current affected diff; current 1-48, 270-340, 477-825 with 574-617 reread; new codec/onset 80-148 via full diff; unchanged sections reused from prior full 1-759',
    'bench/profile/server-profile-runner.mjs': 'complete old-to-current affected diff; current 1-150, 185-250, 409-489, 556-596 and selected 425-610 lifecycle boundaries; unchanged sections reused from prior 1-596',
    'bench/profile/server-profile-retention.mjs': 'unchanged exact bytes; reuse own prior selected 1-29, no new retention admission',
    'test/server-profile-contract.test.ts': 'complete old-to-current affected diff, all 405 diff lines in two bounded reads; current fixture imports used through frozen primary adaptation; unchanged prior selected 1-55, 105-188 reused; not full test-body review',
    'docs/server-profile.md': 'complete old-to-current affected diff; unchanged text reuse prior 1-186 plus previous own closure diff; not claimed fresh complete new body read',
    'bench/compare/bench.mjs': 'complete old-to-current affected diff; current 1-75 and 434-572 producer/acquisition/cleanup; unchanged selected owner sections reused',
    'bench/compare/methodology.mjs': 'complete old-to-current affected diff and changed semantic-owner interfaces/body; unchanged selected 1-195, 215-285, 545-690 plus prior affected 587-730 reused; no numerical or measurement correctness verdict',
    'scripts/bench-transform-support.mjs': 'unchanged exact bytes; reuse own prior 1-508 owner/lifecycle read; frozen import used by probe',
    'test/bench-transform-pair.test.ts': 'unchanged exact bytes; reuse prior selected 550-715 excerpts and affected lineage/caller searches; not full test-body review',
    'test/benchmark-methodology.test.ts': 'complete old-to-current affected diff; unchanged previous selected 335-440 reused; not full test-body review',
    'test/benchmark-report-contract.test.ts': 'unchanged exact bytes; reuse previous selected 1-135 and owner diff; current shared semantic consumer independently checked through report-contract context, not full test-body review',
}
files = []
owners = manifest['ownerFiles']
consumers = manifest['affectedConsumerTests']
assert len(owners) == 10 and len(consumers) == 2
changed = {r['path'] for r in json.loads((OUT / 'affected-files.json').read_text())}
for relative in owners + consumers:
    row = packet_entry('source/' + relative, 'method owner' if relative in owners else 'affected legacy consumer test', owner_scopes[relative], 'fresh complete affected diff plus bounded current blocks and byte-bound prior selected reuse' if relative in changed else 'byte-bound own previous selected readset reuse')
    old = prior_by_source[relative]
    old_binding = old_manifest['files']['source/' + relative]
    assert {k: old[k] for k in ('sha256', 'bytes')} == old_binding
    row['priorReadsetBinding'] = {'readsetPath': str(BASE / 'closure-105048Z/readset.json'), 'sourcePath': old['path'], 'sha256': old['sha256'], 'bytes': old['bytes'], 'priorReviewScope': old['reviewScope'], 'unchangedWholeFile': relative not in changed}
    if relative in changed:
        diff = relative.replace('/', '__') + '.diff'
        row['freshAffectedDiff'] = {'path': str(OUT / diff), **digest(OUT / diff), 'scope': 'full old6fe08-to-current5dc049 diff body read'}
    else:
        assert row['sha256'] == old['sha256']
    files.append(row)

context_scopes = {
    'bench/compare/provenance.mjs': 'byte-bound own prior selected 275-355, 400-540 provenance owner/lineage read; no new overall runtime acceptance',
    'bench/compare/report-contract.mjs': 'current 1-43, 475-524 and byte-bound prior 1-42, 777-882 plus semantic/schema/provenance searches; own consumer import',
    'scripts/bench-transform-pair.mjs': 'byte-bound own prior 1-186 lineage/lifecycle context',
    'scripts/bench-support.mjs': 'immutable transitive probe import; byte-bound own prior import-only scope; not semantic acceptance',
    'bench/profile/profile-measurement.mjs': 'byte-bound prior owner/import searches only',
    'bench/profile/profile-01-preregistration.mjs': 'byte-bound prior owner/import searches only',
}
for relative, scope in context_scopes.items():
    row = packet_entry('source/' + relative, 'source context', scope, 'byte-bound own previous selected readset reuse; fresh blocks only where stated')
    old = prior_by_source[relative]
    assert row['sha256'] == old['sha256'], relative
    row['priorReadsetBinding'] = {'path': str(BASE / 'closure-105048Z/readset.json'), 'sourcePath': old['path'], 'sha256': old['sha256'], 'bytes': old['bytes'], 'reviewScope': old['reviewScope']}
    files.append(row)

for relative, scope in {
    'receipt.json': 'identity keys, ownerHashes, primary command/outcome counts only; independentMethodReview field and any foreign review prose are excluded',
    'SOURCE-FREEZE.json': 'exact source identity, file list, epochs/binding; no author verdict transfer',
    'checks-receipt.json': 'primary command/result procedure only, original epoch preserved',
    'current-dependency-trees.json': 'prepared toolchain identity only, no dependency/runtime qualification',
    'owner.patch': 'cumulative patch headers/identity only; full newly affected body independently read as saved eight diffs',
    'primary-clock-sources/sources-manifest.json': 'all 17 source URL/hash bindings to declared registered roster; no mathematical clock error qualification',
    'artifact-context/source-build-byte-proof.json': 'build/source/package identity keys and all 117 builder source rows; no foreign runtime verdict',
    'artifact-context/source-readset.json': '935 file rows/HEAD/epoch identity only; 631 tracked rows compared, 304 dist rows not compared to source/dist; prose about outcomes excluded',
    'evidence/frame-first-publication-closure/maxN1024-consumer-receipt.json': 'primary actual CLI argv/result/size/hash receipt; full receipt parsed; full-N replay not independently rerun',
    'evidence/frame-first-publication-closure/max-format-consumer.log': 'primary actual CLI stdout compared with receipt, no performance inference',
    'evidence/frame-first-publication-closure/max-format-fixtures.mjs': 'selected fixture/import prefix read; frozen-path-only adaptation imported stage2 for own bounded probe; fixture values unchanged',
    'evidence/frame-first-publication-closure/public-cli-first-publication-results.json': 'all 15 primary actual command/result cases parsed, original epochs preserved; synthetic controls, not registered performance samples',
    'evidence/frame-first-publication-closure/affected-first-publication-final.json': 'primary suite totals only: 307 passed, 0 failed, 0 skipped; no test semantic acceptance beyond scoped source reads',
}.items():
    files.append(packet_entry(relative, 'primary identity/procedure/result context', scope))

for relative in ['artifact-context/baseline.tgz', 'artifact-context/candidate-npm.tgz', 'artifact-context/candidate-pnpm.tgz']:
    files.append(packet_entry(relative, 'actual frozen package context', 'all archive member hashes read without extraction; identity-only lineage, not final package/runtime acceptance'))
for relative in manifest['files']:
    if relative.startswith('primary-clock-sources/') and relative != 'primary-clock-sources/sources-manifest.json':
        files.append(packet_entry(relative, 'primary upstream clock source bytes', 'registered URL/SHA256/file equality only; no numerical or upstream execution review', 'hash binding only', already_verified=True))
    elif relative.startswith('evidence/frame-first-publication-closure/frozen-owner-source/'):
        files.append(packet_entry(relative, 'primary command frozen owner source', 'exact equality with current 12 owners/consumers and receipt/SOURCE-FREEZE; no duplicated semantic verdict', 'hash binding only', already_verified=True))
    elif relative.startswith('evidence/frame-first-publication-closure/') and relative.endswith(('.json.gz', '.ndjson.gz')):
        files.append(packet_entry(relative, 'primary lossless synthetic raw/journal bytes', 'compressed bytes rehashed in all-manifest verification; supplied raw size/digests retained in primary receipts; no own decompression/full-N replay', 'hash binding only', already_verified=True))

files.append(packet_entry('evidence/frame-first-publication-closure/max-format-consumer-probe.mjs', 'primary max-format command source', 'current exact bytes bound only; old command source read in own prior chain; no fresh current full-body claim', 'hash binding only', already_verified=True))

norm_scopes = {
    'AGENTS.md': 'architecture 72-117; independence 118-151; mechanisms 227-255',
    'SPEC.md': '1-96 current plan/authority contract',
    'TEMPLATE.md': '1-65 plan structure/context',
    'r11.md': 'PROFILE 339-354 and G-PERF 435-465 active law; prior authority context reused',
    'r12.md': 'prepared only: 1-58, 119-153, 246-267; evidence update not activation/admission',
    'ACTIVE.md': 'complete status-only file',
    'CLAIM.md': 'complete current active claim file',
    'ACTIVATION.md': 'complete original activation binding file',
}
for row in json.loads((OUT / 'norm-binding.json').read_text()):
    copy = Path(row['frozenCopy'])
    assert digest(copy) == {k: row[k] for k in ('sha256', 'bytes')}
    files.append({'path': str(copy), 'originalSource': row['source'], 'role': 'immutable own normative copy', 'reviewScope': norm_scopes[copy.name], 'readMode': 'fresh selected norm read', **digest(copy)})

previous_expected = {
    BASE / 'REPORT.md': '027451739fb5fcfe31fa4f52aae8d7a8c962955de886c5acb4e7ba8a6b7d8cbd',
    BASE / 'readset.json': 'e1030cce721ffcb25c66e631493dca7315bf34a90525373ee11b87fddf0a0e37',
    BASE / 'evidence-manifest.json': '29911170012f7230c6c7bc3a6a7bec322bc2df4c31d4363b0316ba3ec37a2226',
    BASE / 'closure-105048Z/REPORT.md': 'b84bc09bee6b50c2eb2dbb2388041a9ead5a4495c8619f963ac0449ff4375d17',
    BASE / 'closure-105048Z/readset.json': '9772597cd25135fa38d900ea32089e08bd0ec893fae89d112537f48906aa0a5e',
    BASE / 'closure-105048Z/evidence-manifest.json': 'd05e486cd27ee571a54b441efd266886500e96741b0f340da64fab44c3a212b8',
}
previous = []
for path, expected in previous_expected.items():
    actual = digest(path)
    assert actual['sha256'] == expected, path
    previous.append({'path': str(path), 'role': 'own unchanged historical artifact', 'reviewScope': 'own historical context/readset/probes only; no old acceptance transfer', **actual})
write('previous-artifact-preservation.json', {'schema': 1, 'files': previous, 'allUnchanged': True})

write('readset.json', {
    'schema': 1,
    'axis': 'independent single-axis second-order SERVER METHOD affected closure',
    'verdict': 'PASS', 'confirmedFindings': 0,
    'immutablePacket': str(PACKET),
    'immutableManifest': digest(PACKET / 'manifest.json'),
    'immutableArchive': json.loads((OUT / 'immutable-verification.json').read_text())['rootBindings']['method.tar.gz'],
    'sourceBasisHead': manifest['sourceBasisHead'], 'sourceBasisClean': True,
    'protocolDigest': manifest['protocolDigest'], 'clockModelDigest': manifest['clockModelDigest'],
    'actualRegisteredPerformanceSamples': 0,
    'ownerCount': len(owners), 'affectedConsumerTestCount': len(consumers),
    'freshAffectedDiffCount': len(changed),
    'allManifestByteVerification': {'files': 3789, 'mismatches': 0, 'receipt': str(OUT / 'immutable-verification.json'), 'semanticAcceptance': False},
    'allTrackedSourceGitBinding': {'files': 631, 'receipt': str(OUT / 'git-source-binding.json'), 'command': ['git', '-C', '/workspace/lab-motion', 'cat-file', '--batch'], 'input': manifest['sourceBasisHead'] + ':<each manifest sourceFiles path>', 'liveCheckoutOwnerRead': False, 'semanticAcceptance': False},
    'excluded': ['author HANDOFF/RUN-PLAN/CLOCK-CERTIFICATE/rationale', 'foreign REPORT/verdict/PR body/comments', 'measurement/numerical correctness', 'general runtime correctness', 'actual performance sampling', 'future live/source epochs'],
    'hashOnlyExcludedFiles': 'all-manifest hashing includes opaque excluded files; their content and embedded review outcomes are not semantic inputs',
    'previousOwnArtifacts': previous,
    'files': files,
})

executions = [
    'light-probe-execution.json', 'light-probe-execution.attempt1.json',
    'consumer-lifecycle-execution.json', 'clock-source-binding-execution.json',
    'bounded-public-cli-results.json', 'storage-capacity-receipt.json',
]
write('review-command-receipt.json', {
    'schema': 1,
    'exactOwnProbeArgvAndEpochs': [{'path': str(OUT / name), **digest(OUT / name)} for name in executions],
    'savedSourceReadProcedure': 'bounded source blocks stated in readset plus eight complete saved old6fe08-to-current5dc049 diffs; own prior readset reuse bound to exact SHA256',
    'immutableByteReadbackProcedure': 'SHA256 and byte count of all 3789 packet manifest files and archive, no extraction of whole method archive; immutable-verification.json',
    'savedProbeScripts': ['consumer-lifecycle-probe.mjs', 'consumer-lifecycle-probe.attempt1.mjs', 'storage-probe.mjs', 'clock-source-binding-probe.mjs'],
    'fixtureAdaptation': 'absolute import prefix only, no values changed; fixture-adaptation.json',
    'expectedRefusalExitCodes': [0, 1, 1],
    'firstWrongExpectationRetained': True,
    'actualRegisteredPerformanceSamples': 0,
    'heavyExecuted': False,
    'sourceEdits': False,
    'processes': 'END',
})

report = OUT / 'REPORT.md'
text = report.read_text()
text = text.replace('Producer finally cancel/removes каждый acquired owner/target, записывая failures.', 'Producer finally пытается cancel/remove acquired owners/targets и сохраняет failures.')
text = text.replace('findings0.', 'findings 0.').replace('Confirmed findings0.', 'Confirmed findings 0.')
text = text.replace('Существенно более простой путь с тем же contract не обнаружен.', 'Более простой путь с тем же contract не обнаружен.')
report.write_text(text)
assert len(text) <= 15500, len(text)

excluded_outputs = {'REPORT.md', 'evidence-manifest.json', 'report-receipt.json'}
outputs = []
for path in sorted(OUT.rglob('*')):
    if path.is_file() and path.name not in excluded_outputs:
        outputs.append({'path': str(path), 'relativePath': str(path.relative_to(OUT)), **digest(path)})
write('evidence-manifest.json', {
    'schema': 1,
    'axis': 'second-order SERVER METHOD',
    'packetManifest': {'path': str(PACKET / 'manifest.json'), **digest(PACKET / 'manifest.json')},
    'reportSeparateReceipt': str(OUT / 'report-receipt.json'),
    'closure': 'own artifacts only; immutable inputs identified separately in readset',
    'excludedForAcyclicSeal': ['REPORT.md (bound by report-receipt)', 'evidence-manifest.json (self)', 'report-receipt.json (terminal seal)'],
    'files': outputs,
})

now = datetime.now(timezone.utc).isoformat()
write('report-receipt.json', {
    'schema': 1, 'sealedUtc': now,
    'axis': 'single-axis second-order SERVER METHOD affected closure',
    'verdict': 'PASS', 'confirmedFindings': 0,
    'report': {'path': str(report), 'characters': len(text), **digest(report)},
    'readset': {'path': str(OUT / 'readset.json'), **digest(OUT / 'readset.json')},
    'evidenceManifest': {'path': str(OUT / 'evidence-manifest.json'), **digest(OUT / 'evidence-manifest.json')},
    'immutablePacketManifest': {'path': str(PACKET / 'manifest.json'), **digest(PACKET / 'manifest.json')},
    'sourceBasisHead': manifest['sourceBasisHead'], 'protocolDigest': manifest['protocolDigest'], 'clockModelDigest': manifest['clockModelDigest'],
    'actualRegisteredPerformanceSamples': 0,
    'limitations': ['no numerical/measurement acceptance', 'no general runtime/product qualification', 'provided synthetic full-N replay not independently repeated', 'actual dense storage/RSS/crash/durable retention not proven', 'future source/clock/protocol/workload/package tuples invalidate affected proof'],
    'processes': 'END', 'heavy': 0, 'frozenOrLiveSourceEdits': False,
    'deliveryEffects': False, 'previousOwnArtifactsUnchanged': True,
})

for row in json.loads((OUT / 'evidence-manifest.json').read_text())['files']:
    assert digest(Path(row['path'])) == {k: row[k] for k in ('sha256', 'bytes')}, row['path']
for target in re.findall(r'\]\((/[^)]+)\)', text):
    target = re.sub(r':\d+$', '', target)
    assert Path(target).exists(), target
print(json.dumps({'verdict': 'PASS', 'findings': 0, 'processes': 'END', 'report': digest(report), 'reportCharacters': len(text), 'readset': digest(OUT / 'readset.json'), 'evidenceManifest': digest(OUT / 'evidence-manifest.json'), 'reportReceipt': digest(OUT / 'report-receipt.json'), 'outputFilesVerified': len(outputs)}, ensure_ascii=False, indent=2))
