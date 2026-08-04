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

**`npm: command not found`** — Node is installed in Windows, not Ubuntu. They
are separate systems. See Step 5.

---

## Do I lose anything without Docker Desktop?

Only the GUI: the dashboard, the container list, the settings panel. Everything
apiM needs — building images, running containers, all the isolation flags —
is the engine, and that is exactly what you just installed.
