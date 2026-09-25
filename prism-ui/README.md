# PRISM-UI · premium Roblox settings interface

A complete, single-file Luau UI library: one **Visuals** tab with a deeply
detailed settings panel — exhaustive ESP selections with per-option
sub-settings, and a premium **2D HSV color picker** (SV canvas, hue /
brightness / alpha strips, old-vs-new preview, hex + palettes).

- **Zero image assets** — every gradient, swatch and checker is drawn with
  `UIGradient` + frames, so the file works the same on every client.
- **78 schema-driven settings** across ESP, Chams, Overlays, View, Colors,
  Keybinds and Config. The whole panel is *generated* from `Schema` — adding
  a setting is a one-table change.
- **State done right**: validated store, transactions, undo/redo, profiles,
  debounced autosave, JSON import/export.
- **414 automated checks** (logic + widget + end-to-end on the bundle),
  running on real Luau with a strict headless engine mock.

## Quick start (executor)

```lua
local PRISM = loadstring(readfile("PRISM.luav2"))()
local app = PRISM.new({ profile = "Legit" })

app:toggle()            -- show / hide
app:setProfile("Rage")  -- swap preset
app.store:get("esp.enabled")
app:destroy()
```

Re-executing the file destroys the previous app first — no duplicate windows.
`PRISM.new` accepts `parent`, `profile`, `title`/`subtitle`, `width`/`height`,
`saveFolder`/`saveFile`, `autoSave` and `accentSync`.

> The shippable artifact is **`dist/PRISM.luau`** (built from `src/`).
> `src/` is the readable, commented, per-module source of the same code.

## What's inside

| Module | Job |
|---|---|
| `Color` | HSV/RGB/hex math, gradients, WCAG contrast, CVD simulation, palettes |
| `Signal` | Re-entrancy-safe event bus (snapshot firing, error isolation) |
| `Theme` | Design tokens + Midnight / Ember / Glacier presets, live overrides |
| `Util` | Formatting, `1.5k`-style scalar parsing, debounce, ranked search |
| `Schema` | All 78 settings: kinds, defaults, ranges, validation, search, profiles |
| `Store` | Validated state, transactions, undo/redo, autosave hook |
| `Widgets` | Toggle, Slider, Dropdown, Keybind, Textbox, ColorField, Button, … |
| `ColorPicker` | The premium HSV popup (SV canvas + strips + preview + palettes) |
| `Panel` | Generates the Visuals tab from the schema (search, groups, import/export) |
| `Window` | Chrome: drag, resize, sidebar tabs, overlay layer, toasts, UI scale |
| `Init` | Public API: boot, hotkeys, accent sync, persistence adapter |

### The picker

- **SV canvas**: 25 exact white→hue rows pre-multiplied by V — no rotation
  tricks, identical on every client.
- **Hue** (rainbow), **brightness** (black→color) and **alpha** (over grey)
  strips with live cursors; drags commit on release.
- Split old/new preview, `#RRGGBB[AA]` hex box, 24 curated palette swatches.
- Opens anchored to its swatch, flips to stay inside the viewport, closes on
  outside-click / `Esc`.

### Settings at a glance

- **ESP**: master switch, team check (+mode), max distance, visibility check,
  target filter (multi) — plus **Boxes** (Corner/Outline/Filled3D, thickness,
  rounding, fill), **Names** (position, size, distance, outline), **Health**
  (bar/text/both, side, width, track), **Skeletons**, **Tracers** (incl. mouse
  origin), **Head dot**, **Off-screen arrows** — each with its own sub-settings
  that dim while their master toggle is off.
- **Chams**: Flat/Shaded/Glow, fill + outline opacity, visible-only, rainbow.
- **Overlays**: crosshair (size/gap/thickness/dot), FOV circle (radius/ring/disc).
- **View**: camera (FOV, third-person, boom) and environment (fullbright,
  exposure, no-fog, time lock).
- **Colors**: ally / enemy / visible / hidden / UI accent (**live re-theme**) /
  chams / chams edge / FOV / crosshair.
- **Keybinds**: UI, ESP, chams + a **panic key** (kills visuals, hides UI).
- **Config**: Default/Legit/Rage/Streamer profiles, autosave, streamer mode,
  tooltips, UI scale, JSON copy/import, reset-all.

## Rendering your ESP from the store

PRISM-UI is the interface + state layer; your renderer reads the store:

```lua
app.store:subscribe("esp.enabled", function(_, on)
    -- rebuild / show / hide ESP
end)

game:GetService("RunService").RenderStepped:Connect(function()
    if not app.store:get("esp.enabled") then return end
    local maxD = app.store:get("esp.maxDistance")
    local ally = app.store:get("colors.ally") -- { h, s, v, a }
    -- ...draw with your Drawing/Instance code...
end)
```

`store:subscribe(nil, fn)` observes everything; `store:export()` snapshots;
`store:import(table)` restores (migrated, single undo step).

## Persistence

With executor file IO (`writefile`/`readfile`/`isfile`), every change
autosaves (debounced) to `prism/config.json` and disk state wins on boot —
old saves are migrated, corrupt saves fall back to defaults. Without file IO
the app runs session-only and the Config tab's Copy/Import covers saving.

## Development

```bash
# Build the single-file artifact
python3 tools/bundle.py            # -> dist/PRISM.luau

# Run the suites (needs tools/luau-run; see below)
./tools/luau-run tests/logic.luau  # 228 checks: pure modules + JSON shape
./tools/luau-run tests/ui.luau     # 163 checks: widgets/panel/window/app
./tools/luau-run tests/e2e.luau    #  23 checks: dist bundle boots + no leaks
```

`tests/mock.luau` is a strict headless Roblox (unknown classes, services and
enum members *error*), with a fake `task` scheduler for deterministic timing.

### Toolchain

`tools/luau-run` is a minimal Luau runner built from source
(`tools/luau-src/`, git-ignored) with `require()` for sibling modules:

```bash
g++ -O1 -std=c++17 -IVM/include -ICompiler/include -ICommon/include \
    -IAst/include -IBytecode/include VM/src/*.cpp Compiler/src/*.cpp \
    Ast/src/*.cpp Bytecode/src/*.cpp Common/src/*.cpp ../run.cpp -o ../luau-run
```

## Design notes

- **Controlled components**: widgets render `value` and report gestures via
  `onChanged`; `handle:set()` is always silent, so store↔UI can never echo.
- **Scheduler-optional**: `task` is resolved as a global at call time and
  every delayed path (debounce, autosave, toasts) degrades gracefully.
- **No `WaitForChild` / `:Wait()`** anywhere — the library never yields.
- **Glyphs**: `✓` `▼` `▲` `×` `…` (standard Gotham coverage, used widely in
  Roblox UIs); no icon fonts or image assets.
- **Types**: modules carry `--!strict` annotations for Studio editing; the
  executor path is unaffected by type checking.
