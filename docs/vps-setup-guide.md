# Deploying apiM on an AWS EC2 Server — Complete Beginner Guide

Written for someone who has never set up a Linux server. Every command is
copy-pasteable. Nothing is assumed.

**Versions verified 2026-08-03:** Ubuntu 24.04 LTS · Node.js 24 (Active LTS) ·
PostgreSQL 16 · Caddy 2.

> **Legend**
> 💻 = run on **your own computer**
> 🖥️ = run on **the server** (after you've connected via SSH)
> ⚠️ = read carefully, easy to get wrong

---

## What you're building

```
        You (browser)
             │  https://yourdomain.com
             ▼
   ┌─────────────────────────┐
   │   EC2 server (Ubuntu)   │
   │                         │
   │   Caddy   :443  ──────► handles HTTPS certificate
   │     │                   │
   │     ▼                   │
   │   Next.js :3000 ──────► your app
   │     │                   │
   │     ▼                   │
   │   Postgres :5432 ─────► chat history
   └─────────────────────────┘
```

Four pieces. We install them one at a time and test after each.

---

## Time and cost

| | |
|---|---|
| Total time | 1.5–2.5 hours first time |
| Server cost | ~$15/month (t3.small) |
| Domain | ~$10–15/year (optional but recommended) |

⚠️ **Free tier warning:** `t2.micro`/`t3.micro` (1 GB RAM) is *not enough* —
`npm run build` will freeze or get killed. Use **t3.small** (2 GB). If you must
use free tier, see Appendix C (swap file workaround).

---

# PHASE 1 — Create the server

## Step 1.1 — Choose a region

💻 Log in to https://console.aws.amazon.com

Top-right corner shows a region name. Since you're in Ukraine, pick the closest:

- **Frankfurt** (`eu-central-1`) ← recommended
- Stockholm (`eu-north-1`) — often cheapest

⚠️ Remember your choice. AWS hides resources created in other regions, and this
confuses everyone the first time.

## Step 1.2 — Launch the instance

1. Search **EC2** in the top search bar → click it
2. Orange button **Launch instance**

Fill in:

| Field | Value |
|---|---|
| **Name** | `apim-server` |
| **OS Image** | **Ubuntu Server 24.04 LTS** ⚠️ not Amazon Linux, not 26.04 |
| **Architecture** | 64-bit (x86) |
| **Instance type** | **t3.small** |

⚠️ Choose **Ubuntu**, not the default Amazon Linux. The commands below are
Ubuntu-specific. And pick **24.04 LTS** — 26.04 is very new and has fewer
tutorials online when you get stuck.

## Step 1.3 — Create your SSH key

This is the "password" for your server. Lose it and you lose access.

1. Under **Key pair (login)** → **Create new key pair**
2. Name: `apim-key`
3. Type: **RSA**, Format: **.pem**
4. Click **Create key pair** — it downloads `apim-key.pem`

💻 **Move it somewhere safe and lock down permissions:**

**Mac/Linux:**
```bash
mkdir -p ~/.ssh
mv ~/Downloads/apim-key.pem ~/.ssh/
chmod 400 ~/.ssh/apim-key.pem
```

**Windows (PowerShell):**
```powershell
mkdir "$env:USERPROFILE\.ssh" -Force
move "$env:USERPROFILE\Downloads\apim-key.pem" "$env:USERPROFILE\.ssh\"
icacls "$env:USERPROFILE\.ssh\apim-key.pem" /inheritance:r
icacls "$env:USERPROFILE\.ssh\apim-key.pem" /grant:r "$($env:USERNAME):(R)"
```

⚠️ `chmod 400` is required. SSH refuses keys that other users could read.

## Step 1.4 — Firewall (Security Group)

Under **Network settings** → **Edit**. Name it `apim-sg`.

Remove any default rules and add exactly these three:

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | **My IP** | your terminal access |
| HTTP | 80 | Anywhere `0.0.0.0/0` | certificate renewal |
| HTTPS | 443 | Anywhere `0.0.0.0/0` | the actual site |

⚠️ **SSH must be "My IP", never "Anywhere".** Open SSH gets brute-forced within
hours — this is the single most common way hobby servers get taken over.

⚠️ **Never open 3000 or 5432.** The app and database stay private; Caddy is the
only public door. If your home IP changes later, edit this rule to your new IP.

## Step 1.5 — Storage & launch

- Storage: **20 GB**, `gp3`
- Click **Launch instance**

Wait ~60 seconds for **Instance state: Running**.

## Step 1.6 — Get a fixed IP address

⚠️ Without this, your server's IP changes every reboot and your domain breaks.

1. Left sidebar → **Elastic IPs** (under Network & Security)
2. **Allocate Elastic IP address** → **Allocate**
3. Select it → **Actions** → **Associate Elastic IP address**
4. Resource type: **Instance** → choose `apim-server` → **Associate**

**Write this IP down.** Referred to below as `YOUR_IP`.

💡 An Elastic IP is free *while attached to a running instance*, but AWS charges
if you leave it allocated to nothing. Release it if you delete the server.

---

# PHASE 2 — Connect to the server

💻 In your terminal (PowerShell on Windows):

```bash
ssh -i ~/.ssh/apim-key.pem ubuntu@YOUR_IP
```

Replace `YOUR_IP` with your Elastic IP. First time it asks:

```
Are you sure you want to continue connecting (yes/no)?
```

Type `yes` and Enter.

**Success looks like:**
```
ubuntu@ip-172-31-xx-xx:~$
```

You're now typing commands *on the server*. Everything marked 🖥️ goes here.

> **Troubleshooting**
> - *Permission denied (publickey)* → wrong path to `.pem`, or you used a
>   username other than `ubuntu`
> - *Connection timed out* → Security Group SSH rule doesn't match your current
>   IP. Google "what is my ip" and update the rule.
> - *Unprotected private key file* → re-run the `chmod`/`icacls` step

To leave the server later, type `exit`.

---

# PHASE 3 — Base software

🖥️ **Update the system:**

```bash
sudo apt update && sudo apt upgrade -y
```

Takes 1–3 minutes. If a purple screen about services appears, press **Tab** →
**Enter** to accept defaults. If asked about a config file, keep the local version.

🖥️ **Install Node.js 24 (Active LTS):**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

⚠️ Do **not** use `apt install nodejs` alone — Ubuntu ships an ancient version
that won't run Next.js 16.

🖥️ **Install git and build tools:**

```bash
sudo apt install -y git build-essential
```

### ✅ Checkpoint 1

```bash
node -v && npm -v && git --version
```

Expect `v24.x.x`, a version number, and `git version 2.x`.
**Don't continue until this works.**

---

# PHASE 4 — Database

🖥️ **Install PostgreSQL:**

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

🖥️ **Create your database and user.**

⚠️ Replace `CHANGE_ME_STRONG_PASSWORD` with a real password. Generate one:

```bash
openssl rand -base64 24
```

Copy the output, then run (pasting your password in place):

```bash
sudo -u postgres psql <<'EOF'
CREATE DATABASE apim;
CREATE USER apim_user WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE apim TO apim_user;
ALTER DATABASE apim OWNER TO apim_user;
EOF
```

⚠️ Save that password — you need it in Phase 5. Avoid `@ : / ?` characters;
they must be percent-encoded inside a connection URL.

### ✅ Checkpoint 2

```bash
psql "postgresql://apim_user:CHANGE_ME_STRONG_PASSWORD@127.0.0.1:5432/apim" -c "SELECT 'db ok';"
```

Expect `db ok`. If you get *authentication failed*, the password doesn't match.

💡 Postgres only listens on localhost by default — good. Don't change that.

---

# PHASE 5 — Deploy the app

🖥️ **Clone the repository:**

```bash
cd ~
git clone https://github.com/eggyeg/apiM.git
cd apiM
git checkout arena/019fc84b-apim
```

⚠️ Private repo? See Appendix B.

🖥️ **Create the environment file:**

```bash
nano .env
```

Type this (substitute your real password):

```
DATABASE_URL=postgresql://apim_user:CHANGE_ME_STRONG_PASSWORD@127.0.0.1:5432/apim
NODE_ENV=production
```

Save in nano: **Ctrl+O** → **Enter** → **Ctrl+X**

🖥️ **Lock the file down** (it holds a password):

```bash
chmod 600 .env
```

🖥️ **Install and build:**

```bash
npm ci
npm run build
```

`npm ci` takes 1–2 min, `npm run build` about 1 min.

⚠️ Killed / out-of-memory during build → you're on a 1 GB instance. Appendix C.

🖥️ **Create the database tables:**

```bash
npx drizzle-kit push --config drizzle.config.json
```

⚠️ This reads `drizzle.config.json`, which currently has a **hardcoded**
localhost URL with `postgres:postgres`. That won't match your new credentials.
Fix it first:

```bash
nano drizzle.config.json
```

Change the `"url"` line to your real connection string, save, then re-run the
push command. Confirm with `y` if prompted.

### ✅ Checkpoint 3

```bash
npm start
```

Expect `✓ Ready`. In a **second terminal** 💻 (new window, SSH in again):

```bash
curl localhost:3000/api/health
```

Expect: `{"ok":true,"database":"connected"}`

🎉 That means app + database are both working.

Press **Ctrl+C** in the first terminal to stop it — next we make it permanent.

---

# PHASE 6 — Keep it running forever

Right now the app dies when you close SSH. `systemd` fixes that.

🖥️ **Create the service:**

```bash
sudo nano /etc/systemd/system/apim.service
```

Paste:

```ini
[Unit]
Description=apiM Next.js app
After=network.target postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/apiM
EnvironmentFile=/home/ubuntu/apiM/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Save (**Ctrl+O**, **Enter**, **Ctrl+X**).

🖥️ **Start it:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now apim
sudo systemctl status apim
```

Expect green **active (running)**. Press **q** to exit the status view.

### ✅ Checkpoint 4

```bash
curl localhost:3000/api/health
```

Still `{"ok":true,...}` — but now it survives disconnects and reboots.

**Useful commands to remember:**
```bash
sudo systemctl restart apim     # restart after code changes
sudo systemctl stop apim        # stop
journalctl -u apim -f           # live logs (Ctrl+C to exit)
journalctl -u apim -n 50        # last 50 log lines
```

---

# PHASE 7 — Domain + HTTPS

## Option A — With a domain (recommended)

Buy one anywhere (Namecheap, Cloudflare, Porkbun ≈ $10/yr).

💻 In your registrar's DNS settings, add:

| Type | Name | Value |
|---|---|---|
| A | `@` | `YOUR_IP` |
| A | `www` | `YOUR_IP` |

Wait 5–30 minutes for DNS to propagate. Check with:
```bash
nslookup yourdomain.com
```
It should return your Elastic IP.

🖥️ **Install Caddy** (handles HTTPS certificates automatically):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

🖥️ **Configure it:**

```bash
sudo nano /etc/caddy/Caddyfile
```

Delete everything, replace with (use your real domain):

```
yourdomain.com, www.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl restart caddy
```

Caddy now fetches a free Let's Encrypt certificate automatically and renews it
forever. Nothing else to do.

### ✅ Checkpoint 5

💻 Open `https://yourdomain.com` in your browser. Padlock icon + your app.

If it fails: `sudo journalctl -u caddy -n 50` — usually DNS hasn't propagated.

## Option B — No domain (IP only, testing)

⚠️ No HTTPS. Clipboard and other browser APIs will be limited. Fine for a quick
look, not for real use.

🖥️
```bash
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```
```
:80 {
    reverse_proxy 127.0.0.1:3000
}
```
```bash
sudo systemctl restart caddy
```
Visit `http://YOUR_IP`.

---

# PHASE 8 — Basic hardening

🖥️ **Enable the firewall:**

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

⚠️ Make sure `OpenSSH` is allowed *before* enabling, or you lock yourself out.
(You'd still have EC2 Serial Console as a rescue.)

🖥️ **Automatic security updates:**

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```
Choose **Yes**.

⚠️ **The app currently has no login.** Anyone with the URL can use it and spend
your DeepSeek credits. Until we build auth (Phase 2 of the workspace plan),
either keep the URL private or add a temporary password — Appendix D.

---

# Updating the app later

🖥️
```bash
cd ~/apiM
git pull origin arena/019fc84b-apim
npm ci
npm run build
sudo systemctl restart apim
```

Wrap it in a script if you do it often:
```bash
printf '#!/bin/bash\nset -e\ncd ~/apiM\ngit pull origin arena/019fc84b-apim\nnpm ci\nnpm run build\nsudo systemctl restart apim\necho "Deployed."\n' > ~/deploy.sh
chmod +x ~/deploy.sh
```
Then just `~/deploy.sh`.

---

# Appendix A — Troubleshooting

| Symptom | Fix |
|---|---|
| `502 Bad Gateway` | App isn't running → `sudo systemctl status apim` |
| Site won't load at all | Caddy down → `sudo systemctl status caddy` |
| `{"ok":false,"database":"unreachable"}` | Postgres down → `sudo systemctl status postgresql`; check `.env` password |
| Build killed / freezes | Not enough RAM → Appendix C |
| Can't SSH | Security Group "My IP" is stale — update to current IP |
| Changes not showing | Forgot `npm run build` and `sudo systemctl restart apim` |

**Where to look first:**
```bash
journalctl -u apim -n 50        # app errors
sudo journalctl -u caddy -n 50  # HTTPS/proxy errors
free -h                         # memory
df -h                           # disk space
```

---

# Appendix B — Private repository

If `git clone` asks for a password, generate a deploy key:

🖥️
```bash
ssh-keygen -t ed25519 -C "apim-server" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy the output → GitHub → your repo → **Settings** → **Deploy keys** →
**Add deploy key** → paste → save.

Then clone with SSH instead:
```bash
git clone git@github.com:eggyeg/apiM.git
```

---

# Appendix C — Low-memory instance (1 GB)

Adds swap so builds don't get killed:

🖥️
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

Builds will be slow but should complete. Upgrading to t3.small is better.

---

# Appendix D — Temporary password protection

Until real auth exists, Caddy can gate the whole site:

🖥️
```bash
caddy hash-password
```
Type a password → copy the resulting hash.

```bash
sudo nano /etc/caddy/Caddyfile
```
```
yourdomain.com {
    basic_auth {
        admin PASTE_THE_HASH_HERE
    }
    reverse_proxy 127.0.0.1:3000
}
```
```bash
sudo systemctl restart caddy
```

Browser now prompts for username `admin` + your password.

⚠️ Stopgap only — fine for keeping strangers out, not a substitute for real
per-user auth before we add code execution.

---

# Checklist

- [ ] EC2 t3.small, Ubuntu 24.04, Elastic IP attached
- [ ] Security Group: SSH=My IP, 80+443=Anywhere
- [ ] SSH works
- [ ] Node 24 installed *(Checkpoint 1)*
- [ ] Postgres + database created *(Checkpoint 2)*
- [ ] App builds, health returns ok *(Checkpoint 3)*
- [ ] systemd service running *(Checkpoint 4)*
- [ ] HTTPS live *(Checkpoint 5)*
- [ ] ufw + auto-updates on
- [ ] Password protection (until real auth)

---

## What comes next

This gets the **current** app running publicly. Docker and the code sandbox
aren't needed yet — those come with Phase 3 of `workspace-plan.md`, and only
after real authentication exists.

If you get stuck, tell me the **step number** and paste the error text.
