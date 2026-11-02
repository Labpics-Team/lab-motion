# Экспериментальный канал Windows

`ScalarMotion` исполняет пружину LabMotion через Windows Composition. На поток UI
возвращаются события наблюдения; интегрирование и привязка `Visual.Offset.X`
выполняются композитором. JS, локального интегратора и покадрового UI-таймера нет.

`Spring` принимает `ResponseMilliseconds > 0` и `0 <= Bounce < 1`.
Параметризация соответствует `src/motion/model.ts`: `ω = 2π·1000/response`,
`k = ω²`, `c = 2·(1 − bounce)·ω`. Штатный `InteractionTrackerInertiaMotion`
получает ускорение `−k·(x − target) − c·v` и интегрирует его сам.

Положение — в локальных единицах tracker; скорость — в тех же единицах в секунду.
`BindOffsetX` отображает координату непосредственно на `Visual.Offset.X`.
Этот опыт не устанавливает преобразование физических пикселей при смене DPI
и точность малых безразмерных каналов, например progress от 0 до 1.

Один экземпляр принадлежит потоку с `DispatcherQueue`. `AnimateTo` заменяет
предыдущую операцию с результатом `Stopped/replaced`. При retarget из Inertia
текущие позиция и скорость сохраняются. Явная начальная скорость допустима из
покоя, когда нет активной операции. `SnapTo`, `Stop` и `Dispose` различаются
причиной результата; только native Idle активного request завершает его как
`Finished/settled`. Это штатный порог покоя Windows, не обещание математически
точного равенства координаты цели. Requests, устаревшие callbacks и bindings
принадлежат адаптеру. Ошибка native admission отклоняет Task.

## Область опыта

Проверены Windows 11 build 26200, Windows App Runtime 2.6.4, .NET 10.0.403,
WinUI x64 unpackaged и масштаб 1.5. Проверка запускает реальные программные
сценарии в WinUI Window: движение до ±200, retarget после ±40 к ∓100,
сохранение ненулевой скорости против варианта со сбросом, спокойную пружину,
начальную скорость 600, Stop, SnapTo и Dispose. События берут значение из
`InteractionTrackerValuesChangedArgs.Position`.

Это не публикуемый пакет (`IsPackable=false`). Подключение реального ввода,
press/sheet, reduced motion, смена DPI/геометрии, точность нормализованных
каналов и производственные потребительские гарантии ещё требуют реализации
и проверки. Калибровки и стили потребителя в библиотеку не входят.

## Воспроизведение

В репозитории находятся настоящий WinUI-потребитель
[`examples/windows`](../../examples/windows/) и
[`test/windows/verify.ps1`](../../test/windows/verify.ps1). Нужны Windows с
доступным Composition, .NET SDK 10 и PowerShell. Из корня репозитория:

```powershell
pwsh -File test/windows/verify.ps1 -OutputDirectory "$env:TEMP/motion-windows-run"
```

Каталог результата должен быть новым. Проверка собирает шесть lifecycle-проб
и запускает семь сценариев в настоящем WinUI Window. В lifecycle-пробах
подменена только граница Composition; интегрирование проверяется отдельным
WinUI-потребителем. Сброс скорости служит контролем для retarget, а вызовы
из Idle observer проверяют окончательность результата завершённого движения.

Приложение поставляет .NET и Windows App SDK вместе с собой; глобальная установка
App Runtime не требуется. Параметры пружин — данные примера, без зависимости
от другой дизайн-системы. Скрипт проверяет код завершения, полный состав
сценариев и наличие нативных событий. Недоступный runtime, таймаут и отсутствующий
trace завершают проверку ошибкой. Журналы сборки, trace, результаты и хеши
исполняемых файлов сохраняются в каталоге результата.

## Почему используется force expression

`SpringScalarNaturalMotionAnimation` с natural modifier в проверенном runtime
сбрасывала позицию и скорость при программном повторном входе в Inertia.
Это воспроизведено также с новым spring object и начальным выражением из tracker.
Её `Period` дополнительно оказался в 2π раз медленнее параметра LabMotion
`response` при одинаковом численном значении. Эти отрицательные результаты
не переносятся на другие версии ОС без повторной проверки.

[Официальный контракт InteractionTrackerInertiaMotion](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.composition.interactions.interactiontrackerinertiamotion)
прямо задаёт вторую производную позиции и содержит пример силы пружины;
[TryUpdatePositionWithAdditionalVelocity](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.composition.interactions.interactiontracker.tryupdatepositionwithadditionalvelocity)
добавляет скорость в Inertia. Адаптер передаёт ноль при retarget и сохраняет
состояние системного исполнителя.
