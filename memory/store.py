"""Durable, transactional memory and searchable evidence with an integrity chain."""
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
import getpass
import json
import os
from pathlib import Path
import sqlite3
import uuid

from .paths import private_dir, state_home
from .privacy import clean, digest, text
from .projects import contains, discover

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 repository TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roots (path TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, agent TEXT NOT NULL, external_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
 os_user TEXT NOT NULL, started_at TEXT NOT NULL, last_at TEXT NOT NULL, state TEXT NOT NULL,
 UNIQUE(agent, external_id));
CREATE TABLE IF NOT EXISTS intents (
 id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), project_id TEXT REFERENCES projects(id),
 summary TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL,
 session_id TEXT REFERENCES sessions(id), project_id TEXT REFERENCES projects(id),
 intent_id TEXT REFERENCES intents(id), kind TEXT NOT NULL, summary TEXT NOT NULL,
 data TEXT NOT NULL, source_key TEXT UNIQUE, previous_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS event_project ON events(project_id, seq);
CREATE INDEX IF NOT EXISTS event_session ON events(session_id, seq);
CREATE TABLE IF NOT EXISTS links (
 source TEXT NOT NULL REFERENCES projects(id), target TEXT NOT NULL REFERENCES projects(id),
 relation TEXT NOT NULL, PRIMARY KEY(source,target,relation));
PRAGMA user_version=1;
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def identifier(prefix):
    return prefix+"_"+uuid.uuid4().hex


