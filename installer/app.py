"""GTK bootstrap UI for the ASIP installer AppImage."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GLib, Gtk  # noqa: E402

from .distro import system_check
from .staging import StageError, stage_payload


class Installer(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="org.asip.Installer")
        self.window: Gtk.ApplicationWindow | None = None
        self.stack = Gtk.Stack()
        self.status = Gtk.Label(wrap=True, xalign=0)
        self.details = Gtk.Label(wrap=True, xalign=0, selectable=True)
        self.completion = Gtk.Label(wrap=True, xalign=0)
        self.stage: Path | None = None

    def do_activate(self) -> None:
        if self.window:
            self.window.present()
            return
        self.window = Gtk.ApplicationWindow(application=self, title="Install ASIP")
        self.window.set_default_size(760, 600)
        self.window.set_child(self.stack)
        self._page("welcome", "ASIP", "Privileged Linux operations for AI agents.",
                   [("Install ASIP Core", self._check)])
        self._page("check", "CHECKING YOUR COMPUTER", "A quick compatibility check.", [])
        self._page("install", "INSTALLING ASIP", "This usually takes a few minutes.", [])
        self._page("complete", "ASIP CORE IS INSTALLED", "", [("Close installer", lambda *_: self.quit())])
        self.stack.set_visible_child_name("welcome")
        self.window.present()

    def _page(self, name: str, title: str, body: str, actions) -> None:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=22,
                      margin_top=54, margin_bottom=48, margin_start=58, margin_end=58)
        heading = Gtk.Label(label=title, xalign=0)
        heading.add_css_class("title-1")
        copy = Gtk.Label(label=body, wrap=True, xalign=0)
        copy.add_css_class("title-3")
        box.append(heading); box.append(copy)
        if name == "check": box.append(self.details)
        if name == "install": box.append(self.status)
        if name == "complete": box.append(self.completion)
        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        for label, callback in actions:
            button = Gtk.Button(label=label)
            if not buttons.get_first_child(): button.add_css_class("suggested-action")
            button.connect("clicked", callback)
            buttons.append(button)
        box.append(buttons)
        self.stack.add_named(box, name)

    def _payload(self) -> tuple[Path, Path]:
        root = Path(os.environ.get("ASIP_INSTALLER_PAYLOAD_DIR", "/usr/share/asip-installer"))
        manifests = list(root.glob("release.json"))
        archives = list(root.glob("asip-*.tar.gz"))
        if len(manifests) != 1 or len(archives) != 1:
            raise StageError("This installer does not contain one complete ASIP release payload")
        return archives[0], manifests[0]

    def _check(self, _button) -> None:
        self.stack.set_visible_child_name("check")
        result = system_check()
        labels = {"architecture": "64-bit PC", "distribution": "Supported Linux",
                  "package_manager": "System packages", "python_runtime": "Host runtime",
                  "systemd": "System services",
                  "graphical_session": "Desktop session", "graphical_authentication": "System authentication",
                  "disk_space": "Disk space"}
        self.details.set_text("\n".join(("✓ " if ok else "× ") + labels[key]
                                        for key, ok in result["checks"].items()))
        if not result["ready"]:
            self.details.set_text(self.details.get_text() + "\n\nThis system is outside ASIP's supported installation contract.")
            return
        GLib.timeout_add(250, self._begin_install)

    def _begin_install(self) -> bool:
        self.stack.set_visible_child_name("install")
        self.status.set_text("Preparing and verifying the exact ASIP release…")
        threading.Thread(target=self._install_worker, daemon=True).start()
        return False

    def _install_worker(self) -> None:
        try:
            artifact, manifest = self._payload()
            self.stage = stage_payload(artifact, manifest)
            staged = json.loads((self.stage / "STAGED").read_text(encoding="utf-8"))
            GLib.idle_add(self.status.set_text, "Waiting for system authentication…")
            # Execute the reviewed helper source as immutable argv to the host
            # interpreter. Root never executes a user-mutable staged file or
            # traverses the AppImage mount.
            helper_source = Path(__file__).with_name("privileged_helper.py").read_text(encoding="utf-8")
            result = subprocess.run(["pkexec", "--disable-internal-agent", "/usr/bin/python3",
                                     "-I", "-c", helper_source, str(self.stage), staged["sha256"],
                                     staged["version"], staged["source_commit"]],
                                    text=True, capture_output=True, check=False)
            if result.returncode:
                message = result.stderr.strip() or ("Authentication was cancelled." if result.returncode == 126 else "Installation did not complete.")
                raise RuntimeError(message)
            checks = self._verify()
            if not all(checks.values()):
                failed = ", ".join(name for name, passed in checks.items() if not passed)
                raise RuntimeError("Installation finished but verification failed: " + failed)
            GLib.idle_add(self._after_install)
        except Exception as exc:
            GLib.idle_add(self.status.set_text, f"ASIP was not installed: {exc}\n\nYou can close this window and retry safely.")
        finally:
            if self.stage:
                shutil.rmtree(self.stage, ignore_errors=True)
                self.stage = None

    def _verify(self) -> dict[str, bool]:
        def active(unit: str) -> bool:
            return subprocess.run(["systemctl", "is-active", "--quiet", unit], check=False).returncode == 0
        home = Path.home()
        expected = json.loads((self.stage / "STAGED").read_text(encoding="utf-8"))["version"]
        installed_version = Path("/usr/lib/asip/VERSION")
        checks = {
            "installed identity": installed_version.is_file() and installed_version.read_text(encoding="utf-8").strip() == expected,
            "Core socket active": active("asip.socket"),
            "read socket active": active("asip-read.socket"),
            "read socket": Path("/run/asip/read.sock").exists(),
            "privileged socket": Path("/run/asip/sock").exists(),
            "MCP admin": (home / ".local/bin/asip-mcp-admin").is_file(),
            "MCP inspect": (home / ".local/bin/asip-mcp-inspect").is_file(),
        }
        if os.access("/run/asip/sock", os.R_OK | os.W_OK):
            checks["normal-user Core access"] = subprocess.run(
                ["/usr/local/bin/asip", "version"], capture_output=True, check=False).returncode == 0
            checks["doctor"] = subprocess.run(
                ["/usr/local/bin/asip", "doctor"], capture_output=True, check=False).returncode == 0
        return checks

    def _after_install(self) -> bool:
        if os.access("/run/asip/sock", os.R_OK | os.W_OK):
            self.completion.set_text("ASIP Core is installed. Run asip doctor and continue with your agent's MCP interface.")
        else:
            self.completion.set_text("ASIP Core is installed. Sign out and back in once so this session receives the asip and asip-read group memberships. Then run asip doctor and continue with your agent's MCP interface.")
        self.stack.set_visible_child_name("complete")
        return False

def main() -> int:
    application = Installer()
    if os.environ.get("ASIP_INSTALLER_SMOKE") == "1":
        def complete_smoke() -> bool:
            print("ASIP_INSTALLER_SMOKE_OK", flush=True)
            application.quit()
            return False
        GLib.timeout_add(750, complete_smoke)
    return application.run(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
