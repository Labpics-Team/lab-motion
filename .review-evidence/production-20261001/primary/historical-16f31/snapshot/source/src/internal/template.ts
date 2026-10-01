/**
 * internal/template.ts — подстановка значения в CSS-шаблон.
 *
 * Общий чистый хелпер lit- и wc-биндингов (один источник — дубль разъехался
 * бы при тюнинге одного без другого). Заменяются ВСЕ вхождения `{v}`:
 * составные шаблоны вида 'translate({v}px, {v}px)' повторяют плейсхолдер,
 * одиночный replace оставил бы второй литералом в эмитнутом CSS.
 */
export function renderTemplateValue(template: string, value: number): string {
  return template.includes('{v}') ? template.replaceAll('{v}', String(value)) : String(value);
}
