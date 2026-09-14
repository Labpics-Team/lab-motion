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

static long open_perf(struct perf_event_attr *attr, pid_t pid, int group_fd) {
  return syscall(__NR_perf_event_open, attr, pid, -1, group_fd, 0);
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

struct group_read_two {
  uint64_t nr;
  uint64_t time_enabled;
  uint64_t time_running;
  uint64_t values[2];
};

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

  struct perf_event_attr instructions;
  memset(&instructions, 0, sizeof(instructions));
  instructions.type = PERF_TYPE_HARDWARE;
  instructions.size = sizeof(instructions);
  instructions.config = PERF_COUNT_HW_INSTRUCTIONS;
  instructions.disabled = 1;
  instructions.exclude_kernel = 1;
  instructions.exclude_hv = 1;
  instructions.read_format = PERF_FORMAT_GROUP | PERF_FORMAT_TOTAL_TIME_ENABLED | PERF_FORMAT_TOTAL_TIME_RUNNING;

  int leader = (int)open_perf(&instructions, pid, -1);
  if (leader < 0) {
    fprintf(stderr, "perf_event_open instructions: %s\n", strerror(errno));
    resume_and_reap(pid);
    return 73;
  }

  struct perf_event_attr cycles;
  memset(&cycles, 0, sizeof(cycles));
  cycles.type = PERF_TYPE_HARDWARE;
  cycles.size = sizeof(cycles);
  cycles.config = PERF_COUNT_HW_CPU_CYCLES;
  cycles.exclude_kernel = 1;
  cycles.exclude_hv = 1;

  int member = (int)open_perf(&cycles, pid, leader);
  if (member < 0) {
    fprintf(stderr, "perf_event_open cycles: %s\n", strerror(errno));
    close(leader);
    resume_and_reap(pid);
    return 73;
  }

  if (ioctl(leader, PERF_EVENT_IOC_RESET, PERF_IOC_FLAG_GROUP) != 0 ||
      ioctl(leader, PERF_EVENT_IOC_ENABLE, PERF_IOC_FLAG_GROUP) != 0) {
    fprintf(stderr, "perf enable group: %s\n", strerror(errno));
    close(member);
    close(leader);
    resume_and_reap(pid);
    return 74;
  }

  if (kill(pid, SIGCONT) != 0) {
    fprintf(stderr, "SIGCONT measured: %s\n", strerror(errno));
    (void)ioctl(leader, PERF_EVENT_IOC_DISABLE, PERF_IOC_FLAG_GROUP);
    close(member);
    close(leader);
    resume_and_reap(pid);
    return 75;
  }

  if (wait_stopped(pid, "measured-boundary") != 0) {
    (void)ioctl(leader, PERF_EVENT_IOC_DISABLE, PERF_IOC_FLAG_GROUP);
    close(member);
    close(leader);
    resume_and_reap(pid);
    return 76;
  }

  if (ioctl(leader, PERF_EVENT_IOC_DISABLE, PERF_IOC_FLAG_GROUP) != 0) {
    fprintf(stderr, "perf disable group: %s\n", strerror(errno));
    close(member);
    close(leader);
    resume_and_reap(pid);
    return 77;
  }

  struct group_read_two receipt;
  memset(&receipt, 0, sizeof(receipt));
  ssize_t n = read(leader, &receipt, sizeof(receipt));
  close(member);
  close(leader);
  if (n != (ssize_t)sizeof(receipt) || receipt.nr != 2 || receipt.values[0] == 0 || receipt.values[1] == 0 ||
      receipt.time_enabled == 0 || receipt.time_running == 0) {
    fprintf(stderr,
            "perf read invalid: bytes=%zd nr=%llu instructions=%llu cycles=%llu enabled=%llu running=%llu errno=%s\n",
            n, (unsigned long long)receipt.nr,
            (unsigned long long)receipt.values[0], (unsigned long long)receipt.values[1],
            (unsigned long long)receipt.time_enabled, (unsigned long long)receipt.time_running,
            strerror(errno));
    resume_and_reap(pid);
    return 78;
  }
  if (receipt.time_running != receipt.time_enabled) {
    fprintf(stderr, "perf group multiplexed: enabled=%llu running=%llu\n",
            (unsigned long long)receipt.time_enabled, (unsigned long long)receipt.time_running);
    resume_and_reap(pid);
    return 81;
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

  printf("HW_INSTRUCTIONS=%llu HW_CYCLES=%llu TIME_ENABLED=%llu TIME_RUNNING=%llu TOKEN=%s\n",
         (unsigned long long)receipt.values[0], (unsigned long long)receipt.values[1],
         (unsigned long long)receipt.time_enabled, (unsigned long long)receipt.time_running, token);
  fflush(stdout);
  return 0;
}
