# Which server to buy

**Prices verified 2026-08-04 against Hetzner's official price list:**
https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/#cloud-servers

⚠️ Hetzner raised prices **twice in 2026** — once in April, again on 15 June.
Nearly every blog and comparison article still quotes the April figures, which
are now wrong. The link above is Hetzner's own page and is the only figure
worth trusting.

## Short answer

**CX33 — €8.49/month** excluding VAT and IPv4.
4 vCPU, 8 GB RAM, 80 GB NVMe, 20 TB traffic.

Real monthly cost from Ukraine:

| | |
|---|---|
| CX33 | €8.49 |
| IPv4 address | €0.50 |
| **Total, excl. VAT** | **€8.99** |

Hetzner charges German VAT (19%) unless you supply a business VAT ID, so as a
private customer expect roughly **€10.70/month**. Confirm the final figure in
the console before ordering — it shows the total including tax.

---

## The actual options

Official prices, Germany/Finland, excluding VAT and IPv4.

| Plan | vCPU | RAM | Disk | Was (April) | **Now** |
|---|---|---|---|---|---|
| CX23 | 2 | 4 GB | 40 GB | €3.99 | **€5.49** |
| **CX33** | **4** | **8 GB** | **80 GB** | €6.49 | **€8.49** |
| CX43 | 8 | 16 GB | 160 GB | €11.99 | **€15.99** |
| CAX21 (ARM) | 4 | 8 GB | 80 GB | €7.99 | **€10.49** |

## Why CX33 and not CX23

CX23 has 4 GB of RAM, and this workload has three things wanting memory at
once: the Next.js app, the Docker containers running model-generated code, and
Node's build step. Next.js builds in particular are memory-hungry, and 4 GB is
where they start failing on a machine that is also running containers.

The gap is €3/month. Hitting that wall costs more time than that is worth.

If €5.49 versus €8.49 genuinely matters, CX23 is not unusable — you would build
the Docker image and then keep builds off the box. But CX33 is the one that
just works.

## Why not CX43 at €15.99

Nothing here is CPU-bound. The heavy work — the model — runs on DeepSeek's
servers, not yours. Locally it is a Node process and short-lived containers
that mostly sit idle waiting for API responses.

That is €90/year extra for RAM that sits unused. If the workload genuinely
outgrows CX33, Hetzner resizes in a few minutes without reinstalling anything.

## Why not ARM

ARM (CAX) is normally Hetzner's best value. But at this tier CAX21 is **€10.49
against CX33's €8.49**, so x86 is both cheaper and has zero compatibility risk.

Compatibility matters for the sandbox specifically: it runs whatever the model
writes, and if it writes something with an x86-only dependency, an ARM box
fails in a way that looks like the code is wrong. Not worth introducing for a
negative saving.

## Avoid CCX entirely

The dedicated-CPU line went up **over 200%** in June — CCX13 went from €15.99
to €42.99. If an older guide recommends CCX for a small project, it was written
before that and is badly out of date.

## Cost in perspective

€8.99/month excl. VAT ≈ €108/year, or about €128 with VAT. For comparison, the
same 4 vCPU / 8 GB elsewhere:

- DigitalOcean: ~$48/month
- AWS: ~$60/month
- Vultr: ~$48/month

Even after two increases Hetzner is still 4-5x cheaper at this tier. Billing is
hourly with a monthly cap (CX33 is €0.0136/hour), so a server deleted after ten
days costs about a third of the month — cheap enough to try before committing.

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
