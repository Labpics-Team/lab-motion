type FrameCallback = (timestamp?: number) => void;

/**
 * Turns a possibly synchronous frame source into a one-shot async delivery.
 * Hostile injectables get a unique callback identity per reservation; trusted
 * native schedulers may opt into the stable zero-allocation callback path.
 */
export function createFrameRequester(
  schedule: (callback: FrameCallback) => number,
  tick: FrameCallback,
  uniqueReservations = true,
): () => void {
  let fallback = false;
  let callingHost: boolean;
  let pending: boolean;
  let synchronousDelivery: boolean;
  let synchronousTimestamp: number | undefined;
  let queued = false;
  let queuedTimestamp: number | undefined;
  let reservation = 0;

  function flush(): void {
    queued = false;
    const timestamp = queuedTimestamp;
    queuedTimestamp = undefined;
    tick(timestamp);
  }

  function defer(timestamp: number | undefined): void {
    queuedTimestamp = timestamp;
    if (queued) return;
    queued = true;
    setTimeout(flush, 0);
  }

  function accept(owner: number, timestamp?: number): void {
    if (!pending || owner !== reservation) return;
    pending = false;
    if (callingHost) {
      synchronousDelivery = true;
      synchronousTimestamp = timestamp;
    } else tick(timestamp);
  }

  function deliverTrusted(timestamp?: number): void {
    accept(reservation, timestamp);
  }

  return function requestFrame(): void {
    if (fallback) {
      defer(undefined);
      return;
    }

    const owner = ++reservation;
    pending = true;
    callingHost = true;
    synchronousDelivery = false;
    synchronousTimestamp = undefined;
    let handle: number;
    try {
      handle = schedule(
        uniqueReservations
          ? (timestamp?: number): void => accept(owner, timestamp)
          : deliverTrusted,
      );
    } catch (error) {
      pending = false;
      throw error;
    } finally {
      callingHost = false;
    }
    if (handle === 0) {
      pending = false;
      fallback = true;
      defer(undefined);
    } else if (synchronousDelivery) {
      defer(synchronousTimestamp);
    }
  };
}
