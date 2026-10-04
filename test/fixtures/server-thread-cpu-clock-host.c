/* Управляемый native host для проверок настоящего C getter, без JS mock ABI. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

extern pid_t __real_getpid(void);
extern long __real_syscall(long number, ...);

static int mode(const char *name) {
  const char *value = getenv("MOTION_CLOCK_CHECK_MODE");
  return value != NULL && strcmp(value, name) == 0;
}

int __wrap_clock_gettime(clockid_t clock, struct timespec *value) {
  value->tv_sec = 9007199254740993LL;
  value->tv_nsec = 17;
  if (clock != CLOCK_THREAD_CPUTIME_ID) { errno = EINVAL; return -1; }
  if (mode("read-errno")) { errno = EIO; return -1; }
  if (mode("negative-seconds")) value->tv_sec = -1;
  if (mode("negative-nanoseconds")) value->tv_nsec = -1;
  if (mode("overflow-nanoseconds")) value->tv_nsec = 1000000000L;
  return 0;
}

int __wrap_clock_getres(clockid_t clock, struct timespec *value) {
  value->tv_sec = 0;
  value->tv_nsec = 1;
  if (clock != CLOCK_THREAD_CPUTIME_ID) { errno = EINVAL; return -1; }
  if (mode("resolution-errno")) { errno = EIO; return -1; }
  if (mode("zero-resolution")) value->tv_nsec = 0;
  return 0;
}

pid_t __wrap_getpid(void) { return mode("negative-pid") ? -1 : __real_getpid(); }
long __wrap_syscall(long number, ...) {
  if (number != SYS_gettid) { errno = EINVAL; return -1; }
  return mode("negative-tid") ? -1 : __real_syscall(number);
}
