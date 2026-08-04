# Does this hurt gaming performance?

Short version: **`sc.exe config vmcompute start=auto` costs nothing.** The
thing worth knowing about is the hypervisor, and on Windows 11 that is almost
certainly already on. The one real cost is RAM while WSL is running, and that
is capped in one file.

---

## The three separate things people mix up

### 1. The `vmcompute` service — free

`start=auto` only means the service starts with Windows instead of waiting to
be asked. A stopped service and an idle running service consume the same
nothing. It does no work until something asks it to create a VM.

This does **not** enable the hypervisor. It is a management service *for* the
hypervisor. Setting it to auto is the difference between a light switch being
reachable and being reachable — the light is still off.

### 2. The hypervisor — 2-5% in most games, and probably already on

This is the real question, and it is not the one you just asked. Running the
hypervisor puts a thin layer under Windows itself, which costs a little CPU.

Measured impact:

- **most games: 2-5% FPS** — not perceptible
- a handful of titles: up to 10-17%
- 1% lows suffer more than averages, so it can show as slightly less smooth
- at 4K you are GPU-bound, so it is closer to nothing

**But you almost certainly already have it.** Windows 11 ships with
Virtualization-Based Security on by default, which is the same hypervisor. And
your earlier `wsl --install` already enabled VirtualMachinePlatform. So this
cost, if you are paying it, you were paying before we started.

Check whether it is on:

```powershell
Get-CimInstance Win32_ComputerSystem | Select HypervisorPresent
```

`True` means it is already running — installing WSL changes nothing about your
frame rate.

### 3. RAM while WSL runs — the one that actually matters

This is the real cost, and the one worth configuring.

By default WSL2 will take **up to 50% of your RAM** (8 GB max). It shows in
Task Manager as `vmmem` or `VmmemWSL`. If you have 16 GB and WSL grabs 8 while
a game wants it, that is a genuine problem — not a 3% one.

Two things fix it completely.

---

## Cap WSL's memory

Create a file called `.wslconfig` in your user folder — `C:\Users\YOURNAME\`.

Easiest way, in PowerShell:

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

Say yes to creating it. Paste this:

```ini
[wsl2]
memory=4GB
processors=4
swap=0

[experimental]
autoMemoryReclaim=gradual
```

Save and close, then:

```powershell
wsl --shutdown
```

What each line does:

- **`memory=4GB`** — hard ceiling. Plenty for Docker and a dev server; more
  than most containers ever touch. On a 16 GB machine that leaves 12 for
  Windows and games.
- **`processors=4`** — stops WSL competing for every core.
- **`swap=0`** — no swap file. Avoids pointless SSD writes.
- **`autoMemoryReclaim=gradual`** — WSL hands memory *back* to Windows when
  it stops using it. Without this it holds onto whatever it peaked at.

On 8 GB total, use `memory=2GB` and `processors=2` instead.

## Turn WSL off before gaming

The simpler answer. When WSL isn't running, it uses **zero** RAM and **zero**
CPU:

```powershell
wsl --shutdown
```

That is the whole thing. Nothing is left running in the background. Start it
again when you want to work.

---

## So what should you actually do?

**Run the `start=auto` command.** It is free, and without it you will hit the
same `0xc03a0014` failure after every reboot.

**Set the `.wslconfig` cap.** Takes a minute, and removes the only cost that
would ever be noticeable.

**Run `wsl --shutdown` before a serious gaming session** if you want to be
thorough. Usually unnecessary once the cap is set.

## And if you want to verify rather than trust this

Benchmark yourself. Run something before and after, same settings, same scene.
Your hardware and your games are the only measurement that counts — the 2-5%
figure is an average across titles, and averages hide the outliers.
