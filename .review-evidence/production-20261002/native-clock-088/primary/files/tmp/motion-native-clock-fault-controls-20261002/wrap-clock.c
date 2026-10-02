#include <time.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
int __wrap_clock_gettime(clockid_t clock, struct timespec *value) {
 (void)clock; const char *mode=getenv("CLOCK_CONTROL_MODE");
 if(strcmp(mode,"errno")==0){errno=EIO;return -1;}
 value->tv_sec=0;value->tv_nsec=17;
 if(strcmp(mode,"negative-sec")==0)value->tv_sec=-1;
 if(strcmp(mode,"negative-ns")==0)value->tv_nsec=-1;
 if(strcmp(mode,"large-ns")==0)value->tv_nsec=1000000000;
 if(strcmp(mode,"large-sec")==0)value->tv_sec=9007199254740993LL;
 return 0;
}
