#!/usr/bin/env python3
"""Qualify source-only assumptions from the tracked repository payload."""

from __future__ import annotations

import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile


REPOSITORY = pathlib.Path(__file__).resolve().parents[1]
# Public release documents are newly added in the working tree while the
# original private repository index remains a separate history.
RELEASE_DOCUMENTS = (
    pathlib.Path("LICENSE"), pathlib.Path("SECURITY.md"),
    pathlib.Path("CONTRIBUTING.md"), pathlib.Path("CHANGELOG.md"),
)


def tracked_paths() -> list[pathlib.Path]:
    result = subprocess.run(
        ["git", "-C", str(REPOSITORY), "ls-files", "-z"],
        check=True,
        stdout=subprocess.PIPE,
    )
    return [pathlib.Path(os.fsdecode(item)) for item in result.stdout.split(b"\0") if item]


def copy_tracked_tree(destination: pathlib.Path) -> None:
    for relative in sorted(set(tracked_paths()) | set(RELEASE_DOCUMENTS)):
        source = REPOSITORY / relative
        target = destination / relative
        if not source.exists() and not source.is_symlink():
            raise RuntimeError(f"tracked path is missing from the working tree: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink():
            target.symlink_to(os.readlink(source))
        else:
            shutil.copy2(source, target)
            target.chmod(stat.S_IMODE(source.stat().st_mode))


def run(*command: str, cwd: pathlib.Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=cwd, env=env, check=True)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="asip-clean-tree-") as directory:
        root = pathlib.Path(directory)
        checkout = root / "checkout"
        checkout.mkdir()
        copy_tracked_tree(checkout)

        forbidden = ["wheelhouse", "wheelhouse-fleet", "build", "dist"]
        present = [name for name in forbidden if (checkout / name).exists()]
        if present:
            raise RuntimeError(f"generated paths leaked into tracked payload: {', '.join(present)}")
        if any(checkout.rglob("__pycache__")):
            raise RuntimeError("Python cache directory leaked into tracked payload")

        run(
            sys.executable,
            "-m",
            "unittest",
            "-v",
            "tests.test_cli.CliTestCase.test_checkout_installer_is_idempotent",
            cwd=checkout,
        )
        environment = dict(os.environ, SOURCE_DATE_EPOCH="0")
        run(
            str(checkout / "scripts" / "build_release.sh"),
            str(root / "release"),
            cwd=checkout,
            env=environment,
        )

    print("ASIP clean tracked-tree qualification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
