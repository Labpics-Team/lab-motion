globalThis.__labMotionProfileTraceProbe = (iterations) => new Promise((resolve) => {
  setTimeout(function profileTraceProbeTask() {
    let value = 0x12345678;
    for (let i = 0; i < iterations; i += 1) {
      value = Math.imul(value ^ i, 1664525) + 1013904223;
    }
    resolve(value >>> 0);
  }, 0);
});
