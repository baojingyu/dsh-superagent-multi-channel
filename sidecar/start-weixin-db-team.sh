#!/bin/sh
# Start the team-profile WeChat sidecar on a POSIX host.
#
# The `team` profile is a community, open-source route (`wechatauto-replica`, via `weixin-db-bridge`): it reads the encrypted
# local databases of a signed-in Windows desktop WeChat, and it is pinned to the 4.1.12.55 build - other client versions moved
# the schema/UI it depends on. Windows only. On macOS and Linux there is nothing for it to read, so this script says that
# plainly instead of failing halfway through a Python traceback. The profile to use there is `personal` (iLink): the official
# Tencent channel, bounded by neither the operating system nor the client version, needing no desktop client at all.
#
# It exists so the packaged launcher table has an entry for every profile on every platform - the panel then reports the
# real reason a start did not work, rather than "the launcher does not exist".
set -eu

SELF=$0
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case $LINK in
    /*) SELF=$LINK ;;
    *) SELF=$(dirname "$SELF")/$LINK ;;
  esac
done
HERE=$(cd "$(dirname "$SELF")" && pwd)
LOG=$HERE/weixin-db.log

message="team 档是社区开源方案（weixin-db-bridge 读桌面微信本地库），只支持 Windows + 微信 4.1.12.55，本机不是 Windows。请把 profile 改成 personal（iLink）：微信官方通道，不受操作系统与微信版本限制，也不需要桌面微信。"
printf '[weixin-db] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$message" >>"$LOG"
echo "[weixin-db] $message" >&2
exit 1
