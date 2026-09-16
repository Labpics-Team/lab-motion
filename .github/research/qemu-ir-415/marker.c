#define _GNU_SOURCE
#include <node_api.h>
#include <stdint.h>
#include <sys/syscall.h>
#include <unistd.h>

#define START_MAGIC UINT64_C(0x4c4d535441525431)
#define END_MAGIC   UINT64_C(0x4c4d454e44493131)
#define TAG_MAGIC   UINT64_C(0x51454d5549523431)

static void emit_marker(uint64_t marker) {
  (void)syscall(
    SYS_getpid,
    marker,
    TAG_MAGIC,
    UINT64_C(0),
    UINT64_C(0),
    UINT64_C(0),
    UINT64_C(0)
  );
}

static napi_value mark_start(napi_env env, napi_callback_info info) {
  (void)info;
  emit_marker(START_MAGIC);
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

static napi_value mark_end(napi_env env, napi_callback_info info) {
  (void)info;
  emit_marker(END_MAGIC);
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value start_fn;
  napi_value end_fn;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, mark_start, NULL, &start_fn);
  napi_create_function(env, "end", NAPI_AUTO_LENGTH, mark_end, NULL, &end_fn);
  napi_set_named_property(env, exports, "start", start_fn);
  napi_set_named_property(env, exports, "end", end_fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
