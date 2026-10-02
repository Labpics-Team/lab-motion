
    const history = admissionHistory(), { artifact, events } = history;
    expect(validateServerArtifact(artifact).verdict).toBe('PASS');
    expect(validateServerJournal(artifact, history.records)).toHaveProperty('journalFinalDigest');
    const earlyCalibration = events.filter((event) => event.type !== 'calibration');
    earlyCalibration.splice(earlyCalibration.findIndex((event) => event.type === 'N-frozen-before-calibration-and-AB') + 1, 0,
      { type: 'calibration', value: artifact.calibration });
    expect(() => validateServerJournal(artifact, chain(earlyCalibration, history))).toThrow(/до завершения/);
    const alwaysLeft = [...events];
    const firstOpposite = alwaysLeft.findIndex((event) => event.type === 'sample' && event.value.participant === 'right');
    [alwaysLeft[firstOpposite], alwaysLeft[firstOpposite + 1]] = [alwaysLeft[firstOpposite + 1], alwaysLeft[firstOpposite]];
    expect(() => validateServerJournal(artifact, chain(alwaysLeft, history))).toThrow(/порядок/);
    const ignoredFailure = [...events.slice(0, -1), { type: 'failure', value: { stage: 'ab', error: { message: 'retained reviewer failure' } } }, events.at(-1)];
    expect(() => validateServerJournal(artifact, chain(ignoredFailure, history))).toThrow(/failures/);
    const wrongPositive = { ...artifact, positive: { ...artifact.positive, name: 'aa' } };
    expect(() => validateServerArtifact(wrongPositive)).toThrow(/имя стадии/);
    const wrongFinish = [...events.slice(0, -1), { type: 'finished', value: { verdict: 'PASS', digest: 'b'.repeat(64) } }];
    expect(() => validateServerJournal(artifact, chain(wrongFinish, history))).toThrow(/финальная/);
