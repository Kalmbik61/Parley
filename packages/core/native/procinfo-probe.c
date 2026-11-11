/* Parley Code Mode launch probe (plan T4a, T2b r4 obligation m-3887).
 *
 * Run once per launch under the SAME rendered helper profile plus exec/read of this binary's own path, as the direct
 * child of a synthetic parent whose argv carries a marker. It reports whether this process can read the parent's
 * kinfo_proc (KERN_PROC_PID) and argv (KERN_PROCARGS2). It never prints argv contents: only errno, a read flag and
 * whether the expected marker was present.
 *
 * Usage: procinfo-probe <expected-parent-pid> <marker>
 * Output (stdout, exactly two lines):
 *   PARLEY_PROCINFO_PROBE_STARTED 1
 *   {"v":1,"target":<pid>,"ppid":<getppid>,"kinfo":{"errno":<n>,"read":<bool>},"procargs2":{"errno":<n>,"read":<bool>,"marker":<bool>}}
 * The launch passes only when both errno values are 1 (EPERM) and nothing was read.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
  /* Started marker first, flushed, so a crash after start is distinguishable from a failure to start. */
  fputs("PARLEY_PROCINFO_PROBE_STARTED 1\n", stdout);
  fflush(stdout);
  if (argc != 3) return 64;
  char *end = NULL;
  long target = strtol(argv[1], &end, 10);
  if (end == argv[1] || *end != '\0' || target <= 1 || target > 99999999) return 64;
  const char *marker = argv[2];
  size_t marker_len = strlen(marker);
  if (marker_len < 16 || marker_len > 128) return 64;

  struct kinfo_proc kp;
  size_t kp_size = sizeof kp;
  int kinfo_mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)target };
  int kinfo_errno = 0, kinfo_read = 0;
  if (sysctl(kinfo_mib, 4, &kp, &kp_size, NULL, 0) != 0) kinfo_errno = errno;
  else kinfo_read = kp_size > 0;

  int args_mib[3] = { CTL_KERN, KERN_PROCARGS2, (int)target };
  size_t args_size = 0;
  int args_errno = 0, args_read = 0, args_marker = 0;
  if (sysctl(args_mib, 3, NULL, &args_size, NULL, 0) != 0) {
    args_errno = errno;
  } else {
    char *buf = malloc(args_size > 0 ? args_size : 1);
    if (buf == NULL) return 70;
    if (sysctl(args_mib, 3, buf, &args_size, NULL, 0) != 0) {
      args_errno = errno;
    } else {
      args_read = 1;
      for (size_t i = 0; i + marker_len <= args_size; i++) {
        if (memcmp(buf + i, marker, marker_len) == 0) { args_marker = 1; break; }
      }
    }
    free(buf);
  }

  printf("{\"v\":1,\"target\":%ld,\"ppid\":%d,\"kinfo\":{\"errno\":%d,\"read\":%s},\"procargs2\":{\"errno\":%d,\"read\":%s,\"marker\":%s}}\n",
         target, (int)getppid(), kinfo_errno, kinfo_read ? "true" : "false", args_errno, args_read ? "true" : "false",
         args_marker ? "true" : "false");
  return 0;
}
