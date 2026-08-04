# Docker Desktop crashes on startup (Inference manager / dockerInference)

If Docker Desktop closes immediately with a message like:

```
starting services: initializing Inference manager:
listening on unix://C:/Users/<you>/AppData/Local/Docker/run/dockerInference:
socket: An address incompatible with the requested protocol was used.
(listener: The filename, directory name, or volume label syntax is incorrect.)
```

**This is a Docker bug, not a problem with your machine.** It is not related to
virtualisation, WSL2 or your hardware — a clean install on a perfectly healthy
PC hits it. Tracked upstream as
[docker/desktop-feedback#342](https://github.com/docker/desktop-feedback/issues/342)
and [#460](https://github.com/docker/desktop-feedback/issues/460).

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

## Fixes, easiest first

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

Reboot if asked. Set a username and password when Ubuntu first opens.

**2. Install the Docker engine** — inside the Ubuntu window:

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
