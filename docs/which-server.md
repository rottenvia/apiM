# Which server to buy

Prices checked 2026-08-04. Hetzner raised prices in April 2026, so older
guides quote lower figures than you will actually see.

## Short answer

**CX33 — €6.49/month.** 4 vCPU, 8 GB RAM, 80 GB NVMe, 20 TB traffic.
Add €0.50 for an IPv4 address, so **€6.99/month all-in**.

That is enough. The €12 option buys headroom you would not use for a long
time, and Hetzner lets you resize later without rebuilding.

---

## The actual options

All prices exclude the €0.50/month IPv4 charge.

| Plan | vCPU | RAM | Disk | Price | Verdict |
|---|---|---|---|---|---|
| CX23 | 2 | 4 GB | 40 GB | €3.99 | Workable but tight |
| **CX33** | **4** | **8 GB** | **80 GB** | **€6.49** | **Buy this** |
| CX43 | 8 | 16 GB | 160 GB | €11.99 | More than needed |
| CAX21 (ARM) | 4 | 8 GB | 80 GB | €7.99 | Cheaper elsewhere, not here |

## Why CX33 and not CX23

CX23 has 4 GB of RAM, and this workload has three things wanting memory at
once: the Next.js app, the Docker containers running model-generated code, and
Node's build step. Next.js builds in particular are memory-hungry, and 4 GB is
where they start failing on a machine that is also running containers.

The €2.50 difference is less than the time cost of hitting that wall.

## Why not CX43 at €12

Nothing here is CPU-bound. The heavy work — the model — runs on DeepSeek's
servers, not yours. Locally it is a Node process and short-lived containers
that mostly sit idle waiting for API responses.

Buying 16 GB now means paying €66/year extra for RAM that sits unused. If the
workload genuinely outgrows CX33, Hetzner resizes in a few minutes without
reinstalling anything.

## Why not ARM

ARM (CAX) is normally Hetzner's best value — it wins on price/performance in
most benchmarks. But at the 4 vCPU / 8 GB tier, CAX21 is **€7.99 against CX33's
€6.49**, so here x86 is both cheaper and has zero compatibility risk.

Compatibility matters for the sandbox specifically: it runs whatever the model
writes, and if it writes something with an x86-only dependency, an ARM box
fails in a way that looks like the code is wrong. Not worth introducing for a
negative saving.

## Cost in perspective

€6.99/month ≈ €84/year. For comparison, the same 4 vCPU / 8 GB elsewhere:

- DigitalOcean: ~$48/month
- AWS: ~$60/month
- Vultr: ~$48/month

Hetzner is genuinely 6-8x cheaper at this tier. Billing is hourly with a
monthly cap, so a server deleted after ten days costs a third of the month —
useful if you want to try it before committing.

---

## What to select when ordering

- **Location:** Falkenstein or Nuremberg (Germany), or Helsinki. All are
  ~30-40 ms from Ukraine. Falkenstein is fine.
- **Image:** Ubuntu 24.04
- **Type:** Shared vCPU → Cost-Optimized → **CX33**
- **SSH key:** add one if you have it; password login works otherwise
- **Backups:** +20% (€1.30/month). Worth it, but can be enabled later.

Skip the load balancer, floating IP and everything else.

---

## What this changes about the project

**Solves:**

- The broken VHD stack on the Windows machine, entirely. Docker on Linux needs
  no Hyper-V, no WSL2, no FsDepends.
- Any question of gaming performance — nothing runs locally.
- The app can stay running when the PC is off, and is reachable from a phone.

**Introduces:**

- **Auth becomes mandatory.** Right now anyone who can reach the app can read
  and write files in `data/workspaces/`. On localhost only you can reach it; on
  a public IP that is not true. This has to be built before the server is
  exposed.
- **A firewall.** Only ports 22 and 443 open; the app not directly reachable.
- **HTTPS.** API keys should not travel over plain HTTP. Caddy does this
  automatically with a free certificate.

None of that is difficult, but it is the honest cost of moving off localhost.

## Order of work

1. Order the server, install Docker (~15 minutes)
2. **Auth** — before it is reachable from the internet
3. Firewall + HTTPS
4. Deploy the app
5. Then `run_command` and the agent loop, which is the point of all this
