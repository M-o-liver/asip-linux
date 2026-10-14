"""Read-only import of Linux registry and journal metadata into project memory."""
from pathlib import Path
from .credentials import system_read
from .privacy import digest


def sync(store,limit=200):
    registry=system_read("project-list")
    if registry.get("error"):
        return {"imported":0,"error":registry["error"]}
    registered=0
    for entry in registry.get("entries",[]):
        if not Path(entry["path"]).is_dir():
            continue
        # Import the registry without changing its root-owned source.
        with store.connect(True) as db:
            pid,_=store._project(db,entry["path"])
        if not pid:
            store.register(entry["name"],entry["path"],entry.get("description",""))
        registered+=1
    records=[]; before=None
    while len(records)<limit:
        request={"details":True,"limit":min(100,limit-len(records))}
        if before:
            request["before"]=before
        response=system_read("journal-search",**request)
        if response.get("error"):
            break
        records.extend(response.get("records",[]))
        before=response.get("before")
        if not before:
            break
    imported=0
    for record in reversed(records):
        if not record.get("id") or record.get("op")=="request":
            continue
        # Raw command arguments, captured output, provider values and policy are excluded.
        metadata={k:record[k] for k in ("id","at","op","action","state","change_id","uid","exit","client","transport","result","tool","stdout_blob","stderr_blob","before_blob","after_blob") if k in record}
        metadata["source"]="linux-journal"
        external=record.get("change_id") or record["id"]
        summary=record.get("intent") or record.get("reason") or record.get("summary") or record.get("op","")
        key="linux:"+digest({k:record.get(k) for k in ("id","at","op","action","state")})
        with store.connect() as db:
            exists=db.execute("SELECT 1 FROM events WHERE source_key=?",(key,)).fetchone()
        if exists:
            continue
        store.record("linux-system",external,"system."+record["op"],str(summary),metadata,record.get("cwd"),source_key=key)
        imported+=1
    return {"imported":imported,"registered":registered,"scope":"Read-only journal metadata; original journal remains authoritative"}
