# Docker Desktop crashes on startup (Inference manager / dockerInference)

If Docker Desktop closes immediately with a message like:

```
starting services: initializing Inference manager:
listening on unix://C:/Users/<you>/AppData/Local/Docker/run/dockerInference:
socket: An address incompatible with the requested protocol was used.
(listener: The filename, directory name, or volume label syntax is incorrect.)
```

## First: is the Hyper-V Host Compute Service running?

Docker Desktop cannot start anything virtualised without `vmcompute`, and when
it is stopped every component fails with its own unrelated-looking message.
This is the most common cause and the quickest to rule out.

In **PowerShell as Administrator**:

```powershell
sc.exe start vmcompute
sc.exe config vmcompute start=auto
```

Use `sc.exe`, not `sc` — in PowerShell `sc` is an alias for `Set-Content`.

The second line makes it start automatically on boot. Then open Docker Desktop
again.

The same stopped service also breaks `wsl --install` with error `0xc03a0014`,
which is documented as a WSL bug because the message never mentions it:
[microsoft/WSL#40734](https://github.com/microsoft/WSL/issues/40734).

---

## Second: check WSL2 is actually installed

Before assuming the Docker bug below, run this in PowerShell:

```powershell
wsl --status
```

If it says **"The Windows Subsystem for Linux is not installed"**, that is your
cause and the rest of this page does not apply. Docker Desktop's per-user
install requires WSL2 and crashes without it.

```powershell
wsl --install
```

Then **reboot** — the installer says so explicitly, and nothing works until you
do. After rebooting, open Docker Desktop.

---

## Read the middle of the error — there are two different faults

The message looks the same at a glance, but the verb before the colon tells
you which problem you have, and they need opposite fixes.

**`remove ...: The file cannot be accessed by the system`**
A stale socket file is left over and Windows won't release it. **A reboot
fixes this.**

**`socket: An address incompatible with the requested protocol was used`**
Windows refused to *create* an AF_UNIX socket at all. This is Winsock error
10047, `WSAEAFNOSUPPORT` — "address family not supported". Rebooting will
never fix it, because nothing is stale; the socket layer itself is rejecting
Unix sockets. Docker Desktop cannot start without them.

This usually means the Winsock catalog is corrupted, typically by antivirus or
VPN software that installs a Layered Service Provider, or by one being removed
badly. Skip to **Fix A** below.

Both are tracked upstream:
[docker/desktop-feedback#342](https://github.com/docker/desktop-feedback/issues/342)
and [#460](https://github.com/docker/desktop-feedback/issues/460).

---

## Fix A — reset Winsock (for the `socket:` variant)

This rebuilds Windows' socket configuration. It is a standard, safe repair,
but it does clear custom network settings added by VPN or antivirus software —
so a VPN may need reconnecting afterwards.

Open **Command Prompt as Administrator** — press Start, type `cmd`, right-click
**Command Prompt**, choose **Run as administrator** — then run these in order:

```
netsh winsock reset
netsh int ip reset
```

**Reboot.** This one genuinely requires it; the reset does not take effect
until you do.

Then open Docker Desktop.

If it still fails identically, the likely culprit is security software holding
the socket layer open. Temporarily disabling third-party antivirus or VPN and
starting Docker once will tell you whether that is it.

---

## Fix B — the stale-socket crash (for the `remove:` variant)

## What is actually happening

Docker Desktop creates socket files under `AppData\Local\Docker\run\`. If it
ever exits uncleanly — including the very first launch failing — a socket file
is left behind. Windows then holds that file at the kernel level (`afd.sys`)
and refuses to let anything delete it, **even after every Docker process is
stopped**.

On the next launch Docker tries to create the same socket, can't remove the old
one, and crashes. Then it crashes again. Every time.

The unhelpful part: each component you clear just exposes the next stale
socket, so it can look like the fix did nothing.

Turning the Inference / Model Runner feature off in settings **does not help** —
the listener initialises before that setting is read. Several people have tried.

---

### 1. Reboot

Sounds trivial; it is the actual documented fix. Only a reboot reliably
releases the kernel-held socket file.

1. Restart Windows
2. Open Docker Desktop
3. Wait for the whale icon to say **Running**

This clears it for most people. If Docker crashes again after a reboot, go on.

### 2. Rename the `run` folder

The other thing that works. Renaming the parent directory sidesteps the file
Windows won't release.

Make sure Docker Desktop is fully closed first — check the system tray, and
right-click the whale → **Quit Docker Desktop** if it's there.

Then in **PowerShell**:

```powershell
wsl --shutdown
Get-Process *docker* -ErrorAction SilentlyContinue | Stop-Process -Force
Rename-Item "$env:LOCALAPPDATA\Docker\run" "run-old"
```

If the rename fails saying the folder is in use, reboot and run it again before
opening Docker Desktop.

Then start Docker Desktop.

### 3. Clear the secrets-engine socket too

If it gets past the Inference manager and then crashes on
`initializing Secrets Engine`, that's the same bug on the next component:

```powershell
Rename-Item "$env:LOCALAPPDATA\docker-secrets-engine" "docker-secrets-engine-old"
```

Then start Docker Desktop again.

### 4. Full clean reinstall

If it still crash-loops:

1. Uninstall Docker Desktop from **Settings → Apps**
2. Reboot
3. Delete these if they still exist:
   - `C:\Program Files\Docker`
   - `C:\ProgramData\Docker`
   - `C:\ProgramData\DockerDesktop`
   - `%LOCALAPPDATA%\Docker`
   - `%APPDATA%\Docker`
   - `%APPDATA%\Docker Desktop`
   - `%USERPROFILE%\.docker`
4. Reboot again
5. Install the latest Docker Desktop

---

## Fallback: Docker without Docker Desktop

Docker Desktop is only a GUI wrapper. The engine itself is free, open source,
and runs fine inside WSL2 — and it has none of the Inference manager code that
causes this crash.

This is a genuinely good option if Docker Desktop keeps fighting you.

**1. Install Ubuntu** (PowerShell as Administrator):

```powershell
wsl --install -d Ubuntu
```

**Reboot if it says to.** It usually does, and nothing after this works until
you have. When Ubuntu first opens it asks for a username and password — that is
a new Linux account, unrelated to your Windows login. Remember the password;
`sudo` asks for it.

**2. Install the Docker engine** — these commands go in the **Ubuntu window**,
not PowerShell. PowerShell has no `sudo` or `apt`, and rejects `&&` as a
separator, so running them in the wrong window produces confusing errors:

```bash
sudo apt update
sudo apt install -y docker.io
sudo usermod -aG docker $USER
```

**3. Close the Ubuntu window, then in PowerShell:**

```powershell
wsl --shutdown
```

**4. Reopen Ubuntu and start it:**

```bash
sudo service docker start
docker run --rm alpine:3.20 echo it-works
```

If that prints `it-works`, the engine is running.

### The catch

The engine now lives inside Ubuntu, not Windows. So the app has to run there
too, or it won't be able to reach Docker. Inside the Ubuntu window:

```bash
cd /mnt/c/Users/<you>/path/to/apiM
npm install
npm run dev
```

`/mnt/c/` is how WSL sees your `C:` drive. The app still opens at
`localhost:3000` in your normal Windows browser.

Running from `/mnt/c/` is slower than a native Linux folder. If it feels
sluggish, clone the repo inside Ubuntu instead (`~/apiM`).

---

## Checking whether it worked

From the project folder:

```bash
npm run check:docker
```

It reports whether Docker is installed, actually running, and able to start a
properly locked-down container — not just whether the command exists.
