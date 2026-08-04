# Docker without Docker Desktop (Windows)

If Docker Desktop keeps crashing at startup, skip it. **You don't need it.**

Docker Desktop is a graphical wrapper. The thing that actually runs containers
is the Docker *engine*, which is free, open source, and runs inside WSL2 — and
it contains none of the code that makes Docker Desktop crash on Windows.

Roughly 15 minutes, and it is more reliable than Docker Desktop on Windows.

---

## Why this works when Docker Desktop doesn't

The crash happens in the **Inference manager** — Docker's AI model-runner
feature. It tries to create a Unix socket on the Windows side before anything
else starts, and if Windows refuses, the whole application dies before the
engine ever loads.

We don't use that feature. The engine on its own has no Inference manager, no
Windows sockets, and nothing to fail. It just runs containers.

---

## Step 1 — Install Ubuntu

Open **PowerShell as Administrator** (Start → type `powershell` → right-click →
**Run as administrator**):

```powershell
wsl --install -d Ubuntu
```

If it says Ubuntu is already installed, that's fine — carry on.

**Reboot if it asks.** It usually does.

### If you get error `0xc03a0014`

```
A virtual disk support provider for the specified file was not found.
Error code: Wsl/InstallDistro/Service/RegisterDistro/0xc03a0014
```

