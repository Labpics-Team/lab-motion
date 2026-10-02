#define _GNU_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include <sched.h>

struct edge {
  struct rusage ru;
  struct timespec cpu;
  struct timespec wall;
};

static uint64_t ns(struct timespec t) {
  return (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
}

static void read_edge(struct edge *e, int cpu_first) {
  if (cpu_first) {
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &e->cpu) != 0 || getrusage(RUSAGE_THREAD, &e->ru) != 0) exit(2);
  } else {
    if (getrusage(RUSAGE_THREAD, &e->ru) != 0 || clock_gettime(CLOCK_THREAD_CPUTIME_ID, &e->cpu) != 0) exit(2);
  }
  if (clock_gettime(CLOCK_MONOTONIC, &e->wall) != 0) exit(2);
}

static void print_edge(struct edge e) {
  printf("{\"userSeconds\":%ld,\"userMicros\":%ld,\"systemSeconds\":%ld,\"systemMicros\":%ld,\"threadCpuSeconds\":%ld,\"threadCpuNanos\":%ld,\"wallSeconds\":%ld,\"wallNanos\":%ld,\"voluntaryContextSwitches\":%ld,\"involuntaryContextSwitches\":%ld}",
    e.ru.ru_utime.tv_sec,e.ru.ru_utime.tv_usec,e.ru.ru_stime.tv_sec,e.ru.ru_stime.tv_usec,
    e.cpu.tv_sec,e.cpu.tv_nsec,e.wall.tv_sec,e.wall.tv_nsec,e.ru.ru_nvcsw,e.ru.ru_nivcsw);
}

int main(void) {
  const uint64_t counts[] = {1000,10000,100000,1000000};
  struct timespec res;
  cpu_set_t mask;
  CPU_ZERO(&mask);
  if (sched_getaffinity(0,sizeof(mask),&mask) != 0 || CPU_COUNT(&mask) != 1 || !CPU_ISSET(0,&mask)) return 3;
  if (clock_getres(CLOCK_THREAD_CPUTIME_ID,&res) != 0) return 2;
  printf("{\"schema\":1,\"pid\":%d,\"tid\":%ld,\"affinity\":0,\"threadClockNominalResolutionNs\":%" PRIu64 ",\"nominalResolutionIsNotErrorCertificate\":true,\"cases\":[",getpid(),syscall(SYS_gettid),ns(res));
  volatile uint64_t state=UINT64_C(0x123456789abcdef0);
  for (int index=0;index<32;index++) {
    int cpu_first=(index/4)%2;
    uint64_t loops=counts[index%4];
    struct edge before,after;
    read_edge(&before,cpu_first);
    for (uint64_t i=0;i<loops;i++) state=(state^(state>>11))*UINT64_C(0x9e3779b97f4a7c15)+i;
    read_edge(&after,cpu_first);
    if(index)printf(",");
    printf("{\"index\":%d,\"readOrder\":\"%s\",\"loopIterations\":%" PRIu64 ",\"checksum\":\"%" PRIu64 "\",\"before\":",index,cpu_first?"thread-clock-then-rusage":"rusage-then-thread-clock",loops,state);
    print_edge(before);printf(",\"after\":");print_edge(after);printf("}");
  }
  printf("]}\n");
  return fflush(stdout)==0?0:4;
}