class Store:
    def __init__(self, home=None):
        self.home = private_dir(home or state_home())
        self.path = self.home/"memory.sqlite3"
        # Set the mode before SQLite can create WAL/SHM siblings.
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        if os.name != "nt":
            self.path.chmod(0o600)
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 1:
                raise RuntimeError("Memory schema is newer than this ASIP; upgrade ASIP")
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)

    @contextmanager
    def connect(self, write=False):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _project(self, db, cwd, project_id=None):
        if project_id:
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError("unknown project")
            return project_id, "explicit"
        # Resolve a nested independent repository before a broad parent registration.
        repo = discover(cwd) if cwd else None
        if repo:
            db.execute("INSERT OR IGNORE INTO projects(id,name,repository,created_at) VALUES(?,?,?,?)",
                       (repo["id"], repo["name"], repo["repository"], now()))
            db.execute("INSERT INTO roots VALUES(?,?) ON CONFLICT(path) DO UPDATE SET project_id=excluded.project_id",
                       (repo["root"], repo["id"]))
            return repo["id"], repo["method"]
        matches = [dict(r) for r in db.execute("SELECT * FROM roots") if cwd and contains(r["path"], cwd)]
        if matches:
            return max(matches, key=lambda r: len(r["path"]))["project_id"], "registered-root"
        return None, "unresolved"

    def register(self, name, root, description=""):
        root = str(Path(root).expanduser().resolve())
        if not Path(root).is_dir():
            raise ValueError("project root must be an existing directory")
        with self.connect(True) as db:
            pid, _ = self._project(db, root)
            if not pid:
                pid = identifier("p")
                db.execute("INSERT INTO projects VALUES(?,?,?,?,?)", (pid, text(name,128), text(description), "", now()))
                db.execute("INSERT INTO roots VALUES(?,?)", (root, pid))
            db.execute("UPDATE projects SET name=?, description=? WHERE id=?", (text(name,128), text(description), pid))
            self._append(db, "project.registered", "Registered "+text(name,128), {"root": root}, project_id=pid)
        return self.project(pid)

    def _session(self, db, agent, external_id, model=""):
        agent, external_id = text(agent,128), text(external_id,256)
        if not agent or not external_id:
            raise ValueError("agent and external session ID are required")
        sid = "s_"+uuid.uuid5(uuid.NAMESPACE_URL, agent+":"+external_id).hex
        stamp = now()
        db.execute("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?,?,?,?)",
                   (sid, agent, external_id, text(model,128), getpass.getuser(), stamp, stamp, "observed"))
        if model:
            db.execute("UPDATE sessions SET model=? WHERE id=?", (text(model,128), sid))
        return sid

    def _append(self, db, kind, summary, data, session_id=None, project_id=None, intent_id=None, source_key=None):
        data = clean(data or {})
        if len(json.dumps(data)) > 65536:
            raise ValueError("event metadata exceeds 64KiB")
        if source_key:
            old = db.execute("SELECT * FROM events WHERE source_key=?", (source_key,)).fetchone()
            if old:
                if (old["kind"], old["summary"], old["data"], old["session_id"], old["project_id"], old["intent_id"]) != (
                    kind, text(summary), json.dumps(data, sort_keys=True, ensure_ascii=False, allow_nan=False), session_id, project_id, intent_id):
                    raise ValueError("source key was already used for a different event")
                return dict(old)
        prior = db.execute("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").fetchone()
        item = {"id": identifier("e"), "at": now(), "session_id": session_id, "project_id": project_id,
                "intent_id": intent_id, "kind": text(kind,128), "summary": text(summary),
                "data": json.dumps(data, sort_keys=True, ensure_ascii=False, allow_nan=False),
                "source_key": source_key, "previous_hash": prior[0] if prior else ""}
        item["hash"] = digest(item)
        columns = list(item)
        db.execute("INSERT INTO events("+",".join(columns)+") VALUES("+",".join("?" for _ in columns)+")", list(item.values()))
        if session_id:
            state = {"session.started":"ready", "session.ended":"ended", "tool.started":"working",
                     "turn.ended":"ready", "session.interrupted":"interrupted"}.get(kind, "observed")
            db.execute("UPDATE sessions SET last_at=?, state=? WHERE id=?", (item["at"], state, session_id))
        return item

    def record(self, agent, external_id, kind, summary="", data=None, cwd=None,
               project_id=None, intent_id=None, source_key=None, model=""):
        with self.connect(True) as db:
            sid = self._session(db, agent, external_id, model)
            pid, method = self._project(db, cwd, project_id)
            if intent_id:
                intent = db.execute("SELECT * FROM intents WHERE id=?", (intent_id,)).fetchone()
                if not intent or intent["session_id"] != sid:
                    raise ValueError("intent does not belong to this session")
                if pid and intent["project_id"] != pid:
                    raise ValueError("intent belongs to a different project")
                pid = intent["project_id"]
            payload = {**(data or {}), "association": {"method": method, "cwd": str(cwd) if cwd else None}}
            item = self._append(db, kind, summary, payload, sid, pid, intent_id, source_key)
        return self.decode(item)

    def start_intent(self, agent, external_id, summary, cwd=None, project_id=None):
        summary = text(summary)
        if not summary:
            raise ValueError("intent summary is required")
        with self.connect(True) as db:
            sid = self._session(db, agent, external_id)
            pid, method = self._project(db, cwd, project_id)
            iid, stamp = identifier("i"), now()
            db.execute("INSERT INTO intents VALUES(?,?,?,?,?,?,?,?)", (iid, sid, pid, summary, "open", "", stamp, stamp))
            self._append(db, "intent.started", summary, {"association":method}, sid, pid, iid)
        return self.intent(iid)

    def close_intent(self, intent_id, status, outcome, evidence=None):
        if status not in ("finished", "failed", "held"):
            raise ValueError("status must be finished, failed or held")
        outcome = text(outcome)
        if not outcome:
            raise ValueError("a concrete outcome or unresolved condition is required")
        with self.connect(True) as db:
            old = db.execute("SELECT * FROM intents WHERE id=?", (intent_id,)).fetchone()
            if not old:
                raise ValueError("unknown intent")
            if old["status"] not in ("open", "held"):
                raise ValueError("intent is already closed")
            db.execute("UPDATE intents SET status=?,outcome=?,updated_at=? WHERE id=?", (status, outcome, now(), intent_id))
            self._append(db, "intent."+status, outcome, {"evidence":evidence or {}}, old["session_id"], old["project_id"], intent_id)
        return self.intent(intent_id)

    @staticmethod
    def decode(row):
        item = dict(row)
        if "data" in item:
            item["data"] = json.loads(item["data"])
        return item

    def intent(self, iid):
        with self.connect() as db:
            row = db.execute("SELECT * FROM intents WHERE id=?", (iid,)).fetchone()
            if not row:
                raise ValueError("unknown intent")
            return dict(row)

    def events(self, project_id=None, session_id=None, query="", before=None, limit=30):
        limit = max(1, min(int(limit),100))
        clauses, values = [], []
        for key, value in (("project_id",project_id),("session_id",session_id)):
            if value:
                clauses.append(key+"=?"); values.append(value)
        if before is not None:
            clauses.append("seq<?"); values.append(int(before))
        if query:
            clauses.append("(summary LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\')")
            pattern = "%"+text(query,256).replace("\\","\\\\").replace("%","\\%").replace("_","\\_")+"%"
            values.extend([pattern]*3)
        with self.connect() as db:
            rows = db.execute("SELECT * FROM events"+(" WHERE "+" AND ".join(clauses) if clauses else "")+" ORDER BY seq DESC LIMIT ?", [*values,limit+1]).fetchall()
        return {"events":[self.decode(r) for r in rows[:limit]], "before":rows[limit-1]["seq"] if len(rows)>limit else None}

    def projects(self):
        with self.connect() as db:
            rows = db.execute("SELECT p.*, (SELECT count(*) FROM events e WHERE e.project_id=p.id) event_count, "
                              "(SELECT max(at) FROM events e WHERE e.project_id=p.id) last_at, "
                              "(SELECT count(*) FROM intents i WHERE i.project_id=p.id AND status IN ('open','held')) unresolved "
                              "FROM projects p ORDER BY coalesce(last_at,p.created_at) DESC").fetchall()
            result = [dict(r) for r in rows]
            for item in result:
                item["roots"] = [r[0] for r in db.execute("SELECT path FROM roots WHERE project_id=?",(item["id"],))]
            return result

    def project(self, pid):
        item = next((p for p in self.projects() if p["id"]==pid), None)
        if not item:
            raise ValueError("unknown project")
        with self.connect() as db:
            item["intents"] = [dict(r) for r in db.execute("SELECT * FROM intents WHERE project_id=? ORDER BY updated_at DESC LIMIT 100",(pid,))]
            item["sessions"] = [dict(r) for r in db.execute("SELECT DISTINCT s.* FROM sessions s JOIN events e ON s.id=e.session_id WHERE e.project_id=? ORDER BY s.last_at DESC LIMIT 100",(pid,))]
            item["links"] = [dict(r) for r in db.execute("SELECT * FROM links WHERE source=? OR target=?",(pid,pid))]
        item.update(self.events(project_id=pid))
        return item

    def link(self, source, target, relation="related"):
        if source == target:
            raise ValueError("choose two different projects")
        with self.connect(True) as db:
            db.execute("INSERT OR IGNORE INTO links VALUES(?,?,?)", (source,target,text(relation,128)))
            self._append(db,"project.linked",text(relation,128),{"target":target},project_id=source)
        return {"source":source,"target":target,"relation":relation}

    def overview(self):
        with self.connect() as db:
            sessions = [dict(r) for r in db.execute("SELECT * FROM sessions ORDER BY last_at DESC LIMIT 100")]
            intents = [dict(r) for r in db.execute("SELECT * FROM intents WHERE status IN ('open','held') ORDER BY updated_at DESC LIMIT 100")]
            counts = {t:db.execute("SELECT count(*) FROM "+t).fetchone()[0] for t in ("projects","sessions","events","intents")}
        cutoff = (datetime.now(timezone.utc)-timedelta(minutes=15)).isoformat()
        for s in sessions:
            s["recent"] = s["last_at"] > cutoff and s["state"] not in ("ended","interrupted")
        return {"projects":self.projects(),"sessions":sessions,"unresolved":intents,"counts":counts}

    def integrity(self):
        previous = ""
        count = 0
        with self.connect() as db:
            sqlite_status = db.execute("PRAGMA integrity_check").fetchone()[0]
            foreign = list(db.execute("PRAGMA foreign_key_check"))
            for row in db.execute("SELECT * FROM events ORDER BY seq"):
                item = dict(row); item.pop("seq")
                expected = item.pop("hash")
                if item["previous_hash"] != previous or digest(item) != expected:
                    return {"ok":False,"first_invalid_event":row["id"],"checked":count}
                previous = expected; count += 1
        return {"ok":sqlite_status=="ok" and not foreign,"sqlite":sqlite_status,"events":count,"head":previous,
                "scope":"Local corruption detection; the owning user can rewrite this database."}
