#define _GNU_SOURCE
#include <errno.h>
#include <linux/perf_event.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static long open_perf(struct perf_event_attr *attr, pid_t pid) {
  return syscall(__NR_perf_event_open, attr, pid, -1, -1, 0);
}

static void resume_and_reap(pid_t pid) {
  (void)kill(pid, SIGCONT);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
}

static int wait_stopped(pid_t pid, const char *stage) {
  int status = 0;
  pid_t got;
  do {
    got = waitpid(pid, &status, WUNTRACED);
  } while (got < 0 && errno == EINTR);
  if (got != pid) {
    fprintf(stderr, "%s: waitpid failed: %s\n", stage, strerror(errno));
    return -1;
  }
  if (!WIFSTOPPED(status) || WSTOPSIG(status) != SIGSTOP) {
    if (WIFEXITED(status)) fprintf(stderr, "%s: child exited %d before stop\n", stage, WEXITSTATUS(status));
    else if (WIFSIGNALED(status)) fprintf(stderr, "%s: child signaled %d before stop\n", stage, WTERMSIG(status));
    else fprintf(stderr, "%s: unexpected wait status 0x%x\n", stage, status);
    return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 9) {
    fprintf(stderr, "usage: %s CPU NODE SCRIPT ENTRY LABEL FACTOR PHASE TOKEN\n", argv[0]);
    return 64;
  }

  const char *cpu = argv[1];
  const char *node = argv[2];
  const char *script = argv[3];
  const char *entry = argv[4];
  const char *label = argv[5];
  const char *factor = argv[6];
  const char *phase = argv[7];
  const char *token = argv[8];

  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return 70;
  }
  if (pid == 0) {
    execlp("taskset", "taskset", "-c", cpu, node, "--allow-natives-syntax", script,
           "--child", entry, label, factor, phase, token, (char *)NULL);
    perror("exec taskset/node");
    _exit(71);
  }

  if (wait_stopped(pid, "warm-boundary") != 0) {
    resume_and_reap(pid);
    return 72;
  }

  struct perf_event_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.type = PERF_TYPE_SOFTWARE;
  attr.size = sizeof(attr);
  attr.config = PERF_COUNT_SW_TASK_CLOCK;
  attr.disabled = 1;

  int fd = (int)open_perf(&attr, pid);
  if (fd < 0) {
    fprintf(stderr, "perf_event_open: %s\n", strerror(errno));
    resume_and_reap(pid);
    return 73;
  }

  if (ioctl(fd, PERF_EVENT_IOC_RESET, 0) != 0 || ioctl(fd, PERF_EVENT_IOC_ENABLE, 0) != 0) {
    fprintf(stderr, "perf enable: %s\n", strerror(errno));
    close(fd);
    resume_and_reap(pid);
    return 74;
  }

  if (kill(pid, SIGCONT) != 0) {
    fprintf(stderr, "SIGCONT measured: %s\n", strerror(errno));
    close(fd);
    resume_and_reap(pid);
    return 75;
  }

  if (wait_stopped(pid, "measured-boundary") != 0) {
    (void)ioctl(fd, PERF_EVENT_IOC_DISABLE, 0);
    close(fd);
    resume_and_reap(pid);
    return 76;
  }

  if (ioctl(fd, PERF_EVENT_IOC_DISABLE, 0) != 0) {
    fprintf(stderr, "perf disable: %s\n", strerror(errno));
    close(fd);
    resume_and_reap(pid);
    return 77;
  }

  uint64_t count = 0;
  ssize_t n = read(fd, &count, sizeof(count));
  close(fd);
  if (n != (ssize_t)sizeof(count) || count == 0) {
    fprintf(stderr, "perf read invalid: bytes=%zd count=%llu errno=%s\n",
            n, (unsigned long long)count, strerror(errno));
    resume_and_reap(pid);
    return 78;
  }

  if (kill(pid, SIGCONT) != 0) {
    fprintf(stderr, "SIGCONT receipt: %s\n", strerror(errno));
    resume_and_reap(pid);
    return 79;
  }

  int status = 0;
  pid_t got;
  do {
    got = waitpid(pid, &status, 0);
  } while (got < 0 && errno == EINTR);
  if (got != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    if (got < 0) fprintf(stderr, "final waitpid: %s\n", strerror(errno));
    else if (WIFEXITED(status)) fprintf(stderr, "child final exit=%d\n", WEXITSTATUS(status));
    else if (WIFSIGNALED(status)) fprintf(stderr, "child final signal=%d\n", WTERMSIG(status));
    else fprintf(stderr, "child final status=0x%x\n", status);
    return 80;
  }

  printf("TASK_CLOCK_NS=%llu TOKEN=%s\n", (unsigned long long)count, token);
  fflush(stdout);
  return 0;
}
