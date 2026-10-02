  it('старые Node user/system counters не становятся native clock после переименования', () => {
    const sample = nativeSample();
    for (const measured of sample.raw) measured.raw.cpuReads = measured.raw.clockReads.map((read: any) => ({
      sequence: read.sequence, ...syntheticCpuIdentity, userUs: Number(read.valueNs) / 1000, systemUs: 0, valueNs: read.valueNs }));
    expect(() => validateServerEngineSample(sample, scene)).toThrow(/CPU|native|timespec/);
  });
  it.each(['missing-sample-identity', 'wrong-clock', 'wrong-endpoint-clock', 'missing-seconds', 'negative-seconds', 'noncanonical-seconds', 'overflow-seconds',
    'fractional-nanoseconds', 'negative-nanoseconds', 'negative-zero-nanoseconds', 'overflow-nanoseconds', 'missing-native-read', 'value-mismatch',
    'clock-read-mismatch', 'wrong-sequence', 'wrong-pid', 'wrong-tid', 'worker-thread', 'later-repetition-identity', 'later-repetition-backwards'])
  ('отвергает %s при coherent semantic:true', (fault) => {
    const sample = nativeSample(), lineage = sample.raw[0].raw, read = lineage.cpuReads[1];
    expect(() => validateServerEngineSample(sample, scene)).not.toThrow();
    if (fault === 'missing-sample-identity') delete sample.cpuClock;
    if (fault === 'wrong-clock') sample.cpuClock.clock = 'process.threadCpuUsage';
    if (fault === 'wrong-endpoint-clock') read.clock = 'CLOCK_PROCESS_CPUTIME_ID';
    if (fault === 'missing-seconds') delete read.seconds;
    if (fault === 'negative-seconds') read.seconds = '-1';
    if (fault === 'noncanonical-seconds') read.seconds = '00';
    if (fault === 'overflow-seconds') read.seconds = '9223372036854775808';
    if (fault === 'fractional-nanoseconds') read.nanoseconds += 0.5;
    if (fault === 'negative-nanoseconds') read.nanoseconds = -1;
    if (fault === 'negative-zero-nanoseconds') read.nanoseconds = -0;
    if (fault === 'overflow-nanoseconds') read.nanoseconds = 1_000_000_000;
    if (fault === 'missing-native-read') lineage.cpuReads.pop();
    if (fault === 'value-mismatch') read.valueNs = String(BigInt(read.valueNs) + 1n);
    if (fault === 'clock-read-mismatch') lineage.clockReads[1].valueNs = String(BigInt(read.valueNs) + 1n);
    if (fault === 'wrong-sequence') read.sequence = 0;
    if (fault === 'wrong-pid') read.pid++;
    if (fault === 'wrong-tid') read.tid++;
    if (fault === 'worker-thread') {
      sample.cpuClock.tid++;
      for (const measured of sample.raw) for (const value of measured.raw.cpuReads) value.tid = sample.cpuClock.tid;
    }
    if (fault === 'later-repetition-identity') for (const value of sample.raw[1].raw.cpuReads) { value.pid++; value.tid++; }
    if (fault === 'later-repetition-backwards') {
      const later = sample.raw[1].raw;
      for (const value of later.clockReads) value.valueNs = String(BigInt(value.valueNs) - 100_000_000n);
      later.cpuReads = later.clockReads.map((value: any) => nativeCpuEndpoint(value));
    }
    expect(() => validateServerEngineSample(sample, scene)).toThrow(/CPU|native|timespec|lineage/);
  });
  it('exact seconds выше2^53 не проходят через Number', () => {
    const sample = nativeSample(), shift = 9_007_199_254_740_993n * 1_000_000_000n;
    for (const measured of sample.raw) {
      for (const value of measured.raw.clockReads) value.valueNs = String(BigInt(value.valueNs) + shift);
      measured.raw.cpuReads = measured.raw.clockReads.map((value: any) => nativeCpuEndpoint(value));
    }
    expect(sample.raw[0].raw.cpuReads[0].seconds).toBe('9007199254740993');
    expect(() => validateServerEngineSample(sample, scene)).not.toThrow();
  });
  it('native1ns timespec изменение сохраняется и не требует старой user/system grid', () => {
    const sample = nativeSample(), measured = sample.raw[0];
    measured.raw.clockReads[1].valueNs = '11000001';
    measured.raw.cpuReads[1] = nativeCpuEndpoint(measured.raw.clockReads[1]);
    measured.operationNs = 1_000_001;
    sample.operationNs = 1_000_000.125;
    expect(() => validateServerEngineSample(sample, scene)).not.toThrow();
    expect(SERVER_PROFILE.clockError.engineCounterOutwardPaddingNs).toBe(2000);
  });
  it('same-object mutation main-thread metadata проверяется заново', () => {
    const current = stage();
    const cell = serverCellPairs(current, 2, 'aa', syntheticCpuIdentity).find((cell) => cell.scene === scene.id)!;
    expect(cell.left[0]).toBe(1_000_000);
    const sample = current.rows.find((row) => row.scene === scene.id)!.samples.left;
    sample.cpuClock.pid++; sample.cpuClock.tid++;
    for (const measured of sample.raw) for (const value of measured.raw.cpuReads) { value.pid++; value.tid++; }
    expect(() => serverCellPairs(current, 2, 'aa', syntheticCpuIdentity)).toThrow(/зарегистрированным main-thread/);
  });
