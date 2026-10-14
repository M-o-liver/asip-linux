"""Native per-user Beacon startup registration; never changes machine services."""
import os
from pathlib import Path
import plistlib
import shlex
import sys


def install():
    from .integrations import backup
    argv=[sys.executable,"-m","memory","beacon"]
    if sys.platform=="darwin":
        path=Path.home()/"Library/LaunchAgents/org.asip.beacon.plist"
        value={"Label":"org.asip.beacon","ProgramArguments":argv+["--tray"],"RunAtLoad":True,
               "KeepAlive":{"SuccessfulExit":False},"ProcessType":"Interactive"}
        previous=backup(path)
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(plistlib.dumps(value))
        return {"path":str(path),"backup":previous,"activate":"launchctl bootstrap gui/$(id -u) "+shlex.quote(str(path))}
    if os.name=="nt":
        import subprocess
        path=Path(os.environ.get("APPDATA",str(Path.home()/"AppData/Roaming")))/"Microsoft/Windows/Start Menu/Programs/Startup/ASIP Beacon.cmd"
        previous=backup(path)
        path.parent.mkdir(parents=True,exist_ok=True)
        python=Path(sys.executable).with_name("pythonw.exe")
        windows_argv=[str(python if python.exists() else Path(sys.executable)),*argv[1:],"--tray"]
        path.write_text('@echo off\nstart "ASIP Beacon" '+subprocess.list2cmdline(windows_argv)+'\n')
        return {"path":str(path),"backup":previous,"activate":"Starts at next Windows sign-in; run asip-beacon --tray now"}
    root=Path(os.environ.get("XDG_CONFIG_HOME",str(Path.home()/".config")))/"systemd/user"
    path=root/"asip-beacon.service"
    previous=backup(path); root.mkdir(parents=True,exist_ok=True)
    # systemd uses its own quoting, not a shell. Percent specifiers must be escaped.
    import json
    command=" ".join(json.dumps(a.replace("%","%%")) for a in argv)
    path.write_text("[Unit]\nDescription=ASIP agent memory Beacon\nAfter=graphical-session.target\n\n[Service]\nExecStart="+command+"\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n")
    applications=Path(os.environ.get("XDG_DATA_HOME",str(Path.home()/".local/share")))/"applications"
    applications.mkdir(parents=True,exist_ok=True)
    launch=applications/"org.asip.Beacon.desktop"
    backup(launch)
    # Desktop Entry escaping is two layers: quoted argument escaping then value escaping.
    def quote(argument):
        argument=argument.replace("%","%%")
        for char in ("\\",'"',"`","$"):
            argument=argument.replace(char,"\\"+char)
        return '"'+argument.replace("\\","\\\\")+'"'
    launch.write_text("[Desktop Entry]\nType=Application\nName=ASIP\nComment=The memory of your agents\nExec="+" ".join(quote(a) for a in argv+["--open"])+"\nIcon=network-transmit-receive\nTerminal=false\nCategories=Development;Utility;\n")
    return {"path":str(path),"backup":previous,"launcher":str(launch),
            "activate":"systemctl --user daemon-reload && systemctl --user enable --now asip-beacon.service",
            "tray":"For GNOME use the bundled ASIP Beacon shell extension; other desktops can run asip-beacon --tray"}