This almost always means the **Hyper-V Host Compute Service (`vmcompute`) is
not running**. The message says nothing about that, which is why it sends
people off chasing missing drivers and corrupt installs — it is a known WSL
bug ([microsoft/WSL#40734](https://github.com/microsoft/WSL/issues/40734)).

In **PowerShell as Administrator**:

```powershell
sc.exe start vmcompute
sc.exe config vmcompute start=auto
```

Note `sc.exe`, not `sc` — in PowerShell, `sc` is an alias for `Set-Content`
and will do something entirely unrelated.

The second line makes it start on boot, so this does not come back.

`start=auto` costs nothing — an idle service uses no CPU or RAM. Worried about
gaming performance? See **[wsl-gaming-performance.md](./wsl-gaming-performance.md)**:
the short version is that the service is free, the hypervisor is almost
certainly already running on Windows 11, and the only real cost is RAM while
WSL is active, which is capped in one file.

Then run the install again:

```powershell
wsl --install -d Ubuntu
```

**This is very likely the same reason Docker Desktop was crashing.** Without
`vmcompute` nothing virtualised can start, and each component fails with its
own confusing message.

### If `vmcompute` didn't fix it: the hypervisor may be switched off at boot

The service can be running while the hypervisor itself never starts, because
Windows has a boot-level switch for it. This is the single most common cause
of `0xc03a0014`, and it is very often set deliberately — many "optimise
Windows for gaming" guides, and some anti-cheat troubleshooting steps, tell
people to turn it off. It is also required by VirtualBox and older VMware,
which switch it off themselves.

Check it (Command Prompt or PowerShell, **as Administrator**):

```
bcdedit /enum | findstr -i hypervisorlaunchtype
```

- **`hypervisorlaunchtype Off`** — that is the problem. Nothing virtualised
  can start. Fix below.
- **`Auto`**, or no output at all — this is not it; keep reading.

Turn it on:

```
bcdedit /set hypervisorlaunchtype auto
```

**Reboot.** This is a boot setting; it does nothing until restart.

Then run `wsl --install -d Ubuntu` again — and try Docker Desktop, which was
almost certainly failing for the same reason.

**This is the setting with the real gaming cost** — the 2-5% FPS discussed in
[wsl-gaming-performance.md](./wsl-gaming-performance.md). If it was `Off`, you
were genuinely avoiding that cost, and turning it on genuinely takes it. To
switch back later:

```
bcdedit /set hypervisorlaunchtype off
```

Reboot again. Docker and WSL stop working until you set it back to `auto`, so
it is a toggle, not a permanent decision.

### If both of those are fine: the virtual disk driver itself

If `vmcompute` is running and `hypervisorlaunchtype` is `Auto` and you still
get `0xc03a0014`, the problem is one layer lower — Windows' **VHDX support**,
which WSL2 needs to create its disk. That is a separate subsystem from
virtualisation, which is why enabling Hyper-V things changes nothing.

**Prove it in ten seconds.** This has nothing to do with WSL or Docker — it
just asks Windows to make a virtual disk. Command Prompt **as Administrator**:

```
diskpart
```

Then at the `DISKPART>` prompt:

```
create vdisk file=C:\test.vhdx maximum=64 type=expandable
```

Then `exit`.

- **`DiskPart successfully created the virtual disk file`** — VHDX works, and
  the cause is elsewhere. Delete `C:\test.vhdx` and say so.
- **`A virtual disk support provider for the specified file was not found`** —
  confirmed. Windows cannot create virtual disks at all. Nothing about WSL is
  broken; the disk layer beneath it is.

This is a much better signal than the WSL error, because it removes WSL,
Docker, Hyper-V and the hypervisor from the picture entirely.

#### The fix: the FsDepends driver

`FsDepends` is the driver Windows uses for virtual disk files. When its start
type is set to `3` (manual) instead of `0` (boot), VHDX creation fails exactly
like this. Various "debloat" and optimiser scripts change it.

**Back up the registry key first** (Command Prompt as Administrator):

```
reg export HKLM\SYSTEM\CurrentControlSet\Services\FsDepends "%USERPROFILE%\Desktop\FsDepends-backup.reg"
```

Check the current value:

```
reg query HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v Start
```

If it shows anything other than `0x0`, set it:

```
reg add HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v Start /t REG_DWORD /d 0 /f
```

**Reboot**, then repeat the `diskpart` test above. If the disk is created,
`wsl --install -d Ubuntu` will work.

Also worth checking the same way — these three are all part of the VHD stack
and all should be `0`:

```
reg query HKLM\SYSTEM\CurrentControlSet\Services\vdrvroot /v Start
reg query HKLM\SYSTEM\CurrentControlSet\Services\volsnap /v Start
reg query HKLM\SYSTEM\CurrentControlSet\Services\vhdmp /v Start
```

Same `reg add` command with the service name swapped to fix any that aren't.

#### If the FsDepends key is missing entirely

`ERROR: The system was unable to find the specified registry key or value` is
different from a wrong value. `FsDepends` is a **built-in Windows driver** that
the VHD system depends on — every Windows install has it. If the key does not
exist, the driver is not registered at all, which is why nothing can create a
virtual disk.

Do **not** try to recreate the key by hand, and do not import one from another
PC. Driver registrations reference machine-specific state, and a hand-built one
can leave Windows unbootable.

**1. Check whether the file is still on disk:**

```
dir C:\Windows\System32\drivers\FsDepends.sys
```

**2. Repair the Windows image.** These restore missing system components from
Microsoft's servers. Takes 10-30 minutes; leave it running:

```
DISM /Online /Cleanup-Image /RestoreHealth
sfc /scannow
```

**Reboot**, then re-run the diskpart test.

**3. If that doesn't restore it: in-place repair upgrade.** Download the
Windows 11 ISO from Microsoft, mount it (or extract it with 7-Zip if mounting
fails — mounting an ISO also needs the virtual disk stack, which is broken),
run `setup.exe` from inside it, and choose **Keep personal files and apps**.

It reinstalls Windows' system components while keeping your files, programs and
settings. About an hour. This is the supported fix for a missing system driver
and it does work — but it is a big operation.

### Honestly: is this worth fixing?

If a repair upgrade is more than you want to take on for a side project, that
is a completely reasonable call. The sandbox does not have to run on this
machine.

A Linux VPS — Hetzner CX33, about €6.50/month — has a working Docker in about
five minutes, with none of this. It also removes the "does my gaming PC take a
2-5% hit" question entirely, since nothing runs locally.

The trade-off is that the app then lives on a server, which makes auth
mandatory rather than optional. That was already on the roadmap; this just
changes the order.

#### If VHDX still fails after that

At that point it is a genuinely damaged Windows install, and the supported
answer is a repair install (an in-place upgrade that keeps your files and
programs). That is a big step for a side project — the sensible alternative is
to skip local Docker entirely and use a cheap Linux VPS for the sandbox, where
none of this applies.

### If the service doesn't exist at all

If `sc.exe start vmcompute` reports that the service does not exist, the
feature isn't installed. Enable it, then reboot:

```powershell
dism /online /enable-feature /featurename:Microsoft-Hyper-V-All /all /norestart
dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
```

After the reboot an Ubuntu window opens and asks for a **username and
password**. This is a brand-new Linux account, nothing to do with your Windows
login. Pick something short. **Remember the password** — you'll need it for
`sudo`, and it shows nothing at all as you type. That's normal, keep typing.

If no window appears, open **Ubuntu** from the Start menu.

---

## Step 2 — Install the Docker engine

These commands go in the **Ubuntu window**, not PowerShell. PowerShell has no
`apt` or `sudo` and will just throw errors.

```bash
sudo apt update
sudo apt install -y docker.io
```

Takes a couple of minutes. Then let your user run Docker without `sudo`:

```bash
sudo usermod -aG docker $USER
```

---

## Step 3 — Restart WSL

The group change only applies to a new session.

Close the Ubuntu window, then in **PowerShell**:

```powershell
wsl --shutdown
```

Reopen **Ubuntu** from the Start menu.

---

## Step 4 — Start it and check

In Ubuntu:

```bash
sudo service docker start
docker run --rm alpine:3.20 echo it-works
```

If it prints `it-works`, Docker is running. That is the whole install.

Newer Ubuntu images on WSL start Docker automatically. If yours doesn't, run
`sudo service docker start` after each reboot — or make it automatic:

```bash
echo "sudo service docker start" >> ~/.bashrc
```

---

## Optional — cap WSL's memory

By default WSL2 can take up to half your RAM. On a machine you also game on,
that is worth limiting. One file, one minute:
**[wsl-gaming-performance.md](./wsl-gaming-performance.md)**.

---

## Step 5 — Run apiM from inside Ubuntu

This is the part that catches people out. **The engine lives inside Ubuntu**,
so the app has to run there too, or it can't reach Docker.

Your Windows drives are visible under `/mnt/c/`. In the Ubuntu window:

```bash
cd /mnt/c/Users/YOURNAME/Downloads/apiM
```

Replace `YOURNAME` with your Windows username. Tab-completion works — type a
few letters and press Tab.

Node isn't in Ubuntu yet:

```bash
sudo apt install -y nodejs npm
node --version
```

If that prints something older than `v20`, install a current version:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Then, as usual:

```bash
npm install
npm run check:docker
npm run dev
```

The app still opens at **http://localhost:3000** in your normal Windows
browser. WSL forwards the port automatically.

### One caveat

Running from `/mnt/c/` is noticeably slower than a native Linux folder, because
every file read crosses between Windows and Linux. If it feels sluggish, clone
the project inside Ubuntu instead:

```bash
cd ~
git clone https://github.com/eggyeg/apiM.git
cd apiM
git checkout arena/019fc84b-apim
npm install
```

Then it lives at `~/apiM` in Ubuntu, which is much faster. To open that folder
from Windows Explorer, type `\\wsl$\Ubuntu\home\YOURNAME\apiM` in the address
bar.

---

## Troubleshooting

**`docker: permission denied`** — Step 3 was skipped or didn't take. Run
`wsl --shutdown` in PowerShell, reopen Ubuntu, try again.

**`Cannot connect to the Docker daemon`** — the engine isn't running:
`sudo service docker start`

**`wsl --install` says virtualisation is disabled** — enable it in BIOS. Check
first: Task Manager → Performance → CPU → "Virtualization" bottom right.

**Error `0xc03a0014` on install** — `vmcompute` is stopped. See Step 1.

**`npm: command not found`** — Node is installed in Windows, not Ubuntu. They
are separate systems. See Step 5.

---

## Do I lose anything without Docker Desktop?

Only the GUI: the dashboard, the container list, the settings panel. Everything
apiM needs — building images, running containers, all the isolation flags —
is the engine, and that is exactly what you just installed.
