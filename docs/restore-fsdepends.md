# Restoring the FsDepends driver registration

`FsDepends` is the Windows driver the virtual-disk (VHDX) system depends on.
When its registry key is missing, nothing can create a virtual disk — WSL2,
Docker Desktop, Hyper-V, Windows Sandbox and even mounting an ISO all fail,
usually with `0xc03a0014`.

This restores the registration without a repair install.

## Read this first

`FsDepends` is a **file-system minifilter**. A wrong value here can stop
Windows booting, so the order below matters:

- We look for the **original values on your own machine** before typing any by
  hand. Exact beats approximate.
- We set `Start` to **3 (on demand)** first, never `0`. If something is wrong,
  Windows still boots and you can undo it. `3` is also Microsoft's documented
  default.
- Only after it is confirmed loading do we consider `0`.

**Make a System Restore point first.** Start → "Create a restore point" →
select `C:` → **Create**. If anything goes wrong this undoes it in five
minutes.

---

## Step 1 — Look for the original key in a backup control set

Windows keeps previous copies of the services registry. If one still has
`FsDepends`, you get the **exact original values** and nothing has to be
guessed.

Command Prompt **as Administrator**:

```
reg query HKLM\SYSTEM\ControlSet001\Services\FsDepends
reg query HKLM\SYSTEM\ControlSet002\Services\FsDepends
reg query HKLM\SYSTEM\ControlSet003\Services\FsDepends
```

Most will say "unable to find" — that is fine, you only need one to work.

**If one of them returns values**, export it and import it into the live set.
Say `ControlSet002` worked:

```
reg export HKLM\SYSTEM\ControlSet002\Services\FsDepends "%USERPROFILE%\Desktop\FsDepends.reg"
```

Open that `.reg` file on your Desktop in Notepad, change every
`ControlSet002` to `CurrentControlSet`, save, then double-click it and accept
the prompt.

Reboot and skip to **Step 4**.

## Step 2 — Check the driver file is actually there

```
dir C:\Windows\System32\drivers\FsDepends.sys
```

- **File listed** — good, only the registration is missing. Continue.
- **File Not Found** — the driver binary is gone too, and no registry entry
  will help. Jump to **If the file is missing** at the bottom.

## Step 3 — Recreate the key

Only if Step 1 found nothing. Run these one at a time in an **Administrator**
Command Prompt:

```
reg add HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v Type /t REG_DWORD /d 2 /f
reg add HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v Start /t REG_DWORD /d 3 /f
reg add HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v ErrorControl /t REG_DWORD /d 1 /f
reg add HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v ImagePath /t REG_EXPAND_SZ /d "system32\drivers\FsDepends.sys" /f
reg add HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v DisplayName /t REG_SZ /d "FsDepends" /f
reg add HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v Group /t REG_SZ /d "FSFilter System Recovery" /f
reg add HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v DependOnService /t REG_MULTI_SZ /d "FltMgr" /f
```

A minifilter also needs an instance, or the filter manager refuses to load it:

```
reg add "HKLM\SYSTEM\CurrentControlSet\Services\FsDepends\Instances" /v DefaultInstance /t REG_SZ /d "FsDepends Instance" /f
reg add "HKLM\SYSTEM\CurrentControlSet\Services\FsDepends\Instances\FsDepends Instance" /v Altitude /t REG_SZ /d "407000" /f
reg add "HKLM\SYSTEM\CurrentControlSet\Services\FsDepends\Instances\FsDepends Instance" /v Flags /t REG_DWORD /d 0 /f
```

What these mean:

| Value | Why |
|---|---|
| `Type 2` | file system driver |
| `Start 3` | load on demand — **safe**; cannot break boot |
| `ErrorControl 1` | log a failure, don't halt |
| `ImagePath` | where the driver lives (relative path is correct here) |
| `Group` | load-order group for recovery-class filters |
| `DependOnService FltMgr` | every minifilter needs the filter manager |
| `Altitude 407000` | position in the filter stack |

On the altitude: `407000` sits in the range Microsoft reserves for
`FSFilter System Recovery` (400000-409999), which is the group this driver
belongs to. If it is not the exact original number that is tolerable — altitude
only decides ordering between filters, and a unique value in the right range
loads fine. A *missing* altitude does not, which is why the `Instances` keys
matter.

Check afterwards with `fltmc filters`; if some other driver already occupies
407000, pick another number in that range and set it again.

**Reboot.**

## Step 4 — Test

```
fltmc filters
```

`FsDepends` should appear in the list. Then the real test:

```
diskpart
create vdisk file=C:\test.vhdx maximum=64 type=expandable
exit
```

**Created successfully** — fixed. Delete `C:\test.vhdx`, then run
`wsl --install -d Ubuntu`.

**Same error still** — try `Start` as `0` (boot start), which is what Microsoft
recommends when VHD operations misbehave:

```
reg add HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /v Start /t REG_DWORD /d 0 /f
```

Reboot and test again. This is the step with real risk, which is why it comes
last and only after the driver has been seen loading.

While you are here, `vhdmp` was `0x3` on this machine. That is its normal
default, but Microsoft's VHD troubleshooting sets it to boot start too:

```
reg add HKLM\SYSTEM\CurrentControlSet\Services\vhdmp /v Start /t REG_DWORD /d 0 /f
```

---

## If Windows won't boot after a change

This is why `Start 3` comes first — it should not happen. If it does:

1. Power off during boot three times; Windows opens Recovery.
2. **Troubleshoot → Advanced options → System Restore** — pick the point you
   made at the start. Done.
3. Or **Startup Settings → Restart → 4** for Safe Mode, then undo the change:
   ```
   reg delete HKLM\SYSTEM\CurrentControlSet\Services\FsDepends /f
   ```

## If the driver file is missing

If `FsDepends.sys` is not in `System32\drivers`, no registry work will help.
Two options that are not a full repair install:

**Copy it from the Windows ISO.** Download the Windows 11 ISO, open it with
7-Zip (do not mount it — mounting needs the broken VHD stack), and extract
`sources\install.wim`. The driver is inside at
`Windows\System32\drivers\FsDepends.sys`. Copy it into your
`C:\Windows\System32\drivers\`, then do Step 3.

**Copy it from another Windows 11 PC** on the same build. Check yours with
`winver`. Same-build files are interchangeable; different builds are not
guaranteed to be.

---

## If none of this works

The virtual disk stack is damaged beyond a registry fix. Rather than a repair
install, running the sandbox on a small Linux VPS avoids the entire problem —
see [roadmap.md](./roadmap.md). Nothing then runs on this machine, which also
removes any question of gaming performance.
