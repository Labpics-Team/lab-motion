#define _GNU_SOURCE
#include "node_api.h"
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

/* Частный getter стенда: счётчик scheduler текущего Linux-потока.
 * CLOCK_THREAD_CPUTIME_ID обновляет pending runtime, в отличие от stale
 * RUSAGE_THREAD на CPU без active vtime. Номинальный clock_getres не
 * является сертификатом физической точности. Getter overhead не вычитается. */
static napi_value fail(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static int field(napi_env env, napi_value object, const char *name, napi_value value) {
  return napi_set_named_property(env, object, name, value) == napi_ok;
}

static int integer_field(napi_env env, napi_value object, const char *name, int64_t number) {
  napi_value value;
  return napi_create_int64(env, number, &value) == napi_ok && field(env, object, name, value);
}

static int string_field(napi_env env, napi_value object, const char *name, const char *text) {
  napi_value value;
  return napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value) == napi_ok && field(env, object, name, value);
}

static napi_value read_thread_cpu(napi_env env, napi_callback_info info) {
  (void)info;
  const pid_t pid = getpid();
  const long tid = syscall(SYS_gettid);
  struct timespec value;
  if (pid <= 0 || tid <= 0) return fail(env, "CLOCK_IDENTITY", "Недопустимый PID/TID CPU getter");
  if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value) != 0) return fail(env, "CLOCK_READ", strerror(errno));
  if (value.tv_sec < 0 || value.tv_nsec < 0 || value.tv_nsec >= 1000000000L) return fail(env, "CLOCK_VALUE", "Недопустимый timespec CPU getter");
  char seconds[32];
  if (snprintf(seconds, sizeof(seconds), "%lld", (long long)value.tv_sec) <= 0) return fail(env, "CLOCK_VALUE", "Не удалось записать секунды CPU getter");
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      !string_field(env, result, "seconds", seconds) ||
      !integer_field(env, result, "nanoseconds", value.tv_nsec) ||
      !integer_field(env, result, "pid", pid) || !integer_field(env, result, "tid", tid)) {
    return fail(env, "CLOCK_NAPI", "Не удалось сохранить acquired CPU endpoint");
  }
  return result;
}

static napi_value clock_info(napi_env env, napi_callback_info info) {
  (void)info;
  struct timespec resolution;
  if (clock_getres(CLOCK_THREAD_CPUTIME_ID, &resolution) != 0) return fail(env, "CLOCK_RESOLUTION", strerror(errno));
  if (resolution.tv_sec < 0 || resolution.tv_nsec < 0 || resolution.tv_nsec >= 1000000000L ||
      (resolution.tv_sec == 0 && resolution.tv_nsec == 0)) return fail(env, "CLOCK_RESOLUTION", "Недопустимое номинальное clock_getres");
  char nominal[40];
  const uint64_t value = (uint64_t)resolution.tv_sec * UINT64_C(1000000000) + (uint64_t)resolution.tv_nsec;
  if (snprintf(nominal, sizeof(nominal), "%llu", (unsigned long long)value) <= 0) return fail(env, "CLOCK_RESOLUTION", "Не удалось записать номинальное clock_getres");
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      !integer_field(env, result, "pid", getpid()) || !integer_field(env, result, "tid", syscall(SYS_gettid)) ||
      !string_field(env, result, "nominalResolutionNs", nominal)) return fail(env, "CLOCK_NAPI", "Не удалось сохранить CPU clock identity");
  return result;
}

NAPI_MODULE_INIT() {
  napi_value read, info;
  if (napi_create_function(env, "read", NAPI_AUTO_LENGTH, read_thread_cpu, NULL, &read) != napi_ok ||
      napi_create_function(env, "info", NAPI_AUTO_LENGTH, clock_info, NULL, &info) != napi_ok ||
      !field(env, exports, "read", read) || !field(env, exports, "info", info)) {
    return fail(env, "CLOCK_NAPI", "Не удалось инициализировать частный CPU getter");
  }
  return exports;
}
