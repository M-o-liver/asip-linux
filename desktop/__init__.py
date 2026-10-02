"""Native ASIP application."""

from pathlib import Path


def product_version() -> str:
    version_file = Path(__file__).resolve().parents[1] / "VERSION"
    try:
        return version_file.read_text(encoding="utf-8").strip()
    except OSError:
        return "unknown"


__all__ = ["product_version"]
