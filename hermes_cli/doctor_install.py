"""``hermes doctor`` — Installation section: source checkout state."""

from __future__ import annotations

import subprocess
from pathlib import Path

from hermes_cli.doctor_report import Finding, check_info, check_ok, check_warn, doctor_check


def collect_source_tree_state(project_root: Path) -> list[tuple[str, str, str]]:
    """Return non-failing diagnostics for the Hermes source checkout.

    The running install may be a git checkout with local patches applied. Doctor
    should surface that state so users can tell whether they are running clean
    upstream, a fork branch, or dirty live source.
    """
    root = Path(project_root)
    git_dir = root / ".git"
    if not git_dir.exists():
        return []

    def _git(*args: str) -> str | None:
        try:
            proc = subprocess.run(
                ["git", "-C", str(root), *args],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except Exception:
            return None
        if proc.returncode != 0:
            return None
        return proc.stdout.strip()

    rows: list[tuple[str, str, str]] = []
    branch = _git("branch", "--show-current") or "(detached)"
    head = _git("rev-parse", "--short=12", "HEAD")
    if head:
        rows.append(("info", "Source checkout", f"{branch} @ {head}"))

    upstream = _git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    if upstream:
        ahead_behind = _git("rev-list", "--left-right", "--count", f"{upstream}...HEAD")
        if ahead_behind:
            try:
                behind_s, ahead_s = ahead_behind.split()
                behind, ahead = int(behind_s), int(ahead_s)
            except Exception:
                behind = ahead = 0
            level = "ok" if ahead == 0 and behind == 0 else "warn"
            rows.append((level, f"Upstream {upstream}", f"behind {behind}, ahead {ahead}"))

    status = _git("status", "--porcelain")
    if status is None:
        return rows
    changed = [line for line in status.splitlines() if line and not line.startswith("?? ")]
    untracked = [line for line in status.splitlines() if line.startswith("?? ")]
    if changed:
        rows.append(("warn", "Source checkout has local modifications", f"{len(changed)} tracked file(s) changed"))
    else:
        rows.append(("ok", "No tracked source modifications", ""))
    if untracked:
        sample = untracked[0][3:]
        suffix = f"; first: {sample}" if sample else ""
        rows.append(("info", "Untracked source files", f"{len(untracked)} file(s){suffix}"))
    return rows


def report_source_tree_state(project_root: Path) -> None:
    for level, text, detail in collect_source_tree_state(project_root):
        if level == "ok":
            check_ok(text, detail)
        elif level == "warn":
            check_warn(text, detail)
        else:
            check_info(text, detail)


@doctor_check(on_error="Installation check failed", detail="({e})")
def _check_installation(should_fix: bool, f: Finding) -> None:
    from hermes_cli.doctor import PROJECT_ROOT
    report_source_tree_state(PROJECT_ROOT)
