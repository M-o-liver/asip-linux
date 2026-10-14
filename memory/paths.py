"""Platform paths and private, atomic state writes."""
import json
import os
from pathlib import Path
import sys
import tempfile


def state_home():
    if os.environ.get("ASIP_HOME"):
        return Path(os.environ["ASIP_HOME"]).expanduser().resolve()
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home()/"AppData/Local"))/"ASIP"
    if sys.platform == "darwin":
        return Path.home()/"Library/Application Support/ASIP"
    return Path(os.environ.get("XDG_STATE_HOME", Path.home()/".local/state"))/"asip/memory"


def private_dir(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        path.chmod(0o700)
    return path


def atomic_json(path, value):
    path = Path(path)
    private_dir(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix=".asip-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY | getattr(os,"O_DIRECTORY",0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


class FileLock:
    """One Beacon per state directory, also used to serialize checkpoints."""
    def __init__(self, path):
        self.path = Path(path)
        self.handle = None

    def __enter__(self):
        private_dir(self.path.parent)
        self.handle = self.path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                if self.path.stat().st_size == 0:
                    self.handle.write(b"0")
                    self.handle.flush()
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            self.handle = None
            raise RuntimeError("ASIP state is already in use by this operation") from None
        return self

    def __exit__(self, *_):
        if self.handle:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            self.handle.close()
