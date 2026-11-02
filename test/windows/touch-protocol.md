# Передача touch и скорости отпускания

Этот протокол фиксируется до первого запуска. Он сравнивает штатное преобразование
вертикального ввода в tracker X с контролем на tracker Y. Опыт не меняет публичный
API LabMotion и не удостоверяет готовность нативного sheet LabUI.

Источник ввода — неподвижный viewport 480 × 320 DIP. Его фактическая высота H
задаёт gain = −1000/H, q = selected position / 1000. Начальная позиция — 500;
видимое смещение — Hq. Контроль и кандидат отличаются только выбранной осью.
Y source использует EnabledWithInertia; другая ось получает нулевую delta.
Встроенная инерция использует response 350 ms, bounce 0 и цель 1000 для движения
вниз либо 0 для движения вверх. DPI и геометрия не меняются внутри запуска.

Четыре независимых запуска: `x-down`, `y-down`, `x-up`, `y-up`. Swipe начинается
на 40 DIP выше/ниже центра и заканчивается симметрично с другой стороны: ровно
80 DIP за номинальные 300 ms. CLI получает физические экранные координаты после
проверки UIA-геометрии и масштаба. Пара X/Y использует одинаковые параметры.
В [winapp CLI 0.7.1](https://github.com/microsoft/winappCli/blob/e3cd0b94f3e7b776ac51ba0564f4908094e979b5/src/winapp-CLI/WinApp.UIAutomation/Input/PointerInput.cs#L287)
20 кадров движения распределяются по заданной длительности с поправкой на
прошедшее время; перед отпусканием дополнительной паузы нет. Это расписание
инъектора, а не измерение фактической скорости ОС.

В каждом каталоге сохраняются `trace.jsonl` приложения и `scenario.json` harness:

```json
{
  "schema": 1,
  "name": "x-down",
  "axis": "x",
  "direction": 1,
  "gesture": "swipe",
  "durationMs": 300,
  "coordinateSpace": "viewport-dip",
  "start": {"x": 240, "y": 120},
  "end": {"x": 240, "y": 200},
  "viewport": {"width": 480, "height": 320, "scale": 1},
  "injection": {
    "coordinateSpace": "screen-pixel",
    "start": {"x": 400, "y": 300},
    "end": {"x": 400, "y": 380},
    "exitCode": 0
  }
}
```

Абсолютные экранные координаты в примере условны. Они записываются из фактического
запуска. Ошибка преобразования расстояния допускается до двух физических пикселей;
доставленное нажатие должно находиться в пределах 2 DIP от заданного начала.

Принятие требует всех следующих наблюдений:

- До Ready получен native ValuesChanged начального запроса с положительным
  requestId, event position и readback q = 0.5. Metadata и Ready совпадают
  со сценарием и фактическим масштабом; другого движения до Ready нет.
- После Ready доставлен ровно один Touch PointerPressed; TryRedirectForManipulation
  вернулся для того же pointerId. Exit 0 CLI не заменяет доставку.
- Затем получены Interacting, как минимум два разных ValuesChanged и Inertia
  с requestId 0. Программные запросы после нажатия запрещены в этом опыте.
- Последнее значение перед Inertia изменило q на ±0.25 с абсолютным допуском 0.08.
  Это заранее выбранный запас 25.6 DIP на распознавание жеста и объединение событий,
  а не обещание ОС о максимальной погрешности. Знак должен совпадать.
- Native velocity выбранной оси, делённая на 1000, имеет верный знак. Её отношение
  к номинальной скорости (±0.25 / 0.3 s) лежит в [0.25, 2.5]. Широкая полоса
  обнаруживает потерю скорости, смену знака и крупную ошибку масштаба; она **не**
  устанавливает точную калибровку velocity. CLI timing и OS estimator различны.
- Неактивные оси position/readback/velocity остаются в пределах одной native unit.
  Первая изменившаяся event position после Inertia продолжает направление последней
  event position до неё. Live readback Inertia может опережать callback ValuesChanged,
  поэтому он не служит временной опорой для этого сравнения.
- Native Idle наступает не позднее пяти секунд после Inertia; event position и
  readback находятся у цели с допуском q = 0.001. Ошибки и обрезанная трасса запрещены.

`node test/windows/assert-touch.mjs <evidence>` пишет `result.json`; PASS требует
всех четырёх сценариев. Отсутствие доставленного touch при готовом приложении —
INCOMPLETE. И FAIL, и INCOMPLETE завершают CLI ненулевым кодом. Если Y проходит,
а X нет, это различитель для последующего выбора оси. Если не проходит контроль,
причина cross-axis не установлена. Отношения скоростей X/Y сохраняются как
наблюдения; один жест на направление не даёт статистического доказательства
точного равенства двух OS-прогонов.

Проверки oracle подменяют знак/нулевую скорость, ось, requestId, readback и
доставку touch. Эти синтетические трассы удостоверяют чувствительность проверки;
runtime доказательством остаются только события запущенного приложения.
PTP, mouse drag, горизонтальный ввод, смена DPI/размера, прерывание новым намерением,
визуальная плавность и производительность остаются за пределами этого протокола.

Основание выбора: [WinUI cross-axis modifier](https://github.com/microsoft/microsoft-ui-xaml/blob/54d01b80dabf2b9818c3e6b85eed818fe827e4ee/controls/dev/ScrollPresenter/ScrollPresenter.cpp#L2624)
подтверждает пространственный путь с EnabledWithoutInertia; [официальный пример
PullToRefresh](https://github.com/microsoft/WindowsAppSDK-Samples/blob/f1be017f26a0feae4c8dc805748eab0a1f7b4fc6/Samples/SceneGraph/SampleGalleryApp/Samples/PullToRefresh/PullToRefresh.xaml.cs#L138)
показывает same-axis scaling с EnabledWithInertia. Ни один источник не заменяет
проверку cross-axis release.

Уточнение готовности после прогона `41506273050` на `49bc2c4`: все четыре
запуска подтвердили позицию 500 через ValuesChanged, но исходная проверка
ошибочно требовала повторного IdleStateEntered. [Таблица TryUpdatePosition](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.composition.interactions.interactiontracker.tryupdateposition?view=windows-app-sdk-2.0)
прямо указывает, что из Idle обновляется значение без смены состояния.
Начальная готовность поэтому требует подтверждения позиции; проверка Idle
после Inertia и все допуски жеста/скорости сохранены. Первый прогон завершился
до ввода и не сообщает ничего о переносе скорости между осями.
