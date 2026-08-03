# Running apiM for Free (No Cloud Bill)

Three ways to use this app without paying for hosting. Start at Option 1.

Verified 2026-08-03.

---

## ⚠️ First: the AWS free tier is not what it used to be

If you signed up **after 15 July 2025**, the old "12 months of free t2.micro"
**no longer exists**. New accounts now get:

- $100 credit at signup, up to $200 total by completing tasks
- **Free Plan lasts 6 months — or until credits run out, whichever is first**
- After that, **AWS closes the account** unless you upgrade to a paid plan

So a `t3.micro` isn't free forever anymore — it burns credits, then stops.
It's fine for *learning*, not for a permanent home for your tool.

Two more things people get billed for by accident:
- **Unattached Elastic IPs** — free while attached to a running instance, charged
  when not
- **Orphaned EBS volumes** — deleting an instance doesn't always delete its disk

> Already had an AWS account before? You're likely **not eligible** for the new
> free plan at all — eligibility is tied to your identity, checked retroactively.

---

## Option 1 — Run it on your own computer (recommended)

**Cost: $0. Setup: ~10 minutes.** No server, no credit card, no risk.

Honestly, for a personal tool this is the right answer. The DeepSeek API is
remote anyway, so the only thing a server buys you is *access from other
devices* — and Option 2 solves that for free too.

### 1.1 Install Node.js

Download the **LTS** version (Node 24) from https://nodejs.org and install it.

Check it worked — open Terminal (Mac) or PowerShell (Windows):

```bash
node -v
```
Expect `v24.x.x` or higher.

### 1.2 Get the code

```bash
git clone https://github.com/eggyeg/apiM.git
cd apiM
git checkout arena/019fc84b-apim
npm install
```

### 1.3 Run it

```bash
npm run dev
```

Open **http://localhost:3000**, click **Settings**, paste your DeepSeek API key.
Done — it works.

> No database needed. The app runs fine without `DATABASE_URL`; you just don't
> get saved chat history. Add it later with 1.4 if you want it.

### 1.4 (Optional) Chat history

Requires PostgreSQL. Easiest is Docker Desktop (free) — https://docker.com

```bash
docker run -d --name apim-db \
  -e POSTGRES_PASSWORD=localdev \
  -e POSTGRES_DB=apim \
  -p 5432:5432 \
  postgres:16
```

Create a file named `.env` in the project folder:

```
DATABASE_URL=postgresql://postgres:localdev@127.0.0.1:5432/apim
```

Then create the tables:

```bash
npx drizzle-kit push --config drizzle.config.json
```

⚠️ `drizzle.config.json` currently has a hardcoded URL. If the command fails,
open that file and make the `url` match your `.env` line.

Restart `npm run dev`. Check http://localhost:3000/api/health — it should say
`{"ok":true,"database":"connected"}`.

**Starting it next time:**
```bash
docker start apim-db     # only if you set up the database
cd apiM && npm run dev
```

---

## Option 2 — Access it from your phone, still free

Your app is running locally but you want to reach it from anywhere. A **tunnel**
gives your local server a public HTTPS address, no server required.

### Cloudflare Tunnel (free, no account needed for a quick test)

Install `cloudflared` (see Cloudflare's docs for your OS), then with
`npm run dev` already running in another terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a URL like `https://random-words.trycloudflare.com`. That works from
your phone, from anywhere — real HTTPS, so the clipboard and other browser APIs
behave properly.

⚠️ **That URL is public.** Anyone who has it can use your app and spend your
DeepSeek credits. Only share it deliberately, and stop the tunnel (Ctrl+C) when
you're done. The quick-tunnel URL changes each run, which helps.

💡 A free Cloudflare account + a domain gets you a permanent, password-protected
tunnel. Good middle ground once you outgrow the temporary one.

---

## Option 3 — A genuinely free always-on server

If you truly want it online 24/7 without paying, **Oracle Cloud Always Free** is
the only major option with a permanent free VM (AWS has none).

**What you get:** ARM (Ampere A1) instance, 200 GB storage, 10 TB/month egress,
no time limit.

⚠️ **Honest caveats — this is not a smooth path:**

1. **Signup rejections are common.** Their fraud detection rejects many
   legitimate users. Improve your odds: real credit card (not virtual/prepaid),
   billing address matching, no VPN during signup.
2. **"Out of capacity" errors.** Free ARM instances are in huge demand; you may
   need to retry over several days.
3. **The free ARM allocation was cut** around June 2026 from 4 CPU/24 GB to
   **2 CPU/12 GB**. Enforcement has been inconsistent, but plan for 2/12 — still
   far better than a `t3.micro`.
4. **Idle instances can be reclaimed.**
5. **ARM, not x86.** Node and Postgres are fine; some Docker images aren't.

If you get through signup, `docs/vps-setup-guide.md` applies almost unchanged —
pick Ubuntu 24.04 ARM, and the commands are identical.

**Other options:** Fly.io and Railway have small free/trial allowances; Hetzner
is ~€4/mo with no credit-burn games and is genuinely good value if you later
decide to spend a little.

---

## Which should you pick?

| Situation | Do this |
|---|---|
| Just want to use the tool | **Option 1** — local |
| Want it on your phone sometimes | **Option 1 + 2** — local + tunnel |
| Want it online 24/7, $0 | **Option 3** — Oracle, with patience |
| Want it online 24/7, painless | Hetzner ~€4/mo, or AWS with the $200 credit |

**My recommendation: Option 1 now, add Option 2 when you need it.**

You lose nothing by waiting. Everything in the workspace plan (file tools, the
agent loop) works perfectly on localhost. The *only* feature that genuinely
needs a server is running AI-generated code in a sandbox — and that shouldn't
ship before authentication exists anyway.

Run it locally, build the features, and revisit hosting when you actually have
something you want online.

---

## If you do use AWS credits anyway

Set a billing alarm **first**:

1. AWS Console → **Billing and Cost Management** → **Budgets**
2. **Create budget** → Cost budget → e.g. $5/month
3. Add your email as an alert recipient

Also, when you're done experimenting: **terminate the instance** (not just stop
it), **release the Elastic IP**, and **delete leftover EBS volumes**. Those three
are what generate surprise bills.
