#!/bin/sh
# Runs before the image's own entrypoint scripts (which render the config template).
#
# Uploads are handed from nginx to the app as files (see nginx.conf.template, "Direct
# uploads"). nginx creates them with mode 0600, owned by the user its worker processes run
# as, and the app has to read and rename them. So when the app container runs as a
# non-root user (VG_UID / VG_GID, e.g. 568:568 for TrueNAS' "apps" user), the workers must
# run as that same uid:gid. The master process stays root: it binds the ports, reads the
# certificate key, and creates (and chowns to the workers) the temp directories.
#
# The image's workers run as the account "nginx"; recreate that account with the app's ids
# instead of touching the config. Nothing to do when VG_UID is unset or 0 (app runs as
# root, and root can read everything).
set -eu

uid="${VG_UID:-0}"
gid="${VG_GID:-$uid}"

if [ "$uid" = "0" ]; then
    echo "$0: VG_UID is unset or 0 - nginx workers keep their default user"
    exit 0
fi

# A group with that gid may exist already (then the account joins it).
group="$(getent group "$gid" | cut -d: -f1 || true)"
if [ -z "$group" ]; then
    deluser nginx >/dev/null 2>&1 || true
    delgroup nginx >/dev/null 2>&1 || true
    addgroup -g "$gid" nginx
    group=nginx
else
    deluser nginx >/dev/null 2>&1 || true
fi
adduser -D -H -u "$uid" -G "$group" -s /sbin/nologin nginx
echo "$0: nginx workers run as uid $uid, gid $gid"
