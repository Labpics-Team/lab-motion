globalThis.__labMotionProfileProbe = (iterations) => {
  let value = 0x12345678;
  for (let i = 0; i < iterations; i += 1) {
    value = Math.imul(value ^ i, 1664525) + 1013904223;
  }
  return value >>> 0;
};
