"""Ten verified SQLite checkpoints, separate from the Linux snapshot backend."""
import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from .paths import FileLock, atomic_json, private_dir
from .store import identifier, now


def checksum(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda:handle.read(1024*1024),b""):
            value.update(chunk)
    return value.hexdigest()


class Recovery:
    limit = 10
    def __init__(self, store):
        self.store = store
        self.directory = private_dir(store.home/"recovery")

    def list(self):
        records = []
        for path in self.directory.glob("r_*.json"):
            try:
                records.append(json.loads(path.read_text()))
            except (OSError,ValueError):
                continue
        return sorted(records,key=lambda r:r["at"],reverse=True)[:self.limit]

    def checkpoint(self, reason, protect=None):
        if not isinstance(reason,str) or not reason.strip():
            raise ValueError("checkpoint reason is required")
        with FileLock(self.store.home/"recovery.lock"):
            ident = identifier("r")
            path = self.directory/(ident+".sqlite3")
            with self.store.connect() as source, closing(sqlite3.connect(path)) as target:
                source.backup(target)
                if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("checkpoint failed SQLite verification")
            path.chmod(0o600)
            record = {"id":ident,"at":now(),"reason":reason[:2000],"sha256":checksum(path),"backend":"sqlite",
                      "scope":"Agent memory only; credentials and computer files are not included"}
            atomic_json(self.directory/(ident+".json"),record)
            all_records = sorted(self.directory.glob("r_*.json"),key=lambda p:p.stat().st_mtime,reverse=True)
            retained = all_records[:self.limit]
            if protect:
                protected = self.directory/(protect+".json")
                if protected not in retained and protected in all_records:
                    retained[-1] = protected
            for old in (p for p in all_records if p not in retained):
                old.with_suffix(".sqlite3").unlink(missing_ok=True)
                old.unlink()
            self.store.record("operator","recovery","recovery.created",record["reason"],record)
            return record

    def restore(self, ident):
        if not isinstance(ident,str) or not ident.startswith("r_") or not ident[2:].isalnum():
            raise ValueError("invalid recovery ID")
        record = next((r for r in self.list() if r["id"]==ident),None)
        if not record:
            raise ValueError("unknown recovery record")
        path = self.directory/(ident+".sqlite3")
        if checksum(path)!=record["sha256"]:
            raise RuntimeError("checkpoint hash mismatch")
        # Refuse to restore under a running Beacon. Other agent processes must also be stopped.
        with FileLock(self.store.home/"beacon.lock"):
            self.checkpoint("Before restoring "+ident,protect=ident)
            with FileLock(self.store.home/"recovery.lock"):
                source = sqlite3.connect("file:"+path.as_posix()+"?mode=ro",uri=True)
                try:
                    if source.execute("PRAGMA integrity_check").fetchone()[0]!="ok" or source.execute("PRAGMA user_version").fetchone()[0]!=1:
                        raise RuntimeError("invalid checkpoint schema")
                    with self.store.connect() as target:
                        source.backup(target)
                finally:
                    source.close()
            self.store.record("operator","recovery","recovery.restored","Restored "+ident,{"recovery":ident})
        return {"restored":ident}
