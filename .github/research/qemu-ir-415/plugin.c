#include <qemu-plugin.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

#define MAX_VCPUS 256u
#define SYS_GETPID_X86_64 39
#define START_MAGIC UINT64_C(0x4c4d535441525431)
#define END_MAGIC   UINT64_C(0x4c4d454e44493131)
#define TAG_MAGIC   UINT64_C(0x51454d5549523431)

static _Atomic uint64_t counts[MAX_VCPUS];
static _Atomic unsigned char active[MAX_VCPUS];

static void tb_exec(unsigned int vcpu_index, void *userdata) {
  if (vcpu_index >= MAX_VCPUS) return;
  if (atomic_load_explicit(&active[vcpu_index], memory_order_relaxed)) {
    atomic_fetch_add_explicit(
      &counts[vcpu_index],
      (uint64_t)(uintptr_t)userdata,
      memory_order_relaxed
    );
  }
}

static void tb_trans(qemu_plugin_id_t id, struct qemu_plugin_tb *tb) {
  (void)id;
  const size_t n = qemu_plugin_tb_n_insns(tb);
  qemu_plugin_register_vcpu_tb_exec_cb(
    tb,
    tb_exec,
    QEMU_PLUGIN_CB_NO_REGS,
    (void *)(uintptr_t)n
  );
}

static void syscall_cb(
  qemu_plugin_id_t id,
  unsigned int vcpu_index,
  int64_t num,
  uint64_t a1,
  uint64_t a2,
  uint64_t a3,
  uint64_t a4,
  uint64_t a5,
  uint64_t a6,
  uint64_t a7,
  uint64_t a8
) {
  (void)id; (void)a3; (void)a4; (void)a5; (void)a6; (void)a7; (void)a8;
  if (vcpu_index >= MAX_VCPUS || num != SYS_GETPID_X86_64 || a2 != TAG_MAGIC) return;
  if (a1 == START_MAGIC) {
    atomic_store_explicit(&counts[vcpu_index], 0, memory_order_relaxed);
    atomic_store_explicit(&active[vcpu_index], 1, memory_order_release);
    return;
  }
  if (a1 == END_MAGIC) {
    atomic_store_explicit(&active[vcpu_index], 0, memory_order_release);
    const uint64_t count = atomic_load_explicit(&counts[vcpu_index], memory_order_relaxed);
    char line[128];
    snprintf(line, sizeof(line), "QEMU_IR vcpu=%u count=%" PRIu64 "\n", vcpu_index, count);
    qemu_plugin_outs(line);
  }
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install(
  qemu_plugin_id_t id,
  const qemu_info_t *info,
  int argc,
  char **argv
) {
  (void)argc; (void)argv;
  if (info->system_emulation) return -1;
  qemu_plugin_register_vcpu_tb_trans_cb(id, tb_trans);
  qemu_plugin_register_vcpu_syscall_cb(id, syscall_cb);
  return 0;
}
