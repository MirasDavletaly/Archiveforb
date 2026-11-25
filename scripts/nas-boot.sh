#!/bin/sh
# NAS boot: starts the two long-running helpers, the Docker watchdog (nas-watchdog.sh) and the off-NAS backup
# (nas-offsite.sh). Installed as /usr/local/etc/rc.d/nas-boot.sh: DSM runs /usr/local/etc/rc.d/*.sh with "start"
# at every boot (pkg-rclocal.service).
# Why not DSM's Task Scheduler: the tasks "Docker watchdog" and "Offsite backup" were written into its database
# directly and DSM never ran them. After the restart of 2026-11-25 neither helper came back, and the site stayed down
# (its containers start before the Tailscale containers whose network they use, and Docker does not retry).
# Both helpers detach and keep one copy each (locks in /tmp), so a second start does nothing.
[ "$1" = start ] || exit 0
(
  i=0
  while [ ! -f /volume1/docker/nas-watchdog/nas-watchdog.sh ] && [ $i -lt 60 ]; do i=$((i + 1)); sleep 5; done
  bash /volume1/docker/nas-watchdog/nas-watchdog.sh
  bash /volume1/docker/offsite-backup/nas-offsite.sh
) </dev/null >/dev/null 2>&1 &
exit 0
