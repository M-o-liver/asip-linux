"""Finite child execution with bounded output, deadlines and cancellation."""
import hashlib
import os
import signal
import subprocess
import threading
import time


def stop(proc):
    if os.name=="nt":
        subprocess.run(["taskkill","/PID",str(proc.pid),"/T","/F"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
    else:
        try:
            os.killpg(proc.pid,signal.SIGKILL)
        except ProcessLookupError:
            pass


def execute(argv,env,cwd=None,timeout=300):
    if not argv or not all(isinstance(a,str) and "\0" not in a for a in argv):
        raise ValueError("invalid command argv")
    kwargs = {"creationflags":subprocess.CREATE_NEW_PROCESS_GROUP} if os.name=="nt" else {"start_new_session":True}
    proc = subprocess.Popen(argv,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
    limited = threading.Event()
    captures = {}
    def drain(name,pipe):
        value=hashlib.sha256(); excerpt=bytearray(); size=0
        try:
            while True:
                block=pipe.read(4096)
                if not block:
                    break
                size+=len(block); value.update(block)
                excerpt.extend(block[:max(0,8192-len(excerpt))])
                if size>8*1024*1024:
                    limited.set()
        finally:
            pipe.close()
            captures[name]={"text":excerpt.decode(errors="replace"),"bytes":size,"sha256":value.hexdigest(),"truncated":size>8192}
    readers=[threading.Thread(target=drain,args=(name,pipe),daemon=True) for name,pipe in (("stdout",proc.stdout),("stderr",proc.stderr))]
    for reader in readers:
        reader.start()
    deadline=time.monotonic()+timeout
    timed_out=False
    try:
        while proc.poll() is None:
            if limited.is_set() or time.monotonic()>deadline:
                timed_out=time.monotonic()>deadline
                stop(proc); break
            time.sleep(0.02)
        proc.wait(timeout=10)
        for reader in readers:
            reader.join(timeout=max(0,min(1,deadline-time.monotonic())))
        if any(r.is_alive() for r in readers):
            # A descendant has retained pipes after its parent exited.
            stop(proc)
            for reader in readers:
                reader.join(timeout=2)
        return {"exit":proc.returncode,"timed_out":timed_out,"output_limited":limited.is_set(),
                "capture_incomplete":any(r.is_alive() for r in readers),**captures}
    except BaseException:
        stop(proc); proc.wait(timeout=10)
        raise
