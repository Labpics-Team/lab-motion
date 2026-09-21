(() => {
  let sink = 0.123456789;

  globalThis.__labMotionProfileRafTraceProbe = (iterations = 5_000_000) =>
    new Promise((resolve) => {
      requestAnimationFrame(function labMotionProfileRafTraceFrame() {
        let value = sink;
        for (let index = 0; index < iterations; index += 1) {
          value = (value * 1.0000001192092896 + (index & 7)) % 1024;
        }
        sink = value;
        globalThis.__labMotionProfileRafTraceSink = value;
        resolve(value);
      });
    });
})();
