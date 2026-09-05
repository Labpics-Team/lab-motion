/** Создаёт ровно один compositor→live sample и проверяет его host-effects. */
export function createCompositorHandoffLatencySample({
  CompositorSpring,
  spring,
  property,
  from,
  to,
  now,
}) {
  let animations = 0;
  let cancels = 0;
  let frameRequests = 0;
  let verified = false;

  const controller = new CompositorSpring({
    spring,
    property,
    from,
    to,
    now,
    target: {
      animate() {
        animations++;
        return { cancel() { cancels++; } };
      },
    },
    requestFrame: () => ++frameRequests,
  });
  controller.start();

  return {
    controller,
    verify(live) {
      if (verified) {
        throw new Error('handoff benchmark: lifecycle sample повторно использован');
      }
      verified = true;
      const evidence = { animations, cancels, frameRequests };
      if (
        animations !== 1 ||
        cancels !== 1 ||
        frameRequests !== 1 ||
        !live ||
        typeof live.destroy !== 'function' ||
        !Number.isFinite(live.value) ||
        !Number.isFinite(live.velocity)
      ) {
        throw new Error(
          `handoff benchmark: не выполнен полный lifecycle ` +
          `(animate=${animations}, cancel=${cancels}, requestFrame=${frameRequests})`,
        );
      }
      return evidence;
    },
  };
}
