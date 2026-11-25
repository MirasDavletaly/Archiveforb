#!/bin/sh
# Company Files: bring the website and the document editor back after the NAS restarts.
# Installed on the NAS as /usr/local/etc/rc.d/company-files.sh (DSM runs those with "start" at boot).
#
# Both share the network of their Tailscale containers (network_mode: service:...). At boot Docker may start them
# before those are up, fail with "cannot join network of a non running container" and never try again: that took
# the site down after the restart of 2026-11-25. This waits for Docker and starts whichever is still down once its
# Tailscale container runs.
# ponytail: plain "docker start"; if a Tailscale container was ever recreated (new id), run docker-compose by hand.
[ "$1" = start ] || exit 0
(
  export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
  PAIRS=${CF_PAIRS:-"company-files-tailscale:company-files company-files-office-tailscale:company-files-office"}
  LOG=${CF_LOG:-/var/log/company-files-boot.log}
  running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
  n=0
  while [ $n -lt 90 ]; do # up to 15 minutes after boot
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
