#!/bin/sh
# Read this script and scripts/install_system.sh before running as root.
set -eu
source_root="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
case "${1:-}" in
--system) shift; exec "$source_root/scripts/install_system.sh" "$@" ;;
--user) shift; exec python3 "$source_root/scripts/install_user.py" "$@" ;;
*) printf 'Usage: %s --system [--operator USER] | --user [mcp|desktop]\n' "$0" >&2; exit 64 ;;
esac
