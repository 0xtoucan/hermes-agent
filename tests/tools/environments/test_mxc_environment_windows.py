"""Live contract of the Windows MXC backend against the real ``wxc-exec`` (skips when the MXC kit is
absent). Proves the properties the sandbox story rests on: commands run, state persists across
containers, out-of-policy writes and reads are refused by the OS, network is off by default, and
timeouts kill the container.
"""

from __future__ import annotations

import os
import subprocess

import pytest

from tools.environments import mxc_host

pytestmark = pytest.mark.windows_only


def _provisioned_shell() -> str | None:
    """The sandbox shell installed by a real opt-in on this machine; tests never download it."""
    local = os.environ.get("LOCALAPPDATA", "")
    candidate = os.path.join(local, "hermes", "bin", mxc_host.BUSYBOX_LOCAL_NAME) if local else ""
    return candidate if candidate and os.path.isfile(candidate) else None


@pytest.fixture
def live_env(monkeypatch):
    shell = _provisioned_shell()
    if shell is None:
        pytest.skip("sandbox shell not provisioned on this machine (enable the sandbox once first)")
    monkeypatch.setenv("TERMINAL_MXC_SHELL_PATH", shell)
    record = mxc_host.status(provision_shell=False)
    if not record["available"]:
        pytest.skip(f"MXC unavailable here: {record['reason']}")
    from tools.environments.mxc import MxcEnvironment
    # A top-level workspace keeps the test independent of ancestor ACLs (see mxc_host.workspace_ancestors).
    drive = os.path.splitdrive(os.getcwd())[0] + os.sep
    workspace = os.path.join(drive, "hermes-mxc-test-" + os.urandom(3).hex())
    os.makedirs(workspace, exist_ok=True)
    env = MxcEnvironment(cwd=workspace, timeout=60)
    try:
        yield env
    finally:
        env.cleanup()
        subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", workspace], capture_output=True)


def test_command_runs_and_reports_its_container(live_env):
    result = live_env.execute("echo hello-from-mxc")
    assert result["returncode"] == 0 and "hello-from-mxc" in result["output"]
    assert result["sandbox"]["backend"] == "mxc" and result["sandbox"]["container"].startswith("hermes-")


def test_exports_and_cwd_persist_across_containers(live_env):
    assert live_env.execute("export MXC_T=persisted; mkdir -p sub && cd sub")["returncode"] == 0
    result = live_env.execute("echo $MXC_T; pwd -P")
    assert "persisted" in result["output"] and result["output"].strip().endswith("/sub")


def test_out_of_policy_write_is_refused_by_the_os(live_env):
    target = os.path.join(os.path.expanduser("~"), "hermes-mxc-should-not-exist.txt")
    result = live_env.execute(f"echo nope > '{target.replace(os.sep, '/')}'")
    assert not os.path.exists(target)
    assert "Permission denied" in result["output"] and "[Sandbox]" in result["output"]
    assert result["sandbox"]["denied"]


def test_hermes_credentials_are_unreadable_from_the_sandbox(live_env):
    from hermes_constants import get_hermes_home
    env_file = (get_hermes_home() / ".env").as_posix()
    result = live_env.execute(f"cat '{env_file}' >/dev/null 2>&1; echo rc=$?")
    assert "rc=1" in result["output"]


def test_network_is_off_by_default(live_env):
    result = live_env.execute("curl.exe -sS -m 5 -o NUL https://example.com; echo rc=$?")
    assert "rc=0" not in result["output"]


def test_timeout_kills_the_container(live_env):
    result = live_env.execute("sleep 30", timeout=2)
    assert result["returncode"] == 124
