"""Windows MXC terminal backend: policy-to-container-config generation, the POSIX session scripts,
denial interpretation, workspace safety, host status verdicts, and the wiring into the terminal tool.

Everything here is host-independent (pure functions plus stubbed probes). The live-container
contract is in ``test_mxc_environment_windows.py`` (``windows_only``).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from tools.environments import mxc_host
from tools.environments.mxc import (GIT_ANCESTOR_DENIAL, MXC_SCHEMA_VERSION, build_container_config,
                                    denial_note, find_denials, normalize_grant_paths, posix_bootstrap_script,
                                    posix_wrap_command_script, to_forward_slashes, to_native_path,
                                    unsafe_workspace_reason)

# Constructs that busybox ``sh`` rejects or misparses; none may appear in the scripts the sandbox runs.
_BASH_ONLY = ("declare ", "shopt", "source ", "${!", "builtin ", "[[", "alias -p")


def _kwargs(cwd="C:/proj", snap="C:/tmp/hermes-snap-x.sh"):
    return dict(quoted_cwd=f"'{cwd}'", quoted_snap=f"'{snap}'", snap_tmp_template=f"'{snap}.tmp.XXXXXXXXXX'",
                cwd_marker="__HERMES_CWD_x__")


# ── container config ─────────────────────────────────────────────────────────

def test_container_config_is_one_shot_processcontainer_with_explicit_network_and_ui():
    cfg = build_container_config(
        container_id="c1", command_line='"C:\\bb.exe" sh C:\\t\\cmd.sh', cwd="C:/proj",
        env={"PATH": "C:\\x", "TEMP": "C:\\t"}, readwrite_paths=["C:/proj"], readonly_paths=["C:/tools"], network=False)
    assert cfg["version"] == MXC_SCHEMA_VERSION
    assert cfg["containment"] == "processcontainer"
    assert "phase" not in cfg
    assert cfg["process"]["timeout"] == 0, "Hermes owns timeouts; the launcher must not race it"
    assert cfg["process"]["env"] == ["PATH=C:\\x", "TEMP=C:\\t"]
    assert cfg["network"] == {"egress": {"default": "deny"}}, "a network section must exist even when egress is denied"
    assert cfg["ui"]["disable"] is False and cfg["ui"]["clipboard"] == "none" and cfg["ui"]["injection"] is False
    assert cfg["filesystem"]["readwritePaths"] == [os.path.normpath("C:/proj")]
    assert cfg["filesystem"]["readonlyPaths"] == [os.path.normpath("C:/tools")]


def test_container_config_network_toggle_maps_to_egress_default():
    on = build_container_config(container_id="c", command_line="x", cwd="C:/p", env={}, readwrite_paths=["C:/p"],
                                readonly_paths=[], network=True)
    assert on["network"]["egress"]["default"] == "allow"


def test_grant_paths_dedupe_case_insensitively_and_drop_relative_entries():
    grants = normalize_grant_paths(["C:/Proj", "c:\\proj\\", "relative/dir", "", "D:/other"])
    assert [g.lower() for g in grants] == [os.path.normpath("c:/proj").lower(), os.path.normpath("d:/other").lower()]


def test_readonly_grant_never_duplicates_a_readwrite_grant():
    cfg = build_container_config(container_id="c", command_line="x", cwd="C:/p", env={}, readwrite_paths=["C:/p"],
                                readonly_paths=["c:/P", "C:/tools"], network=False)
    assert cfg["filesystem"]["readonlyPaths"] == [os.path.normpath("C:/tools")]


# ── POSIX scripts ────────────────────────────────────────────────────────────

def test_bootstrap_and_wrapper_avoid_bash_only_syntax():
    boot = posix_bootstrap_script(excluded_names=["FOO_SECRET"], **_kwargs())
    wrap = posix_wrap_command_script("echo hi", passthrough_names=[], snapshot_ready=True, **_kwargs())
    for script in (boot, wrap):
        for construct in _BASH_ONLY:
            assert construct not in script, f"{construct!r} is not POSIX sh: {script}"


def test_wrapper_sources_snapshot_with_dot_runs_command_and_emits_marker():
    wrap = posix_wrap_command_script("echo 'it''s'", passthrough_names=[], snapshot_ready=True, **_kwargs())
    lines = wrap.splitlines()
    assert lines[0].startswith(". 'C:/tmp/hermes-snap-x.sh'")
    assert "cd -- 'C:/proj' || exit 126" in lines
    assert any(line.startswith("eval '") for line in lines)
    assert "__HERMES_CWD_x__" in wrap and "pwd -P" in wrap
    assert lines[-1] == "exit $__hermes_ec"


def test_wrapper_without_snapshot_neither_sources_nor_redumps():
    wrap = posix_wrap_command_script("true", passthrough_names=[], snapshot_ready=False, **_kwargs())
    assert ". '" not in wrap and "export -p" not in wrap


def test_bootstrap_excludes_session_vars_by_name_and_prefix():
    boot = posix_bootstrap_script(excluded_names=["MY_TOKEN"], **_kwargs())
    assert "unset" in boot and "MY_TOKEN" in boot
    assert "HERMES_SESSION_*" in boot and "HERMES_UI_SESSION_ID" in boot
    assert "export -p" in boot and "mv -f" in boot


# ── paths ────────────────────────────────────────────────────────────────────

def test_path_conversions_round_trip_windows_paths():
    assert to_forward_slashes("C:\\Users\\x\\p") == "C:/Users/x/p"
    assert to_native_path("C:/Users/x/p") == os.path.normpath("C:/Users/x/p")
    assert to_native_path("relative") == "relative"


# ── denials ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("line,expected", [
    ("sh: can't create C:/Users/t/nope.txt: Permission denied", os.path.normpath("C:/Users/t/nope.txt")),
    ("cat: can't open 'C:/Users/t/.env': Permission denied", os.path.normpath("C:/Users/t/.env")),
    ("mkdir: can't create directory 'C:/work/': Permission denied", os.path.normpath("C:/work/")),
    ("PermissionError: [Errno 13] Permission denied: 'C:\\\\Users\\\\t\\\\x'", os.path.normpath("C:\\\\Users\\\\t\\\\x")),
    ("OSError: [WinError 5] Access is denied: 'C:\\Users\\t\\y'", os.path.normpath("C:\\Users\\t\\y")),
    ("Error: EACCES: permission denied, open 'C:\\Users\\t\\z'", os.path.normpath("C:\\Users\\t\\z")),
    ("fatal: unable to get current working directory: Permission denied", GIT_ANCESTOR_DENIAL),
    ("Access is denied.", "a path outside the sandbox policy"),
])
def test_find_denials_extracts_the_refused_location(line, expected):
    assert find_denials("some output\n" + line + "\nmore") == [expected]


def test_find_denials_is_silent_on_ordinary_output_and_dedupes():
    assert find_denials("hello\nall good\nexit=0") == []
    twice = "sh: can't create C:/a: Permission denied\nsh: can't create C:/a: Permission denied"
    assert find_denials(twice) == [os.path.normpath("C:/a")]


def test_denial_note_names_policy_and_git_remedy():
    policy = mxc_host.MxcPolicy(readwrite_paths=("C:\\extra",), readonly_paths=(), network=False)
    note = denial_note([os.path.normpath("C:/Users/t/x"), GIT_ANCESTOR_DENIAL], workspace="C:\\proj", policy=policy)
    assert "[Sandbox]" in note and "C:\\proj" in note and "C:\\extra" in note
    assert "network: off" in note and "read-only: (none)" in note
    assert "Prepare workspace" in note
    assert "Do not try to work around the sandbox" in note


# ── workspace safety ─────────────────────────────────────────────────────────

def test_unsafe_workspace_refuses_home_drive_root_and_hermes_home_parents(tmp_path, monkeypatch):
    home = tmp_path / "home"
    hermes_home = tmp_path / "data" / ".hermes"
    hermes_home.mkdir(parents=True)
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setattr(os.path, "expanduser", lambda p: str(home) if p == "~" else p)
    assert "home folder" in unsafe_workspace_reason(str(home))
    assert "drive root" in unsafe_workspace_reason(os.path.splitdrive(str(tmp_path))[0] + os.sep)
    assert "Hermes's own data directory" in unsafe_workspace_reason(str(tmp_path / "data"))
    assert unsafe_workspace_reason(str(tmp_path / "proj")) is None
    assert unsafe_workspace_reason(str(hermes_home / "hermes-agent")) is None, "a checkout inside HERMES_HOME is fine"


# ── host settings and status ─────────────────────────────────────────────────

def test_resolve_settings_reads_config_first_then_env_bridge(monkeypatch):
    s = mxc_host.resolve_settings({"mxc_readwrite_paths": ["C:/a"], "mxc_network": True, "mxc_wxc_exec_path": "C:/w.exe"})
    assert s.policy.readwrite_paths == (os.path.expandvars("C:/a"),) and s.policy.network is True
    assert s.wxc_exec_path == "C:/w.exe" and s.shell_path is None
    monkeypatch.setenv("TERMINAL_MXC_READONLY_PATHS", json.dumps(["C:/ro"]))
    monkeypatch.setenv("TERMINAL_MXC_NETWORK", "true")
    env_only = mxc_host.resolve_settings({})
    assert env_only.policy.readonly_paths == ("C:/ro",) and env_only.policy.network is True


def test_status_reports_missing_launcher_in_plain_language(monkeypatch):
    if not mxc_host._IS_WINDOWS:
        pytest.skip("platform verdict covered by the linux_only test")
    monkeypatch.setattr(mxc_host, "find_wxc_exec", lambda configured=None: None)
    record = mxc_host.status(settings=mxc_host.resolve_settings({}))
    assert record["available"] is False and record["wxc_exec_path"] is None
    assert "wxc-exec.exe" in record["reason"] and "terminal.mxc_wxc_exec_path" in record["reason"]


@pytest.mark.linux_only
def test_status_on_a_non_windows_host_names_the_platform():
    record = mxc_host.status(settings=mxc_host.resolve_settings({}))
    assert record["platform_supported"] is False and record["available"] is False
    assert "Windows" in record["reason"]


def test_probe_parsing_reports_tier_and_warnings(monkeypatch):
    payload = json.dumps({"tier": "appcontainer-dacl", "warnings": ["run wxc-host-prep"],
                          "probes": {"baseContainerApiPresent": True}})
    monkeypatch.setattr(mxc_host.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(a[0], 0, payload, ""))
    mxc_host.clear_probe_cache()
    probe = mxc_host.run_probe("C:/fake/wxc-exec.exe")
    assert probe["ok"] is True and probe["tier"] == "appcontainer-dacl" and probe["warnings"] == ["run wxc-host-prep"]
    mxc_host.clear_probe_cache()


def test_probe_failure_is_a_reason_not_an_exception(monkeypatch):
    monkeypatch.setattr(mxc_host.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(a[0], 1, "", "not supported on this build"))
    mxc_host.clear_probe_cache()
    probe = mxc_host.run_probe("C:/fake/wxc-exec.exe")
    assert probe["ok"] is False and "not supported" in probe["error"]
    mxc_host.clear_probe_cache()


def test_workspace_ancestors_walks_to_the_drive_root():
    ancestors = mxc_host.workspace_ancestors(os.path.join(os.path.splitdrive(os.getcwd())[0] + os.sep, "a", "b", "c"))
    assert ancestors[-1].lower().endswith(os.sep + "b") and len(ancestors) == 3


def test_admin_prepare_command_grants_listing_rights_only():
    cmd = mxc_host.admin_prepare_command(["C:\\", "C:\\Users"])
    assert cmd.count("icacls") == 2 and "(RD,RA,REA,RC,S)" in cmd and "S-1-15-2-1" in cmd
    assert "(F)" not in cmd and "(M)" not in cmd


# ── wiring ───────────────────────────────────────────────────────────────────

def test_backend_is_registered_and_is_not_a_container_backend():
    import tools.terminal_tool_backends as backends
    from tools.terminal_tool_config import _is_container_backend
    from hermes_cli.config import TERMINAL_CONFIG_ENV_MAP
    from hermes_cli.config_defaults import DEFAULT_CONFIG
    assert "mxc" in backends._ENV_BUILDERS and "mxc" in backends._BACKEND_SPECS
    assert _is_container_backend("mxc") is False
    for key in ("mxc_wxc_exec_path", "mxc_shell_path", "mxc_readwrite_paths", "mxc_readonly_paths", "mxc_network"):
        assert key in DEFAULT_CONFIG["terminal"], key
        assert TERMINAL_CONFIG_ENV_MAP[key] == f"TERMINAL_{key.upper()}"


def test_mxc_keys_are_bridged_at_every_config_to_env_site():
    """cli.py, gateway/run.py and ``hermes config set`` must agree on the bridged terminal keys,
    and the sandbox host module must read the same env names as its fallback."""
    import inspect
    import cli
    import gateway.run as gateway_run
    from hermes_cli.config import TERMINAL_CONFIG_ENV_MAP
    gateway_source = inspect.getsource(gateway_run)
    host_source = inspect.getsource(mxc_host)
    for key in ("mxc_wxc_exec_path", "mxc_shell_path", "mxc_readwrite_paths", "mxc_readonly_paths",
                "mxc_network", "mxc_debug"):
        env_name = f"TERMINAL_{key.upper()}"
        assert cli._TERMINAL_ENV_MAPPINGS[key] == env_name
        assert f'"{key}": "{env_name}"' in gateway_source
        assert TERMINAL_CONFIG_ENV_MAP[key] == env_name
        assert env_name in host_source


def test_unavailable_reason_flows_into_requirements_check(monkeypatch):
    import tools.terminal_tool_backends as backends
    monkeypatch.setattr(mxc_host, "unavailable_reason", lambda: "MXC sandboxing is a Windows feature; this host is not Windows.")
    assert backends._check_requirements("mxc", {}) is False
    assert "Windows" in backends.terminal_backend_unavailable_reason()
    monkeypatch.setattr(mxc_host, "unavailable_reason", lambda: None)
    assert backends._check_requirements("mxc", {}) is True


def test_foreground_result_carries_the_sandbox_field():
    from tools.terminal_tool_result import finalize_foreground_result
    raw = {"output": "ok", "returncode": 0,
           "sandbox": {"backend": "mxc", "container": "hermes-1", "denied": ["C:\\x"]}}
    out = json.loads(finalize_foreground_result(
        command="echo ok", result=raw, env=None, env_type="mxc", effective_task_id="t", task_id="t",
        session_id="s", session_key="k", workdir=None, command_cwd="C:\\proj", approval_note=None))
    assert out["sandbox"]["backend"] == "mxc" and out["sandbox"]["denied"] == ["C:\\x"]
    plain = json.loads(finalize_foreground_result(
        command="echo ok", result={"output": "ok", "returncode": 0}, env=None, env_type="local",
        effective_task_id="t", task_id="t", session_id="s", session_key="k", workdir=None,
        command_cwd=None, approval_note=None))
    assert "sandbox" not in plain


def test_environment_hints_describe_the_sandbox_for_the_mxc_backend(monkeypatch):
    from agent import prompt_builder
    monkeypatch.setenv("TERMINAL_ENV", "mxc")
    hints = prompt_builder.build_environment_hints()
    assert "MXC" in hints and "Permission denied" in hints and "busybox" in hints
    assert "NOT on the machine where Hermes" not in hints, "MXC runs on the host filesystem"
