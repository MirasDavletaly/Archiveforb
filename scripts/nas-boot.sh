#!/bin/sh
# NAS boot: starts the two long-running helpers, the Docker watchdog (nas-watchdog.sh) and the off-NAS backup
# (nas-offsite.sh), then makes sure Company Files' site and document editor are up. Installed as
# /usr/local/etc/rc.d/nas-boot.sh: DSM runs /usr/local/etc/rc.d/*.sh with "start" at every boot (pkg-rclocal.service).
# Why not DSM's Task Scheduler: the tasks "Docker watchdog" and "Offsite backup" were written into its database
# directly and DSM never ran them. After the restart of 2026-11-25 neither helper came back, and the site stayed down.
# Why the extra check: after the restart of 2026-11-26 the editor container was left stopped with exit code 0 and no
# error, which the watchdog takes for "stopped on purpose". Both run in the network of their Tailscale container, so
# they are started only once that one runs. Up to 15 minutes after boot; log: /var/log/company-files-boot.log.
# Both helpers detach and keep one copy each (locks in /tmp), so a second start does nothing.
[ "$1" = start ] || exit 0
(
  export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
  i=0
  while [ ! -f /volume1/docker/nas-watchdog/nas-watchdog.sh ] && [ $i -lt 60 ]; do i=$((i + 1)); sleep 5; done
  bash /volume1/docker/nas-watchdog/nas-watchdog.sh
  bash /volume1/docker/offsite-backup/nas-offsite.sh

  PAIRS=${CF_PAIRS:-"company-files-tailscale:company-files company-files-office-tailscale:company-files-office"}
  LOG=${CF_LOG:-/var/log/company-files-boot.log}
  running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
  n=0
  while [ $n -lt 90 ]; do
    n=$((n + 1))
    sleep 10
    docker info >/dev/null 2>&1 || continue
    down=0
    for pair in $PAIRS; do
      net=${pair%%:*}
      c=${pair#*:}
      running "$c" && continue
      down=1
      running "$net" && docker start "$c" >/dev/null 2>&1 && echo "$(date '+%F %T') started $c" >>"$LOG"
    done
    [ $down = 0 ] && exit 0
  done
  echo "$(date '+%F %T') gave up: still down 15 minutes after boot" >>"$LOG"
) </dev/null >/dev/null 2>&1 &
exit 0
