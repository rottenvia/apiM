--!strict
-- ============================================================================
--  PRISM-UI · end-to-end test: loads dist/PRISM.luau (the real shippable
--  artifact) on mocks, boots the app, drives it, and checks for leaked
--  globals. Rebuild the bundle first:  python3 tools/bundle.py
--  Run:  luau-run tests/e2e.luau
-- ============================================================================

local Mock = require("mock")
Mock.install()
local sched = Mock.FakeScheduler()
sched.install()

local passCount = 0
local failCount = 0
local function check(cond: boolean, msg: string)
	if cond then
		passCount += 1
	else
		failCount += 1
		print("  FAIL: " .. msg)
	end
end

-- Snapshot globals AFTER the mock is in (the mock's additions are known).
local baseline: { [string]: boolean } = {}
for k in pairs(_G) do
	baseline[k] = true
end

local PRISM = require("../dist/PRISM")

print("\n## e2e: bundle boots")
check(PRISM._VERSION == "1.0.0", "version exposed")
for _, mod in ipairs({ "Color", "Signal", "Theme", "Util", "Schema", "Store", "Widgets", "ColorPicker", "Panel", "Window" }) do
	check(PRISM[mod] ~= nil, "submodule " .. mod .. " exposed")
end

local app = PRISM.new({})
check(app.window:isVisible(), "window visible after boot")
check(app.window:activeTabName() == "Visuals", "visuals tab active")
local fieldCount = #PRISM.Schema.FIELDS
local handleCount = 0
for _ in pairs(app.panel.handles) do
	handleCount += 1
end
check(handleCount == fieldCount, "panel covers schema (" .. handleCount .. ")")

print("\n## e2e: drive")
-- Widget -> store -> widget round trip through the real UI tree.
local toggle = app.panel.handles["esp.enabled"]
local pill: any = nil
for _, ch in ipairs(toggle.root:GetChildren()) do
	if ch.Name == "Pill" then
		pill = ch
	end
end
pill.MouseButton1Click:Fire()
check(app.store:get("esp.enabled") == true, "UI click writes store")
app.store:set("esp.maxDistance", 750)
check(app.panel.handles["esp.maxDistance"]:get() == 750, "store pushes UI")
-- Hotkey path.
Mock.UserInputService.InputBegan:Fire(Mock.keyInput("RightShift"), false)
check(not app.window:isVisible(), "hotkey hides")
-- Accent + scale + profile.
app.store:set("colors.accent", { h = 0.5, s = 1, v = 1, a = 1 })
check(PRISM.Theme.get("accent") == "#00FFFF", "accent live-themes")
app:setProfile("Legit")
check(app.store:get("esp.enabled") == true, "profile applies")
check(app.store:get("chams.enabled") == false, "legit keeps chams off")
sched.pump() -- toast timers etc. must not error
check(true, "scheduler pumps cleanly")

print("\n## e2e: teardown + leaks")
app:destroy()
check(_G.__PRISM_APP == nil, "global app ref cleared")
sched.uninstall()
local leaked: { string } = {}
for k in pairs(_G) do
	if baseline[k] ~= true then
		table.insert(leaked, tostring(k))
	end
end
check(#leaked == 0, "no globals leaked (" .. table.concat(leaked, ", ") .. ")")

print(string.format("\n==== e2e: %d passed, %d failed ====", passCount, failCount))
if failCount > 0 then
	error(failCount .. " e2e test(s) failed", 0)
end
