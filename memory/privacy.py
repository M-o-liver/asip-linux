"""Defense in depth for explicit summaries; hooks never retain raw tool data."""
import hashlib
import json
import re

SECRET_FIELD = re.compile(r"password|secret|token|api.?key|authorization|cookie|credential|private.?key", re.I)
SECRET_VALUE = re.compile(
    r"(?i)(?:bearer\s+\S+|(?:sk-(?:ant-)?|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_\-]{12,}"
    r"|(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*[\"']?[^\s\"',;]+)"
)
URL_USER = re.compile(r"(https?://)[^/\s@]+@", re.I)


def digest(value):
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def clean(value, depth=0):
    if depth > 8:
        return "[depth limited]"
    if isinstance(value, dict):
        return {str(k)[:128]: "[redacted]" if SECRET_FIELD.search(str(k)) else clean(v, depth+1)
                for k, v in list(value.items())[:100]}
    if isinstance(value, (tuple, list)):
        return [clean(v, depth+1) for v in value[:100]]
    if isinstance(value, str):
        return SECRET_VALUE.sub("[redacted]", URL_USER.sub(r"\1[redacted]@", value))[:8192]
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return str(value)[:512]


def text(value, limit=2000):
    if not isinstance(value, str):
        raise ValueError("text must be a string")
    return clean(value).strip()[:limit]
