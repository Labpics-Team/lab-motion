# Отклонённый re-minify experiment 622fedea

**Роль Diataxis: explanation (объяснение).** Документ объясняет отклонение
эксперимента; таблица и ссылки ниже — исторические свидетельства этого решения,
а не инструкция по применению конфигурации или приёмка нового кандидата.

**Measurement-only. Semantic validation не выполнялась. Оба варианта отклонены;
обычная shipping-конфигурация ими не заменялась.**

Source: [622fedeae47523eeb1f86ee997008a171cf44296](https://github.com/Labpics-Team/lab-motion/commit/622fedeae47523eeb1f86ee997008a171cf44296),
[CI 39933676357](https://github.com/Labpics-Team/lab-motion/actions/runs/39933676357),
[artifact 12492633243](https://github.com/Labpics-Team/lab-motion/actions/runs/39933676357/artifacts/12492633243).
ZIP SHA-256: `798028b24558d2fe37f16de5d01427b2cde1e7bce9e0454c96bc4f8a0ffd7c85`.

[compression-experiment.json](compression-experiment.json) содержит exact options,
toolchain, input/output fingerprints и evidence неизменности исходных пакетов.
Временные варианты меняли только root ESM/CJS; shared frame и остальной dist
сверялись отдельно. Node 24.19.0, Terser 5.51.2, canonical pako gzip 3.0.2,
Node Brotli quality 11. ESM измеряет initial static closure, с отдельным
сжатием каждого файла; CJS — только root-файл, без заявления о его closure.

| Вариант | ESM closure raw B | Gzip B | Brotli B | Превышение 15600 B gzip | Изменение к control |
|---|---:|---:|---:|---:|---|
| control | 39176 | 15822 | 14229 | 222 | — |
| p6 | 39172 | 15827 | 14229 | 227 | raw−4, gzip+5, Brotli 0 |
| p6-ascii | 43200 | 15797 | 14415 | 197 | raw+4024, gzip−25, Brotli+186 |

`p6` использовал compress passes 6, pure_getters и mangle, сохраняя annotations.
`p6-ascii` дополнительно перепечатал полученный p6 artifact с ascii_only=true,
без нового compress/mangle. Это зафиксированная последовательность двух
вариантов, а не выбор лучшего из нераскрытых попыток.

`p6` не улучшил gzip. `p6-ascii` улучшил gzip лишь на 25 B, заметно ухудшил
raw/Brotli и не закрыл budget. Дополнительные flags в этом эксперименте не
подбирались. `semanticValidationRun:false` не является утверждением о
семантическом дефекте; оно ограничивает то, что измерение вообще доказало.

Все восемь consumer imports проверены одним toolchain с одинаковыми public
exports и initial/lazy/total metrics. Full-root consumer gzip control/p6/p6-ascii:
16231/16231/16240 B. Эти consumer bytes не подменяют shipped ESM closure budget.

Отдельные raw consumer reports сохранены byte-identical:
[control](consumer-control.json), [p6](consumer-p6.json),
[p6-ascii](consumer-p6-ascii.json). Их SHA совпадают с recorded report hashes
в compression-experiment.json. Source artifacts и toolchain остались unchanged.
