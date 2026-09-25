--!strict
-- ============================================================================
--  PRISM-UI · ui tests (Widgets, ColorPicker, Panel, Window, Init on mocks).
--  Run:  luau-run tests/ui.luau
-- ============================================================================

local Mock = require("mock")
Mock.install()
-- Standalone Luau has no `task` library (Roblox always does); run the suite
-- with the fake scheduler so delayed work is deterministic.
local sched = Mock.FakeScheduler()
sched.install()
local Widgets = require("../src/Widgets")
local ColorPicker = require("../src/ColorPicker")
local Panel = require("../src/Panel")
local Window = require("../src/Window")
local PRISM = require("../src/Init")
local Schema = require("../src/Schema")
local Store = require("../src/Store")
local Theme = require("../src/Theme")
local Util = require("../src/Util")

local passCount = 0
local failCount = 0
local failures: { string } = {}
local currentSection = ""

local function section(name: string)
	currentSection = name
	print("\n## " .. name)
end
local function check(cond: boolean, msg: string)
	if cond then
		passCount += 1
	else
		failCount += 1
		table.insert(failures, "[" .. currentSection .. "] " .. msg)
		print("  FAIL: " .. msg)
	end
end
local function eq(a: any, b: any, msg: string)
	check(a == b, msg .. " (expected " .. tostring(b) .. ", got " .. tostring(a) .. ")")
end
local function approx(a: number, b: number, eps: number, msg: string)
	check(math.abs(a - b) <= eps, msg .. string.format(" (expected ~%.4f, got %.4f)", b, a))
end

local function freshRoot(): (any, any)
	Mock.reset()
	local host = Mock.Instance.new("Frame", Mock.CoreGui)
	local overlay = Mock.Instance.new("Frame", Mock.CoreGui)
	overlay.AbsoluteSize = Mock.Vector2.new(1280, 800)
	return host, overlay
end

local function findChild(root: any, name: string): any
	for _, ch in ipairs(root:GetChildren()) do
		if ch.Name == name then
			return ch
		end
	end
	return nil
end

-- ============================================================================
section("Widgets: Toggle")
-- ============================================================================

