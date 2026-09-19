---
sidebar_position: 8
title: "Windows Sandbox (MXC)"
description: "Run every agent command inside a kernel-enforced Windows process container, with a folder policy you control"
---

# Windows Sandbox (MXC)

On Windows, Hermes can run every command and file operation the agent performs inside a fresh
Microsoft MXC process container. The container is enforced by the Windows kernel: the process
inside it can reach the session's workspace folder and the folders you have granted, and nothing
else. A write to your Documents folder, a read of Hermes's own credentials, or a network request
is refused by the operating system before it happens, no matter what the agent tries. Everything
else about Hermes stays the same. The agent, its model (including local inference on your GPU),
and the desktop app all run normally on the host; only the agent's actions are boxed.

This is a different shape from the Docker backend. Docker gives the agent a separate Linux
filesystem; MXC keeps the agent on your real Windows filesystem with your real tools, and draws
the boundary with permissions instead of a virtual machine. Starting a container costs a fraction
of a second, so Hermes starts a new one for every single command.

## Requirements

- Windows 11 with the MXC process-container support (Insider builds from 26300 onward at the time
  of writing). Hermes checks this for you and tells you plainly when a machine cannot run it.
- The MXC kit, specifically `wxc-exec.exe`. Hermes looks in `C:\mxc-kit\bin` and `C:\mxc\bin` and
  on `PATH`; if it lives elsewhere, set `terminal.mxc_wxc_exec_path`.
- One elevated command, run once per machine, so containers can traverse the drive root:
  `wxc-host-prep.exe prepare-system-drive` (from the same kit).
- A POSIX shell for the container. Git for Windows' bash cannot start inside an AppContainer, so
  Hermes uses a pinned, checksum-verified `busybox-w32` build and downloads it into
  `%LOCALAPPDATA%\hermes\bin` the first time you turn the sandbox on. To use your own copy, set
  `terminal.mxc_shell_path`.

## Turning it on

In Hermes Desktop, open **Settings → Safety** and find **Windows sandbox**. The panel shows
whether this machine can run MXC and, if not, why. Flip **Sandbox agent actions** on. That sets
`terminal.backend` to `mxc`, provisions the shell if needed, and takes effect on the agent's next
command in every session; nothing needs restarting. Start a new conversation afterwards: the
agent's briefing about its environment is fixed for the life of a conversation, and a fresh one
tells it about the sandbox, the POSIX shell, and how to handle a refusal.

From the command line the equivalent is:

```bash
hermes config set terminal.backend mxc
```

`hermes doctor` and the terminal-backend picker report the same availability check, using the
same words, so you never have to guess why an option is greyed out.

## The policy

The policy is small on purpose, and the panel shows all of it:

- **Workspace.** The folder a session works in is always readable and writable. In the desktop
  that is the session's project folder; in the CLI it is the folder you launched `hermes` from.
  Hermes refuses to use your home folder, a drive root, or any folder that contains its own data
  directory as a workspace, because a grant covers everything beneath it and those would hand the
  sandbox the very data it exists to protect.
- **Additional folders**, each read-only or read & write. These are `terminal.mxc_readonly_paths`
  and `terminal.mxc_readwrite_paths` in `config.yaml`.
- **Network**, off by default (`terminal.mxc_network`). When it is off, sandboxed commands cannot
  reach the internet or services on your own machine; local inference is unaffected because the
  model runs outside the sandbox.

A few read-only grants are added automatically so the agent's tools work: the Hermes install and
its Python, the bundled Node and Git, and the sandbox shell. Hermes's data directory, with your
configuration and credentials, is never granted.

Edits take effect on the agent's next command. Hermes reads the policy fresh for every container
it starts, which is what makes the grant-and-retry flow below possible without a restart.

## When something is refused

A refused command comes back with the operating system's own error and a short note from Hermes
that names what was refused and what is currently allowed, for example:

```
sh: can't create C:/Users/you/Documents/report.txt: Permission denied

[Sandbox] Windows MXC denied access outside the sandbox policy:
  denied: C:\Users\you\Documents\report.txt
  read/write: C:\Demo
  read-only: (none)
  network: off
The user controls this policy (Hermes desktop: Settings > Safety > Sandbox). If the task needs
that location, stop and ask the user to grant access; a grant applies to your next command.
Do not try to work around the sandbox.
```

The agent is instructed to stop and ask rather than route around the sandbox. In the desktop the
tool card is marked **Blocked by sandbox policy** and offers **Allow reading** and
**Allow read & write** for the folder in question. Granting writes the folder into the policy and
drafts a short "please try again" message into the composer, so one Enter resumes the task with
the new permission in force.

## Git and nested workspaces

Git for Windows resolves the working directory by walking the folder's ancestors, and a container
can only do that when it is allowed to see those ancestors' names. A workspace directly under the
drive root (for example `C:\Demo`) works as soon as the drive is prepared. For a nested workspace
such as `C:\Users\you\Projects\demo`, the Sandbox panel shows **Prepare workspace for git**.
Preparing adds a names-and-attributes permission for sandbox processes to each ancestor folder;
it grants no access to any file's contents. Folders you own are prepared in place. Folders that
belong to the system, typically `C:\` and `C:\Users`, need an administrator once; the panel shows
the exact `icacls` command to paste into an elevated prompt.

Python, PowerShell, `cmd`, Node and the Hermes file tools do not have this dependency and work in
any workspace.

## Limitations

- Windows only, and only on builds with the MXC process-container support.
- Each command runs in its own container, so a foreground command cannot leave a server running
  after it exits. Use `terminal(background=true)` for long-lived processes; Hermes keeps that
  container alive for the life of the process.
- The `execute_code` kernel does not persist between calls under this backend; commands and the
  file tools are the supported path.
- Browser automation and desktop control run on the host, outside the sandbox. Turn those
  toolsets off when the point is containment.
- Messaging gateways must set `terminal.cwd` to a project folder; the sandbox will not accept the
  gateway's home directory as a workspace.

## Configuration reference

```yaml
terminal:
  backend: mxc
  mxc_wxc_exec_path: ""         # Path to wxc-exec.exe; empty = C:\mxc-kit\bin, C:\mxc\bin, PATH
  mxc_shell_path: ""            # POSIX shell for the container; empty = managed busybox-w32
  mxc_readwrite_paths: []       # Extra folders the agent may read and write
  mxc_readonly_paths: []        # Extra folders the agent may read
  mxc_network: false            # Allow outbound network from sandboxed commands
  mxc_debug: false              # Log each container's launcher configuration
```

Every key is also bridged to a `TERMINAL_MXC_*` environment variable for processes started with
only the environment bridge, the same way the other terminal keys are.

## Preparing a demonstration machine

For a machine that will show the sandbox to an audience, the following order avoids surprises:

1. Confirm the Windows build supports process containers: `wxc-exec.exe --probe` should report a
   `base-container` tier with no warnings.
2. Run `wxc-host-prep.exe prepare-system-drive` once from an elevated prompt.
3. Install Hermes Desktop and a local model, and confirm a normal conversation works.
4. Create the demonstration workspace directly under the drive root, for example `C:\Demo`, and
   open it as the session's project folder.
5. Turn on the sandbox in **Settings → Safety** while online, so the shell downloads.
6. Run one task that stays inside the workspace and one that reaches outside it, and grant the
   folder from the tool card, so every path has been exercised before the audience arrives.
