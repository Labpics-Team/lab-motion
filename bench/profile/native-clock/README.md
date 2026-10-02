# Справочник: исходники частного CPU getter

> Роль: справка (Diátaxis).

`include/` содержит четыре неизменённых Node-API header из Node.js `v24.19.0`,
[официальный каталог `src`](https://github.com/nodejs/node/tree/v24.19.0/src).
Права Node.js contributors и Joyent сохранены в [LICENSE](./LICENSE).
Это зависимости сборки частного `server-profile`; npm-пакет библиотеки их не включает.

Владелец метода — [серверный профиль](../../../docs/server-profile.md).
Exact SHA256 каждого header и C исходника закреплены в
[`SERVER_PROFILE.clockError.nativeSourceFiles`](../server-profile-registration.mjs).
Getter собирается до регистрации; actual binary, compiler, flags, libc и PID/TID
сохраняются в `engineClock`. Номинальное разрешение `clock_getres` не доказывает
физическую точность счётчика.
