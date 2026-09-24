#!/bin/sh
# Build the one official graphical bootstrap from the canonical release payload.
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
release_dir=${1:-"$repo/dist"}
output_dir=${2:-"$repo/dist"}
version=$(sed -n '1p' "$repo/VERSION")
artifact="$release_dir/asip-$version.tar.gz"
manifest="$release_dir/release.json"
linuxdeploy=${LINUXDEPLOY:-linuxdeploy-x86_64.AppImage}
appimagetool=${APPIMAGETOOL:-appimagetool-x86_64.AppImage}
runtime=${APPIMAGE_RUNTIME:-runtime-x86_64}

[ "$(uname -m)" = x86_64 ] || { printf 'AppImage builds require x86_64\n' >&2; exit 1; }
[ -r "$artifact" ] && [ -r "$manifest" ] || {
	printf 'Build the product release payload before the AppImage\n' >&2; exit 1;
}
python3 "$repo/scripts/qualification.py" init --artifact "$artifact" --manifest "$manifest" \
	--output "$output_dir/.appimage-payload-check.json" >/dev/null
command -v "$linuxdeploy" >/dev/null 2>&1 || [ -x "$linuxdeploy" ] || { printf 'linuxdeploy is required\n' >&2; exit 1; }
command -v "$appimagetool" >/dev/null 2>&1 || [ -x "$appimagetool" ] || { printf 'appimagetool is required\n' >&2; exit 1; }
command -v "$runtime" >/dev/null 2>&1 || [ -r "$runtime" ] || { printf 'a pinned AppImage Type-2 runtime is required\n' >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/asip-appimage.XXXXXX")
trap 'rm -rf -- "$work"; rm -f -- "$output_dir/.appimage-payload-check.json"' 0 1 2 3 15
appdir="$work/AppDir"
mkdir -p "$appdir/usr/bin" "$appdir/usr/lib/asip-installer" "$appdir/usr/share/asip-installer" \
	"$appdir/usr/lib/python3/site-packages" "$appdir/usr/share/applications" \
	"$appdir/usr/share/icons/hicolor/scalable/apps"
cp -R "$repo/installer" "$appdir/usr/lib/asip-installer/installer"
cp "$artifact" "$manifest" "$appdir/usr/share/asip-installer/"
cp "$repo/packaging/appimage/org.asip.Installer.desktop" "$appdir/usr/share/applications/"
cp "$repo/packaging/appimage/org.asip.Installer.svg" "$appdir/usr/share/icons/hicolor/scalable/apps/org.asip.Installer.svg"
cp "$repo/installer/asip-installer" "$appdir/usr/bin/asip-installer"
chmod 0755 "$appdir/usr/bin/asip-installer" "$appdir/usr/lib/asip-installer/installer/privileged_helper.py"

# Bundle the old-userspace Python standard library and PyGObject package. GTK is
# dynamically loaded by GI, so pass its library explicitly for linuxdeploy to
# discover the native closure and let the GTK plugin gather schemas/resources.
python_version=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
python_stdlib=$(python3 -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')
gi_package=$(python3 -c 'import gi, pathlib; print(pathlib.Path(gi.__file__).parent)')
cp -R "$python_stdlib" "$appdir/usr/lib/python$python_version"
rm -rf -- "$appdir/usr/lib/python$python_version/site-packages" \
	"$appdir/usr/lib/python$python_version/dist-packages" \
	"$appdir/usr/lib/python$python_version/test" \
	"$appdir/usr/lib/python$python_version/ensurepip"
cp -R "$gi_package" "$appdir/usr/lib/python3/site-packages/gi"
gi_extension=$(find "$gi_package" -maxdepth 1 -type f -name '_gi*.so' -print -quit)
gtk_library=$(ldconfig -p | awk '/libgtk-4\.so\.1 .*x86-64/ { print $NF; exit }')
[ -n "$gi_extension" ] && [ -n "$gtk_library" ] || { printf 'PyGObject/GTK4 build libraries are unavailable\n' >&2; exit 1; }

# linuxdeploy gathers the native closure. AppRun remains ASIP-owned.
NO_STRIP=1 DEPLOY_GTK_VERSION=4 "$linuxdeploy" --appimage-extract-and-run --appdir "$appdir" --executable /usr/bin/python3 \
	--library "$gi_extension" --library "$gtk_library" \
	--desktop-file "$appdir/usr/share/applications/org.asip.Installer.desktop" \
	--icon-file "$appdir/usr/share/icons/hicolor/scalable/apps/org.asip.Installer.svg" --plugin gtk
# The upstream GTK plugin still carries an X11-only compatibility workaround.
# ASIP is compositor-neutral; GTK chooses Wayland or X11 from the live session.
sed -i '/export GDK_BACKEND=x11/d' "$appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh"
cp "$repo/installer/asip-installer" "$appdir/AppRun"
chmod 0755 "$appdir/AppRun"

mkdir -p "$output_dir"
output="$output_dir/ASIP-Installer-$version-x86_64.AppImage"
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0} ARCH=x86_64 "$appimagetool" --appimage-extract-and-run \
	--runtime-file "$runtime" "$appdir" "$output"
chmod 0755 "$output"
(cd "$output_dir" && sha256sum "$(basename -- "$output")" >"$(basename -- "$output").sha256")
python3 - "$manifest" "$output" <<'PY'
import json, pathlib, sys
manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
path = pathlib.Path(sys.argv[2])
metadata = {"schema_version": 1, "artifact": path.name, "version": manifest["version"],
            "source_commit": manifest["source_commit"], "release_payload": manifest["artifact"],
            "release_payload_sha256": manifest["sha256"]}
path.with_suffix(path.suffix + ".json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
PY
printf 'appimage=%s\nsha256=%s.sha256\n' "$output" "$output"