do
	local host, _ = freshRoot()
	local fired: { any } = {}
	local t = Widgets.Toggle({
		label = "ESP", description = "Master switch", value = false,
		onChanged = function(v) table.insert(fired, v) end,
	}, host)
	eq(t:get(), false, "initial value")
	check(findChild(t.root, "Desc") ~= nil, "description renders")
	local pill = findChild(t.root, "Pill")
	local hit = findChild(t.root, "Hit")
	pill.MouseButton1Click:Fire()
	check(t:get() == true and #fired == 1, "pill click toggles + fires")
	hit.MouseButton1Click:Fire()
	check(t:get() == false and #fired == 2, "row click toggles")
	t:set(true)
	check(t:get() == true and #fired == 2, "set is silent")
	t:toggle()
	check(t:get() == false and #fired == 3, "toggle() gestures")
	t:enable(false)
	pill.MouseButton1Click:Fire()
	check(t:get() == false and #fired == 3, "disabled blocks input")
	check(pill.BackgroundTransparency == 0.5, "disabled dims pill")
	t:enable(true)
	Theme.setToken("accent", "#FF0000")
	t:set(true)
	t:_refresh()
	local knob = findChild(pill, "Knob")
	check(knob.Position.X.Offset == 23, "knob right when on")
	Theme.setToken("accent", nil)
	t:_refresh()
	t:destroy()
	check(#t.root:GetChildren() == 0 or t.root.Parent == nil, "destroy detaches")
end

-- ============================================================================
section("Widgets: Slider")
-- ============================================================================

do
	local host, _ = freshRoot()
	local fired: { any } = {}
	local sl = Widgets.Slider({
		label = "Range", description = "How far", min = 0, max = 200, step = 5,
		unit = "px", decimals = 0, value = 137,
		onChanged = function(v) table.insert(fired, v) end,
	}, host)
	eq(sl:get(), 135, "initial value normalized (snap)")
	local track = findChild(sl.root, "Track")
	track.AbsolutePosition = Mock.Vector2.new(0, 0)
	track.AbsoluteSize = Mock.Vector2.new(200, 4)
	local grab = findChild(sl.root, "Grab")
	grab.InputBegan:Fire(Mock.mouseInput("MouseButton1", 100, 0))
	eq(sl:get(), 100, "click maps to value")
	Mock.UserInputService.InputChanged:Fire(Mock.mouseInput("MouseMovement", 104.6, 0))
	eq(sl:get(), 105, "drag snaps to step")
	-- Shift == precision drag (step / 10, then decimal rounding).
	Mock._setKeyDown("LeftShift", true)
	Mock.UserInputService.InputChanged:Fire(Mock.mouseInput("MouseMovement", 104.6, 0))
	eq(sl:get(), 105, "precision keeps nearby value")
	Mock.UserInputService.InputChanged:Fire(Mock.mouseInput("MouseMovement", 107.3, 0))
	eq(sl:get(), 108, "precision lands off-step (108 vs coarse 105)")
	Mock._setKeyDown("LeftShift", false)
	Mock.UserInputService.InputEnded:Fire(Mock.mouseInput("MouseButton1", 107, 0))
	Mock.UserInputService.InputChanged:Fire(Mock.mouseInput("MouseMovement", 10, 0))
	eq(sl:get(), 108, "drag end stops tracking")
	check(#fired >= 3, "slider fired during drag")
	local box = findChild(sl.root, "Value")
	check(string.find(box.Text, "px", 1, true) ~= nil, "value box shows unit")
	box.Text = "120 px"
	box.FocusLost:Fire(true)
	eq(sl:get(), 120, "box commit strips unit")
	box.Text = "junk"
	box.FocusLost:Fire(true)
	eq(sl:get(), 120, "invalid box input reverts")
	sl:enable(false)
	grab.InputBegan:Fire(Mock.mouseInput("MouseButton1", 10, 0))
	eq(sl:get(), 120, "disabled blocks drag")
	sl:enable(true)
	sl:_refresh()
	sl:destroy()
end

-- ============================================================================
section("Widgets: Dropdown")
-- ============================================================================

do
	local host, overlay = freshRoot()
	-- Single.
	local fired: { any } = {}
	local dd = Widgets.Dropdown({
		label = "Style", options = { "Corner", "Outline", "Filled3D" }, value = "Corner",
		overlay = overlay, onChanged = function(v) table.insert(fired, v) end,
	}, host)
	local btn = findChild(dd.root, "Button")
	btn.AbsolutePosition = Mock.Vector2.new(10, 10)
	btn.AbsoluteSize = Mock.Vector2.new(180, 26)
	btn.MouseButton1Click:Fire()
	local popup = overlay:FindFirstChild("DropdownPopup")
	check(popup ~= nil, "single opens")
	local card = popup:FindFirstChild("Card")
	check(card.ZIndex >= 200, "popup above content")
	local list = card:FindFirstChild("List")
	local target: any = nil
	for _, ch in ipairs(list:GetChildren()) do
		if ch.ClassName == "TextButton" then
			target = ch -- last == Filled3D
		end
	end
	target.MouseButton1Click:Fire()
	eq(dd:get(), "Filled3D", "single select sets value")
	eq(#fired, 1, "single select fires once")
	check(overlay:FindFirstChild("DropdownPopup") == nil, "single closes after select")
	dd:set("Bogus")
	eq(dd:get(), "Filled3D", "unknown option ignored")
	dd:set("Outline")
	eq(dd:get(), "Outline", "set applies silently")
	eq(#fired, 1, "set does not fire")
	-- Escape + outside click.
	btn.MouseButton1Click:Fire()
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("Escape"))
	check(overlay:FindFirstChild("DropdownPopup") == nil, "escape closes")
	btn.MouseButton1Click:Fire()
	overlay:FindFirstChild("DropdownPopup"):FindFirstChild("Closer").MouseButton1Click:Fire()
	check(overlay:FindFirstChild("DropdownPopup") == nil, "outside click closes")
	-- Upward flip near the viewport bottom.
	btn.AbsolutePosition = Mock.Vector2.new(10, 760)
	btn.MouseButton1Click:Fire()
	local card2 = overlay:FindFirstChild("DropdownPopup"):FindFirstChild("Card")
	check(card2.Position.Y.Offset < 760, "popup flips upward without room")
	dd:destroy()
	check(overlay:FindFirstChild("DropdownPopup") == nil, "destroy closes popup")

	-- Multi.
	local mfired: { any } = {}
	local md = Widgets.Dropdown({
		label = "Targets", options = { "A", "B", "C" }, multi = true, value = { "A" },
		minSelect = 1, maxSelect = 2, overlay = overlay,
		onChanged = function(v) table.insert(mfired, v) end,
	}, host)
	local mbtn = findChild(md.root, "Button")
	mbtn.AbsolutePosition = Mock.Vector2.new(10, 10)
	mbtn.AbsoluteSize = Mock.Vector2.new(180, 26)
	mbtn.MouseButton1Click:Fire()
	local mlist = overlay:FindFirstChild("DropdownPopup"):FindFirstChild("Card"):FindFirstChild("List")
	local opts: { any } = {}
	for _, ch in ipairs(mlist:GetChildren()) do
		if ch.ClassName == "TextButton" then
			table.insert(opts, ch)
		end
	end
	eq(#opts, 3, "multi renders all options")
	opts[2].MouseButton1Click:Fire() -- select B
	eq(#md:get(), 2, "multi selects second")
	opts[3].MouseButton1Click:Fire() -- C would exceed maxSelect=2
	eq(#md:get(), 2, "maxSelect enforced")
	opts[1].MouseButton1Click:Fire() -- deselect A
	opts[2].MouseButton1Click:Fire() -- deselect B would break minSelect=1
	eq(#md:get(), 1, "minSelect enforced")
	check(overlay:FindFirstChild("DropdownPopup") ~= nil, "multi stays open")
	-- Footer All / None.
	local footer = overlay:FindFirstChild("DropdownPopup"):FindFirstChild("Card"):FindFirstChild("Footer")
	local allBtn, noneBtn: any, any = nil, nil
	for _, ch in ipairs(footer:GetChildren()) do
		if ch.Text == "All" then allBtn = ch end
		if ch.Text == "None" then noneBtn = ch end
	end
	allBtn.MouseButton1Click:Fire()
	eq(#md:get(), 2, "All respects maxSelect")
	noneBtn.MouseButton1Click:Fire()
	eq(#md:get(), 0, "None clears (store may still reject)")
	check(#mfired >= 3, "multi fired on changes")
	md:destroy()

	-- Search filter on long lists.
	local many: { string } = {}
	for i = 1, 12 do table.insert(many, "Opt" .. i) end
	local sd = Widgets.Dropdown({ label = "S", options = many, value = "Opt1", overlay = overlay }, host)
	local sbtn = findChild(sd.root, "Button")
	sbtn.AbsolutePosition = Mock.Vector2.new(10, 10)
	sbtn.AbsoluteSize = Mock.Vector2.new(180, 26)
	sbtn.MouseButton1Click:Fire()
	local scard = overlay:FindFirstChild("DropdownPopup"):FindFirstChild("Card")
	local filter = scard:FindFirstChild("Filter")
	check(filter ~= nil, "filter box appears on long lists")
	filter.Text = "Opt11"
	local slist = scard:FindFirstChild("List")
	local shown = 0
	for _, ch in ipairs(slist:GetChildren()) do
		if ch.ClassName == "TextButton" then shown += 1 end
	end
	eq(shown, 1, "filter narrows options")
	filter.Text = "zzz"
	check(scard:FindFirstChild("Empty").Visible, "no-match state shows")
	sd:destroy()
end

-- ============================================================================
section("Widgets: Keybind / Textbox / Buttons / Misc")
-- ============================================================================

do
	local host, _ = freshRoot()
	-- Keybind.
	local kfired: { any } = {}
	local kb = Widgets.Keybind({ label = "Toggle", value = "None",
		onChanged = function(v) table.insert(kfired, v) end }, host)
	local kbtn = findChild(kb.root, "Button")
	kbtn.MouseButton1Click:Fire()
	check(kb:isListening(), "listening after click")
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("F5"), false)
	eq(kb:get(), "F5", "captures key")
	kbtn.MouseButton1Click:Fire()
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("G"), true) -- gameProcessed
	check(kb:isListening(), "game-processed input ignored")
	Mock.UserInputService.InputBegan:Fire(Mock.mouseInput("MouseButton2", 0, 0), false)
	eq(kb:get(), "MouseButton2", "captures mouse when allowed")
	local kb2 = Widgets.Keybind({ label = "NoMouse", value = "None", allowMouse = false }, host)
	findChild(kb2.root, "Button").MouseButton1Click:Fire()
	Mock.UserInputService.InputBegan:Fire(Mock.mouseInput("MouseButton1", 0, 0), false)
	check(kb2:isListening() and kb2:get() == "None", "mouse ignored when disallowed")
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("Escape"), false)
	kb:destroy()
	kb2:destroy()

	-- Textbox commit modes.
	local committed: { any } = {}
	local tb = Widgets.Textbox({ label = "Name", commitOn = "enter",
		onCommit = function(v) table.insert(committed, v) end }, host)
	local box = findChild(tb.root, "Box")
	box.Text = "hi"
	box.FocusLost:Fire(false)
	eq(#committed, 0, "enter-mode ignores click-away")
	box.FocusLost:Fire(true)
	eq(#committed, 1, "enter-mode commits on enter")
	tb:enable(false)
	check(box.TextEditable == false, "disabled locks editing")
	tb:destroy()

	-- Button.
	local clicks = 0
	local b = Widgets.Button({ text = "Go", onClick = function() clicks += 1 end }, host)
	local bbtn = findChild(b.root, "Button")
	bbtn.MouseButton1Click:Fire()
	eq(clicks, 1, "button click")
	bbtn.MouseEnter:Fire()
	bbtn.MouseLeave:Fire()
	b:setText("Go!")
	eq(bbtn.Text, "Go!", "setText")
	b:enable(false)
	bbtn.MouseButton1Click:Fire()
	eq(clicks, 1, "disabled button blocks")
	b:destroy()
	local bd = Widgets.Button({ text = "X", variant = "danger" }, host)
	bd:_refresh()
	bd:destroy()

	-- Label / Divider / Section / Searchbox.
	local lab = Widgets.Label({ text = "header" }, host)
	lab:setText("other")
	lab:_refresh()
	lab:destroy()
	local div = Widgets.Divider({}, host)
	div:_refresh()
	div:destroy()
	local toggles: { any } = {}
	local sec = Widgets.Section({ title = "S", hint = "h",
		onToggle = function(v) table.insert(toggles, v) end }, host)
	check(sec:isCollapsed() == false, "section starts expanded")
	findChild(sec.root, "Header").MouseButton1Click:Fire()
	check(sec:isCollapsed() and #toggles == 1, "section collapses")
	sec:setCollapsed(false)
	check(not sec:isCollapsed(), "setCollapsed expands")
	check(sec:content().Name == "Body", "content exposes body")
	sec:destroy()
	local sb = Widgets.Searchbox({}, host)
	local sbox = findChild(sb.root, "Box")
	sbox.Text = "query"
	eq(sb:get(), "query", "searchbox live value")
	check(findChild(sb.root, "Clear").Visible, "clear shows with text")
	findChild(sb.root, "Clear").MouseButton1Click:Fire()
	eq(sb:get(), "", "clear resets")
	sb:destroy()
end

-- ============================================================================
section("Widgets: ColorField")
-- ============================================================================

do
	local host, overlay = freshRoot()
	local fired: { any } = {}
	local cf = Widgets.ColorField({
		label = "Enemy", value = { h = 0, s = 1, v = 1, a = 1 },
		picker = ColorPicker, overlay = overlay,
		onChanged = function(v) table.insert(fired, v) end,
	}, host)
	local sw = findChild(cf.root, "Swatch")
	sw.AbsolutePosition = Mock.Vector2.new(600, 100)
	sw.AbsoluteSize = Mock.Vector2.new(56, 22)
	local hex = findChild(cf.root, "Hex")
	eq(hex.Text, "#FF0000", "hex renders from HSV")
	sw.MouseButton1Click:Fire()
	check(cf:isOpen(), "swatch opens picker")
	sw.MouseButton1Click:Fire()
	check(not cf:isOpen(), "swatch toggles closed")
	cf:set({ h = 0.5, s = 1, v = 1, a = 0.5 })
	eq(hex.Text, "#00FFFF 50%", "alpha suffix renders")
	eq(#fired, 0, "color set is silent")
	cf:destroy()
	check(overlay:FindFirstChild("ColorPopup") == nil, "destroy closes picker")
end

-- ============================================================================
section("ColorPicker")
-- ============================================================================

do
	local _, overlay = freshRoot()
	local changed: { any } = {}
	local committed: { any } = {}
	local closed = 0
	local pk = ColorPicker.new({
		value = { h = 0, s = 1, v = 1, a = 1 },
		overlay = overlay,
		onChanged = function(v) table.insert(changed, v) end,
		onCommit = function(v) table.insert(committed, v) end,
		onClose = function() closed += 1 end,
	})
	pk:set({ h = 0.25, s = 1, v = 1, a = 1 })
	approx(pk:get().h, 0.25, 1e-9, "pre-open set stages value")
	pk:open()
	check(pk:isOpen(), "opens")
	local card = overlay:FindFirstChild("ColorPopup"):FindFirstChild("Card")
	local sv = card:FindFirstChild("SV")
	sv.AbsolutePosition = Mock.Vector2.new(0, 0)
	sv.AbsoluteSize = Mock.Vector2.new(248, 150)
	local function grabOf(box: any, name: string): any
		for _, ch in ipairs(box:GetChildren()) do
			if ch.Name == name then return ch end
		end
		return nil
	end
	-- SV corners.
	grabOf(sv, "SVGrab").InputBegan:Fire(Mock.mouseInput("MouseButton1", 0, 0))
	local v = pk:get()
	approx(v.s, 0, 1e-9, "SV top-left s=0")
	approx(v.v, 1, 1e-9, "SV top-left v=1")
	Mock.UserInputService.InputChanged:Fire(Mock.mouseInput("MouseMovement", 248, 150))
	v = pk:get()
	approx(v.s, 1, 1e-9, "SV bottom-right s=1")
	approx(v.v, 0, 1e-9, "SV bottom-right v=0")
	Mock.UserInputService.InputEnded:Fire(Mock.mouseInput("MouseButton1", 248, 150))
	eq(#committed, 1, "drag release commits")
	check(#changed >= 2, "drags fire live")
	-- Hue strip.
	local hue = card:FindFirstChild("Hue")
	hue.AbsolutePosition = Mock.Vector2.new(0, 0)
	hue.AbsoluteSize = Mock.Vector2.new(248, 14)
	grabOf(hue, "HueGrab").InputBegan:Fire(Mock.mouseInput("MouseButton1", 62, 0))
	Mock.UserInputService.InputEnded:Fire(Mock.mouseInput("MouseButton1", 62, 0))
	approx(pk:get().h, 0.25, 1e-6, "hue drag sets value")
	-- Alpha strip.
	local alpha: any = nil
	for _, ch in ipairs(card:GetChildren()) do
		if ch.Name == "Alpha" then alpha = ch end
	end
	alpha.AbsolutePosition = Mock.Vector2.new(0, 0)
	alpha.AbsoluteSize = Mock.Vector2.new(248, 14)
	grabOf(alpha, "AlphaGrab").InputBegan:Fire(Mock.mouseInput("MouseButton1", 124, 0))
	Mock.UserInputService.InputEnded:Fire(Mock.mouseInput("MouseButton1", 124, 0))
	approx(pk:get().a, 0.5, 1e-6, "alpha drag sets value")
	-- Hex commit.
	local hexBox = card:FindFirstChild("Hex")
	hexBox.Text = "#00FF00"
	hexBox.FocusLost:Fire(true)
	v = pk:get()
	approx(v.h, 1 / 3, 1e-3, "hex commit sets hue")
	approx(v.s, 1, 1e-3, "hex commit sets saturation")
	hexBox.Text = "not-a-color"
	hexBox.FocusLost:Fire(true)
	eq(hexBox.Text:sub(1, 7), "#00FF00", "invalid hex reverts")
	-- Palette.
	local swatches: { any } = {}
	for _, ch in ipairs(card:GetChildren()) do
		if ch.Name == "PaletteSwatch" then table.insert(swatches, ch) end
	end
	check(#swatches == 24, "four palette rows render (" .. #swatches .. ")")
	swatches[1].MouseButton1Click:Fire()
	check(#committed >= 4, "palette click commits")
	-- Close paths.
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("Escape"))
	check(not pk:isOpen() and closed == 1, "escape closes + onClose")
	pk:open()
	overlay:FindFirstChild("ColorPopup"):FindFirstChild("Closer").MouseButton1Click:Fire()
	check(not pk:isOpen() and closed == 2, "outside click closes")
	pk:destroy()
end

-- ============================================================================
section("Panel")
-- ============================================================================

do
	local host, overlay = freshRoot()
	local notes: { string } = {}
	local store = Store.new()
	local panel = Panel.new({
		store = store,
		overlay = overlay,
		notify = function(m) table.insert(notes, m) end,
	}, host)
	-- Handle coverage.
	local handleCount = 0
	for _ in pairs(panel.handles) do handleCount += 1 end
	eq(handleCount, #Schema.FIELDS, "one handle per field")
	-- Widget -> store.
	panel.handles["esp.enabled"]:toggle()
	eq(store:get("esp.enabled"), true, "toggle writes to store")
	panel.handles["esp.maxDistance"]:set(500)
	eq(store:get("esp.maxDistance"), 1500, "handle:set alone stays silent")
	-- Store -> widget.
	store:set("esp.maxDistance", 500)
	eq(panel.handles["esp.maxDistance"]:get(), 500, "store pushes to widget")
	-- Undo pushes back.
	store:undo()
	eq(panel.handles["esp.maxDistance"]:get(), 1500, "undo pushes to widget")
	-- Group children follow the master toggle.
	local styleBtn = findChild(panel.handles["esp.boxes.style"].root, "Button")
	eq(styleBtn.BackgroundTransparency, 0.5, "children dimmed while master off")
	store:set("esp.boxes.enabled", true)
	eq(styleBtn.BackgroundTransparency, 0, "children enable with master")
	-- Master toggle through the UI also rewires children.
	panel.handles["esp.boxes.enabled"]:toggle() -- back off
	eq(styleBtn.BackgroundTransparency, 0.5, "UI master toggle dims children")
	-- Profile dropdown applies a whole preset (real UI path).
	store:set("esp.enabled", false) -- ensure Rage flips a real change
	local prof = panel.handles["config.profile"]
	local pbtn = findChild(prof.root, "Button")
	pbtn.AbsolutePosition = Mock.Vector2.new(10, 10)
	pbtn.AbsoluteSize = Mock.Vector2.new(180, 26)
	pbtn.MouseButton1Click:Fire()
	local plist = overlay:FindFirstChild("DropdownPopup"):FindFirstChild("Card"):FindFirstChild("List")
	for _, ch in ipairs(plist:GetChildren()) do
		if ch.ClassName == "TextButton" then
			-- find the row whose label reads "Rage"
			for _, gch in ipairs(ch:GetChildren()) do
				if gch.ClassName == "TextLabel" and gch.Text == "Rage" then
					ch.MouseButton1Click:Fire()
				end
			end
		end
	end
	eq(store:get("config.profile"), "Rage", "profile dropdown applies preset")
	eq(store:get("esp.enabled"), true, "rage enables esp")
	check(#notes >= 1 and string.find(notes[#notes], "Rage", 1, true) ~= nil, "profile notifies")
	store:undo()
	eq(store:get("esp.enabled"), false, "profile applies in one undo step")
	-- Rejected multi-select restores + notifies.
	local targets = panel.handles["esp.targets"]
	local tbtn = findChild(targets.root, "Button")
	tbtn.AbsolutePosition = Mock.Vector2.new(10, 10)
	tbtn.AbsoluteSize = Mock.Vector2.new(180, 26)
	tbtn.MouseButton1Click:Fire()
	local tcard = overlay:FindFirstChild("DropdownPopup"):FindFirstChild("Card")
	local tfooter = tcard:FindFirstChild("Footer")
	for _, ch in ipairs(tfooter:GetChildren()) do
		if ch.Text == "None" then ch.MouseButton1Click:Fire() end
	end
	eq(#store:get("esp.targets"), 1, "rejected write keeps store value")
	eq(#targets:get(), 1, "rejected write pushes value back")
	check(string.find(notes[#notes], "Couldn't apply", 1, true) ~= nil, "rejection notifies")
	-- Group collapse.
	local groupCard: any = nil
	for _, ch in ipairs(panel.root:GetDescendants()) do
		if ch.Name == "Group_esp.boxes" then groupCard = ch end
	end
	check(groupCard ~= nil, "group card exists")
	local kids = groupCard:FindFirstChild("Children")
	findChild(groupCard, "Header").MouseButton1Click:Fire()
	check(not kids.Visible, "group collapses")
	-- Search.
	panel:search("chams rainbow")
	panel:flushSearch()
	local rainbowRow = panel.handles["chams.rainbow"].root
	check(rainbowRow.Visible, "search shows match")
	check(not panel.handles["esp.enabled"].root.Visible, "search hides non-match")
	panel:search("zzz-no-such-setting")
	panel:flushSearch()
	local emptyShown = false
	for _, ch in ipairs(panel.root:GetDescendants()) do
		if ch.Name == "EmptyState" and ch.Visible then emptyShown = true end
	end
	check(emptyShown, "empty state on no match")
	panel:search("")
	panel:flushSearch()
	check(panel.handles["esp.enabled"].root.Visible, "clearing search restores")
	-- Tooltips.
	panel:setTooltips(false)
	check(not findChild(panel.handles["esp.enabled"].root, "Desc").Visible, "tooltips hide descriptions")
	panel:setTooltips(true)
	-- Config extras.
	store:set("esp.enabled", true)
	panel._resetBtn.root:FindFirstChild("Button").MouseButton1Click:Fire()
	eq(store:get("esp.enabled"), false, "reset restores defaults")
	panel._copyBtn.root:FindFirstChild("Button").MouseButton1Click:Fire()
	check(string.find(panel._importBox:get(), "esp.enabled", 1, true) ~= nil, "copy fills JSON box")
	local json = Mock.HttpService:JSONEncode({ ["esp.enabled"] = true })
	panel._importBox:set(json)
	panel._importBtn.root:FindFirstChild("Button").MouseButton1Click:Fire()
	eq(store:get("esp.enabled"), true, "import applies JSON")
	panel._importBox:set("{oops")
	panel._importBtn.root:FindFirstChild("Button").MouseButton1Click:Fire()
	check(string.find(notes[#notes], "not valid JSON", 1, true) ~= nil, "bad JSON notifies")
	-- Theme refresh across the whole tree.
	Theme.setToken("accent", "#00FF00")
	panel:refreshTheme()
	Theme.setToken("accent", nil)
	panel:refreshTheme()
	panel:destroy()
	check(panel.root.Parent == nil, "panel destroy detaches")
end

-- ============================================================================
section("Window")
-- ============================================================================

do
	local _, _ = freshRoot()
	local toggles: { any } = {}
	local win = Window.new({ parent = Mock.CoreGui, title = "T", onToggle = function(v)
		table.insert(toggles, v)
	end })
	local page = win:addTab("Visuals")
	check(page.Name == "Page_Visuals", "addTab returns page")
	eq(win:activeTabName(), "Visuals", "first tab auto-active")
	local page2 = win:addTab("Other")
	win:setTab("Other")
	check(page2.Visible and not page.Visible, "tab switch flips pages")
	local dupOk = pcall(function() win:addTab("Other") end)
	check(not dupOk, "duplicate tab asserts")
	local unkOk = pcall(function() win:setTab("Nope") end)
	check(not unkOk, "unknown tab asserts")
	win:setTab("Visuals")

	local gui = win.root
	local root = findChild(gui, "Root")
	root.AbsoluteSize = Mock.Vector2.new(1280, 800)
	local card = findChild(root, "Card")
	card.AbsolutePosition = Mock.Vector2.new(100, 100)
	card.AbsoluteSize = Mock.Vector2.new(640, 620)
	-- Drag.
	local bar = findChild(card, "TitleBar")
	bar.InputBegan:Fire(Mock.mouseInput("MouseButton1", 200, 200))
	Mock.UserInputService.InputChanged:Fire(Mock.mouseInput("MouseMovement", 250, 230))
	eq(card.Position.X.Offset, 470, "drag moves card X")
	eq(card.Position.Y.Offset, 440, "drag moves card Y")
	Mock.UserInputService.InputEnded:Fire(Mock.mouseInput("MouseButton1", 250, 230))
	Mock.UserInputService.InputChanged:Fire(Mock.mouseInput("MouseMovement", 0, 0))
	eq(card.Position.X.Offset, 470, "drag end stops tracking")
	-- Resize (+ clamps).
	local grip = findChild(card, "ResizeGrip")
	card.AbsoluteSize = Mock.Vector2.new(640, 620)
	grip.InputBegan:Fire(Mock.mouseInput("MouseButton1", 740, 720))
	Mock.UserInputService.InputChanged:Fire(Mock.mouseInput("MouseMovement", 2000, 2000))
	eq(card.Size.X.Offset, 860, "resize clamps wide")
	eq(card.Size.Y.Offset, 920, "resize clamps tall")
	Mock.UserInputService.InputChanged:Fire(Mock.mouseInput("MouseMovement", 0, 0))
	eq(card.Size.X.Offset, 480, "resize clamps narrow")
	Mock.UserInputService.InputEnded:Fire(Mock.mouseInput("MouseButton1", 0, 0))
	-- Minimize / close / toggle.
	findChild(bar, "Minimize").MouseButton1Click:Fire()
	check(not findChild(card, "Body").Visible, "minimize hides body")
	findChild(bar, "Minimize").MouseButton1Click:Fire()
	check(findChild(card, "Body").Visible, "minimize restores")
	findChild(bar, "Close").MouseButton1Click:Fire()
	check(not win:isVisible(), "close hides")
	win:toggle()
	check(win:isVisible(), "toggle shows")
	eq(#toggles, 2, "onToggle fired")
	-- Scale.
	win:setScale(1.2)
	approx(win:getScale(), 1.2, 1e-9, "scale applies")
	win:setScale(9)
	eq(win:getScale(), 2, "scale clamps")
	-- Toasts (capped at 4).
	for i = 1, 5 do win:notify("toast " .. i) end
	local toastCount = 0
	for _, ch in ipairs(win.overlay:FindFirstChild("Toasts"):GetChildren()) do
		if ch:IsA("Frame") then toastCount += 1 end
	end
	eq(toastCount, 4, "toast stack capped")
	sched.pump()
	local toastCountAfter = 0
	for _, ch in ipairs(win.overlay:FindFirstChild("Toasts"):GetChildren()) do
		if ch:IsA("Frame") then toastCountAfter += 1 end
	end
	eq(toastCountAfter, 0, "toasts auto-dismiss")
	-- Theme repaint.
	Theme.setToken("accent", "#FF0000")
	win:applyTheme()
	local logo = findChild(bar, "Logo")
	eq(logo.BackgroundColor3.R, 1, "applyTheme repaints chrome")
	Theme.setToken("accent", nil)
	win:applyTheme()
	win:destroy()
	check(gui.Parent == nil, "window destroy detaches")

	-- Standalone toggle key.
	local win2 = Window.new({ parent = Mock.CoreGui, toggleKey = "F6" })
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("F6"), false)
	check(not win2:isVisible(), "toggleKey hides")
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("F6"), false)
	check(win2:isVisible(), "toggleKey shows")
	Mock._setFocusedTextBox(Mock.Instance.new("TextBox"))
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("F6"), false)
	check(win2:isVisible(), "toggleKey ignores typing")
	Mock._setFocusedTextBox(nil)
	win2:destroy()
end

-- ============================================================================
section("Init (integration)")
-- ============================================================================

do
	local _, _ = freshRoot()
	local app = PRISM.new({})
	check(_G.__PRISM_APP == app, "app registered globally")
	eq(app.version, "1.0.0", "version stamped")
	eq(app.window:activeTabName(), "Visuals", "single Visuals tab")
	local tabs = 0
	for _, ch in ipairs(app.window.root:GetDescendants()) do
		if string.sub(ch.Name, 1, 4) == "Tab_" then tabs += 1 end
	end
	eq(tabs, 1, "exactly one tab button")
	local handleCount = 0
	for _ in pairs(app.panel.handles) do handleCount += 1 end
	eq(handleCount, #Schema.FIELDS, "panel covers schema")

	-- Hotkeys.
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("RightShift"), false)
	check(not app.window:isVisible(), "toggleUI hotkey hides")
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("RightShift"), false)
	check(app.window:isVisible(), "toggleUI hotkey shows")
	app.store:set("keys.toggleESP", "F5")
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("F5"), false)
	eq(app.store:get("esp.enabled"), true, "toggleESP flips on")
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("F5"), false)
	eq(app.store:get("esp.enabled"), false, "toggleESP flips off")
	app.store:set("keys.panic", "P")
	app.store:set("esp.enabled", true)
	app.store:set("chams.enabled", true)
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("P"), false)
	check(app.store:get("esp.enabled") == false and app.store:get("chams.enabled") == false, "panic kills visuals")
	check(not app.window:isVisible(), "panic hides UI")
	app.window:setVisible(true)
	Mock._setFocusedTextBox(Mock.Instance.new("TextBox"))
	Mock.UserInputService.InputBegan:Fire(Mock.keyInput("RightShift"), false)
	check(app.window:isVisible(), "hotkeys ignore typing")
	Mock._setFocusedTextBox(nil)

	-- Accent / scale / tooltips follow the store.
	app.store:set("colors.accent", { h = 0, s = 1, v = 1, a = 1 })
	eq(Theme.get("accent"), "#FF0000", "accent syncs theme token")
	Theme.setPreset("Midnight") -- restore (clears overrides)
	app.store:set("config.uiScale", 1.2)
	approx(app.window:getScale(), 1.2, 1e-9, "uiScale follows store")
	app.store:set("config.tooltips", false)
	check(not findChild(app.panel.handles["esp.enabled"].root, "Desc").Visible, "tooltips follow store")
	app.store:set("config.tooltips", true)

	-- Re-execution replaces the app.
	local guiCountBefore = #Mock.CoreGui:GetChildren()
	local app2 = PRISM.new({})
	eq(#Mock.CoreGui:GetChildren(), guiCountBefore, "re-exec keeps one gui")
	check(_G.__PRISM_APP == app2, "global points at new app")
	app:destroy()
	app2:destroy()
	check(_G.__PRISM_APP == nil, "destroy clears global")
end

-- ============================================================================
section("Init (persistence)")
-- ============================================================================

do
	local _, _ = freshRoot()
	local fs: { [string]: string } = {}
	local G: any = _G
	G.writefile = function(path: string, content: string) fs[path] = content end
	G.readfile = function(path: string) return fs[path] end
	G.isfile = function(path: string) return fs[path] ~= nil end
	G.makefolder = function(_path: string) end

	local app = PRISM.new({ saveFolder = "prism-test", saveFile = "c.json" })
	app.store:set("esp.enabled", true)
	app.store:set("esp.maxDistance", 500)
	check(app:save(), "save writes disk")
	check(fs["prism-test/c.json"] ~= nil, "save file exists")
	check(string.find(fs["prism-test/c.json"], "esp.enabled", 1, true) ~= nil, "save contains state")
	-- Autosave path (debounced): write without :save().
	app.store:set("esp.teamCheck", false)
	app.store:flushAutosave()
	check(string.find(fs["prism-test/c.json"], "teamCheck", 1, true) ~= nil, "autosave writes disk")
	app:destroy()

	-- Disk state wins on boot.
	local app2 = PRISM.new({ saveFolder = "prism-test", saveFile = "c.json" })
	eq(app2.store:get("esp.enabled"), true, "boot loads disk state")
	eq(app2.store:get("esp.maxDistance"), 500, "boot loads disk values")
	app2:destroy()

	-- Corrupt save -> clean defaults, no crash.
	fs["prism-test/c.json"] = "{oops"
	local app3 = PRISM.new({ saveFolder = "prism-test", saveFile = "c.json" })
	eq(app3.store:get("esp.enabled"), false, "corrupt save falls back")
	app3:destroy()

	G.writefile = nil
	G.readfile = nil
	G.isfile = nil
	G.makefolder = nil
	local app4 = PRISM.new({})
	check(not app4:save(), "session-only save reports false")
	app4:destroy()
	Theme.setPreset("Midnight")
end

-- ============================================================================
sched.uninstall()
print(string.format("\n==== ui: %d passed, %d failed ====", passCount, failCount))
if failCount > 0 then
	print("Failures:")
	for _, f in failures do
		print("  " .. f)
	end
	error(failCount .. " ui test(s) failed", 0)
end
