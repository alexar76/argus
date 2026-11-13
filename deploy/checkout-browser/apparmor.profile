# SPDX-FileCopyrightText: Copyright The Moby Authors
# SPDX-License-Identifier: Apache-2.0
# Based on Moby's Docker container profile. userns is scoped to this sidecar.
abi <abi/4.0>,
include <tunables/global>

profile argus-checkout-browser flags=(attach_disconnected,mediate_deleted) {
  network inet,
  network inet6,
  network unix,
  deny network raw,
  userns,
  capability,
  file,
  umount,

  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (send,receive) peer=argus-checkout-browser,
  ptrace (trace,tracedby,read,readby) peer=argus-checkout-browser,

  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9/],[^1-9/][^0-9/],[^1-9s/][^0-9y/][^0-9s/],[^1-9/][^0-9/][^0-9/][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,
  deny mount,
  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,
}
