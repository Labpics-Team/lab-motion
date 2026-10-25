/**
 * WAAPI completion keeps native Animation identity and final CSS before release.
 * Used by the native adapter and build-time specialized executor.
 */
export const nativeFinished = (animation: Animation): Promise<Animation> => new Promise((resolve, reject) => {
  animation.finished.catch(reject);
  animation.addEventListener('finish', () => {
    try { animation.commitStyles(); animation.cancel(); }
    catch { /* fill preserves terminal state where commitStyles is unavailable */ }
    resolve(animation);
  });
});
