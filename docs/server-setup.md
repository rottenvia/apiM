# Setting up the server

Start to finish, about 20 minutes. Every command is copy-pasteable.

> 💻 = on your own PC  ·  🖥️ = on the server

---

> **Any provider works.** These steps are Ubuntu plus Docker — nothing here is
> Hetzner-specific. Netcup, Contabo, Hostinger, DigitalOcean: only step 1
> differs. See [which-server.md](./which-server.md) for the comparison,
> including which ones don't ask for ID.

## 1. Order it

[console.hetzner.cloud](https://console.hetzner.cloud) → **New Server**

- **Location:** Falkenstein (Germany) — ~30-40 ms from Ukraine
- **Image:** Ubuntu 24.04
- **Type:** Shared vCPU → **Cost-Optimized** → **CX33** (€8.49/mo excl. VAT)
- **Networking:** leave IPv4 ticked (+€0.50)
- **SSH key:** add one if you have it, otherwise Hetzner emails a password
- Everything else: leave alone

You get an IP address like `95.216.x.x`. That is your server.

## 2. Connect

💻 In PowerShell:

```powershell
ssh root@YOUR-SERVER-IP
```

Type `yes` at the fingerprint prompt. Paste the password from Hetzner's email
(it will show nothing as you type — that is normal).

## 3. Basic hardening

🖥️ Update, then set up a firewall:

```bash
apt update && apt upgrade -y
```

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Only SSH and web traffic get in. The app itself is never directly reachable.

⚠️ **Docker publishes ports around ufw.** A container using `ports: 3000:3000`
would be open to the internet even though ufw says otherwise. This is why the
compose file uses `expose` for the app instead — only Caddy publishes ports.

## 4. Install Docker

🖥️

```bash
curl -fsSL https://get.docker.com | sh
```

Check it:

```bash
docker run --rm hello-world
```

That is the entire Docker install. No Hyper-V, no WSL, no virtual disk drivers.

## 5. Get the code

🖥️

```bash
apt install -y git
git clone https://github.com/eggyeg/apiM.git
cd apiM
git checkout arena/019fc84b-apim
```

## 6. Set the password

🖥️ Generate a session key and copy the output:

```bash
openssl rand -hex 32
```

Create the config:

```bash
cp deploy/.env.example deploy/.env
nano deploy/.env
```

Fill in three values:

```ini
APP_PASSWORD=whatever-long-password-you-choose
AUTH_SECRET=paste-the-openssl-output-here
SITE_ADDRESS=:80
```

Save with **Ctrl+O**, Enter, then **Ctrl+X**.

⚠️ `SITE_ADDRESS=:80` means plain HTTP — fine for a first test, but your API
keys travel unencrypted. Put a domain there as soon as you have one (step 9)
and HTTPS becomes automatic.

## 7. Start it

🖥️

```bash
cd deploy
docker compose up -d --build
```

First build takes 3-5 minutes. Then:

```bash
docker compose ps
```

Both containers should say `running`.

## 8. Open it

💻 In your browser: **http://YOUR-SERVER-IP**

You should get the password screen. Sign in with what you set in
`APP_PASSWORD`, then add your DeepSeek key in Settings as usual.

## 9. Add a domain (recommended)

Plain HTTP means anyone on the network path can read your API keys. A domain
fixes that and costs a few euros a year.

Point an `A` record at your server's IP, then:

🖥️

```bash
cd ~/apiM/deploy
nano .env
```

Change `SITE_ADDRESS=:80` to `SITE_ADDRESS=apim.yourdomain.com`, then:

```bash
docker compose up -d
```

Caddy fetches a certificate automatically within about a minute. Visit
`https://apim.yourdomain.com`.

---

## Everyday commands

🖥️ All from `~/apiM/deploy`:

```bash
docker compose logs -f app      # watch the logs
docker compose restart          # restart
docker compose down             # stop
docker compose up -d            # start
```

Update to the latest code:

```bash
cd ~/apiM
git pull origin arena/019fc84b-apim
cd deploy
docker compose up -d --build
```

Your chats and workspace files live in `~/apiM/data` on the host, so rebuilding
never deletes them.

## Backups

Hetzner's automatic backups are +20% (€1.30/mo) and worth it. Enable them in
the Hetzner console under your server → Backups.

To copy your chats to your PC:

💻

```powershell
scp -r root@YOUR-SERVER-IP:/root/apiM/data ./apim-backup
```

---

## Troubleshooting

**Password page never appears, connection refused** — check Caddy is up:
`docker compose ps`, then `docker compose logs caddy`.

**"Auth is required but not configured"** — `deploy/.env` is missing
`APP_PASSWORD` or `AUTH_SECRET`. The app refuses to run unprotected on
purpose; fill them in and `docker compose up -d`.

**Certificate not issued** — the domain's DNS must point at the server before
Caddy can prove ownership. Check with `dig +short yourdomain.com`, wait for
propagation, then `docker compose restart caddy`.

**Locked out after too many wrong passwords** — the limit is 8 attempts per 15
minutes. Wait, or `docker compose restart app` to clear it.

**Forgotten password** — edit `deploy/.env` and `docker compose up -d`. There
is no recovery flow because there is no account system; the file is the source
of truth.
