import { expect, test } from './fixtures/harness';

test('splitText сохраняет extended grapheme clusters в движке браузера', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { splitText } = await import('/dist/presets/index.js');
    const clusters = [
      'e\u0301',
      '👨‍👩‍👧‍👦',
      '🇺🇦',
      '👍🏽',
      '1️⃣',
      '\r\n',
      '각',
      'क्ष',
      '\u0600A',
    ];
    return clusters.map((cluster) => ({ cluster, parts: splitText(cluster) }));
  });

  for (const { cluster, parts } of result) expect(parts).toEqual([cluster]);
});
