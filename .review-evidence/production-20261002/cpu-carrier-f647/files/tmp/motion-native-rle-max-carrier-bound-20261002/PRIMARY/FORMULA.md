# Граница размера синтетического max-N carrier

Это проверка размера существующего синтетического формата, не запуск SUT, потребителя или зарегистрированной серии.

Источники: старый max-format owner/его точный compiled fixture и receipt; текущие SERVER_PROFILE, compactServerCpuEvidence/expandServerCpuEvidence и packet boundary runner. Текущие source SHA находятся в capacity-result.json, копии исходников — в source/.

Для каждого raw repetition:

Δ = bytes(новый RLE) − bytes(старый CPU массив) + bytes(новые clockReads) − bytes(старые clockReads).

Ширина каждого timespec достигает 19 цифр seconds и 9 цифр nanoseconds; точный BigInt seconds×10^9+nanoseconds даёт 28 цифр valueNs. Один постоянный положительный safe PID=TID имеет 16 цифр. Canonical encoder/decoder восстанавливает все endpoint поля точно; clockReads используют тот же valueNs. На repetition приходится один RLE run, 16 endpoints для прежних engine-сцен и 2 для stock C. Абсолютный сдвиг CPU времени сохраняет все интервальные разности. Пространство seconds от max−20 000 000 допускает 164 416 последовательных repetitions с шагом 8 s без переполнения; nanoseconds остаются девятизначными.

Каждый carrier содержит warmup4, pilot8, AA1024, positive1024 и AB1024. Прежние engine-сцены имеют 8 repetitions для left/right, а positive/right — 16. Stock C всегда имеет 8 repetitions; positive удваивает число операций внутри batch, не число CPU endpoints. Получается 1 939 840 endpoints в JSON и столько же в журнале; оба carrier вместе содержат 3 879 680.

К сумме замен добавляются 18 504 новых sample.cpuClock members по 93 B. Эта сумма равна 8 201 512 B на carrier. Статический запас получен не произвольной константой: добавляются целиком текущие protocol+synthetic registration (22 862 B), положительная разница stockCpuScope (0 B) и до 24 B на каждый изменяемый pilot Number (1 728 B). Старые metadata не вычитаются. Pilot old-owner units<4000 не меняет фиксированное число endpoints; его operationNs поля покрывает отдельное слагаемое. Для прежних legacy clockReads минимальная ширина при этом perturbation сохраняется.

Итого на каждый старый успешный carrier добавляется не больше 8 226 102 B: JSON≤972 185 791 B, журнал≤982 705 730 B. Оба вместе≤1 954 891 521 B. Резерв 1 GiB требует в сумме 3 028 633 345 B. Это арифметическая граница, не измеренный размер нового файла и не результат нового max-N consumer.

Область переноса: существующая успешная synthetic форма с прежними остальными полями. Реальные CSS/события/внешние paths/строки ошибок/частичные prefixes могут иметь другую ширину; эта проверка не устанавливает границу реальной серии. Для реального запуска нужны свежий storage admission и проверка существующего max-N consumer нового формата в отдельном окне. Старые carriers не декодировались и не изменялись.
