--!strict
-- ============================================================================
--  PRISM-UI · test doubles ("mock")
-- ----------------------------------------------------------------------------
--  A strict, headless stand-in for the Roblox engine: Instance tree, value
--  types (UDim2/Vector2/Color3/sequences), Enum, TweenService, UserInputService,
--  Players/mouse, HttpService (with a minimal JSON codec) and a fake task
--  scheduler with virtual time.
--
--  STRICTNESS IS THE POINT: unknown classes, services and enum members raise
--  errors, so typos in src/ fail loudly here instead of silently in-game.
--  Anything the library must NOT use (WaitForChild, :Wait(), TextService,
--  attributes, Clone) is deliberately absent.
--
--  Usage:  local Mock = require("mock"); Mock.install()
-- ============================================================================

local Mock = {}

-- ---------------------------------------------------------------------------
-- Tiny event (mirrors the RBXScriptSignal surface the library uses)
-- ---------------------------------------------------------------------------

local function makeEvent()
	local conns: { { fn: (...any) -> (), active: boolean } } = {}
	local ev: any = {}
	function ev.Connect(_s: any, fn: (...any) -> ()): any
		assert(type(fn) == "function", "mock: Connect expects a function")
		local rec = { fn = fn, active = true }
		table.insert(conns, rec)
		local conn: any = {}
		conn.Connected = true
		function conn.Disconnect(_c: any)
			conn.Connected = false
			rec.active = false
		end
		return conn
	end
	function ev.Once(_s: any, fn: (...any) -> ()): any
		local conn: any = nil
		conn = ev.Connect(ev, function(...: any)
			conn:Disconnect()
			fn(...)
		end)
		return conn
	end
	-- Test driver: invoke every connected handler.
	function ev.Fire(_s: any, ...: any)
		local snap = {}
		for i = 1, #conns do snap[i] = conns[i] end
		for _, rec in snap do
			if rec.active then
				rec.fn(...)
			end
		end
	end
	function ev._count(): number
		local n = 0
		for _, rec in conns do
			if rec.active then n += 1 end
		end
		return n
	end
	return ev
end

-- ---------------------------------------------------------------------------
-- Enum (explicit allowlist; unknown members error)
-- ---------------------------------------------------------------------------

local ENUMS: { [string]: { string } } = {
	Font = { "Gotham", "GothamMedium", "GothamBold", "GothamBlack", "Code", "BuilderSans" },
	TextXAlignment = { "Left", "Center", "Right" },
	TextYAlignment = { "Top", "Center", "Bottom" },
	TextTruncate = { "AtEnd" },
	SortOrder = { "LayoutOrder", "Name" },
	FillDirection = { "Horizontal", "Vertical" },
	VerticalAlignment = { "Top", "Center", "Bottom" },
	HorizontalAlignment = { "Left", "Center", "Right" },
	UserInputType = { "MouseButton1", "MouseButton2", "MouseButton3", "MouseMovement", "MouseWheel", "Touch", "Keyboard", "Gamepad1" },
	EasingStyle = { "Linear", "Quad", "Cubic", "Quart", "Quint", "Sine", "Expo", "Circ", "Back", "Bounce", "Elastic" },
	EasingDirection = { "In", "Out", "InOut" },
	ScaleType = { "Stretch", "Slice", "Crop", "Fit" },
	ZIndexBehavior = { "Sibling", "Global" },
	ScrollingDirection = { "X", "Y", "XY" },
	ScrollBarInset = { "None", "ScrollBar" },
	ApplyStrokeMode = { "Contextual", "Always" },
	LineJoinMode = { "Round", "Mitre", "Bevel" },
	AutomaticSize = { "None", "X", "Y", "XY" },
	AspectType = { "FitWithinMaxSize", "ScaleWithParentSize" },
	KeyCode = {}, -- filled below
}

do
	local keys: { string } = {}
	for c = string.byte("A"), string.byte("Z") do table.insert(keys, string.char(c)) end
	for c = string.byte("0"), string.byte("9") do table.insert(keys, "Num" .. string.char(c)) end
	local named = {
		"Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
		"F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
		"Space", "Tab", "Backspace", "Enter", "Escape", "Delete", "Insert",
		"Home", "End", "PageUp", "PageDown", "Left", "Right", "Up", "Down",
		"LeftShift", "RightShift", "LeftControl", "RightControl", "LeftAlt", "RightAlt",
		"CapsLock", "Unknown",
	}
	for _, k in named do table.insert(keys, k) end
	ENUMS.KeyCode = keys
end

local EnumRoot: any = {}
for enumName, members in ENUMS do
	local items: any = {}
	for i, member in members do
		items[member] = { Name = member, Value = i, EnumType = enumName }
	end
	local proxy: any = {}
	setmetatable(proxy, {
		__index = function(_t: any, k: any)
			local v = items[k]
			if v == nil then
				error("Mock: unknown Enum." .. enumName .. "." .. tostring(k), 2)
			end
			return v
		end,
		__newindex = function() error("Mock: Enum is read-only", 2) end,
	})
	EnumRoot[enumName] = proxy
end
setmetatable(EnumRoot, {
	__index = function(_t: any, k: any)
		error("Mock: unknown Enum." .. tostring(k), 2)
	end,
	__newindex = function() error("Mock: Enum is read-only", 2) end,
})
Mock.Enum = EnumRoot

-- ---------------------------------------------------------------------------
-- UDim / UDim2 / Vector2
-- ---------------------------------------------------------------------------

local UDim: any = {}
function UDim.new(scale: number, offset: number)
	return { Scale = scale, Offset = offset }
end
Mock.UDim = UDim

local UDim2: any = {}
function UDim2.new(sx: number, ox: number, sy: number, oy: number)
	return { X = UDim.new(sx, ox), Y = UDim.new(sy, oy) }
end
function UDim2.fromScale(sx: number, sy: number)
	return UDim2.new(sx, 0, sy, 0)
end
function UDim2.fromOffset(ox: number, oy: number)
	return UDim2.new(0, ox, 0, oy)
end
Mock.UDim2 = UDim2

local Vector2: any = {}
local vectorMt: any = {}
function vectorMt.__add(a: any, b: any) return Vector2.new(a.X + b.X, a.Y + b.Y) end
function vectorMt.__sub(a: any, b: any) return Vector2.new(a.X - b.X, a.Y - b.Y) end
function Vector2.new(x: number, y: number)
	local v: any = { X = x, Y = y }
	v.Magnitude = math.sqrt(x * x + y * y)
	setmetatable(v, vectorMt)
	return v
end
Vector2.zero = Vector2.new(0, 0)
Vector2.one = Vector2.new(1, 1)
Mock.Vector2 = Vector2

-- ---------------------------------------------------------------------------
-- Color3 (independent conversions; the mock never requires src/)
-- ---------------------------------------------------------------------------

local Color3: any = {}
function Color3.new(r: number, g: number, b: number)
	local c: any = { R = r, G = g, B = b }
	function c.ToHSV(_s: any)
		local mx = math.max(r, g, b)
		local mn = math.min(r, g, b)
		local d = mx - mn
		local h, s = 0, 0
		if d > 1e-9 then
			s = d / mx
			if mx == r then h = ((g - b) / d) % 6
			elseif mx == g then h = (b - r) / d + 2
			else h = (r - g) / d + 4 end
			h /= 6
			if h < 0 then h += 1 end
		end
		return h, s, mx
	end
	function c.Lerp(_s: any, goal: any, t: number)
		return Color3.new(r + (goal.R - r) * t, g + (goal.G - g) * t, b + (goal.B - b) * t)
	end
	return c
end
function Color3.fromRGB(r: number, g: number, b: number)
	return Color3.new(r / 255, g / 255, b / 255)
end
function Color3.fromHSV(h: number, s: number, v: number)
	h = h % 1
	if s <= 0 then return Color3.new(v, v, v) end
	local sector = h * 6
	local i = math.floor(sector)
	local f = sector - i
	local p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
	local m = i % 6
	if m == 0 then return Color3.new(v, t, p)
	elseif m == 1 then return Color3.new(q, v, p)
	elseif m == 2 then return Color3.new(p, v, t)
	elseif m == 3 then return Color3.new(p, q, v)
	elseif m == 4 then return Color3.new(t, p, v)
	else return Color3.new(v, p, q) end
end
Mock.Color3 = Color3

-- ---------------------------------------------------------------------------
-- Sequences + TweenInfo
-- ---------------------------------------------------------------------------

local ColorSequenceKeypoint: any = {}
function ColorSequenceKeypoint.new(t: number, color: any)
	return { Time = t, Value = color }
end
local ColorSequence: any = {}
function ColorSequence.new(kps: any)
	return { Keypoints = kps }
end
local NumberSequenceKeypoint: any = {}
function NumberSequenceKeypoint.new(t: number, v: number, env: number?)
	return { Time = t, Value = v, Envelope = env or 0 }
end
local NumberSequence: any = {}
function NumberSequence.new(kps: any)
	return { Keypoints = kps }
end
local TweenInfo: any = {}
function TweenInfo.new(time: number?, style: any?, dir: any?, rep: number?, rev: boolean?, delay: number?)
	return {
		Time = time or 1,
		EasingStyle = style,
		EasingDirection = dir,
		RepeatCount = rep or 0,
		Reverses = rev or false,
		DelayTime = delay or 0,
	}
end
Mock.ColorSequenceKeypoint = ColorSequenceKeypoint
Mock.ColorSequence = ColorSequence
Mock.NumberSequenceKeypoint = NumberSequenceKeypoint
Mock.NumberSequence = NumberSequence
Mock.TweenInfo = TweenInfo

-- ---------------------------------------------------------------------------
-- Instance
-- ---------------------------------------------------------------------------

local KNOWN_CLASSES: { [string]: boolean } = {}
for _, class in {
	"Frame", "ScrollingFrame", "CanvasGroup", "TextLabel", "TextButton", "TextBox",
	"ImageLabel", "ImageButton", "ViewportFrame",
	"ScreenGui", "BillboardGui", "SurfaceGui",
	"UIListLayout", "UIGridLayout", "UIPadding", "UICorner", "UIStroke",
	"UIGradient", "UIScale", "UIAspectRatioConstraint", "UISizeConstraint",
	"Folder", "CoreGui", "PlayerGui", "Players", "StarterGui",
} do
	KNOWN_CLASSES[class] = true
end

-- class -> extra ancestors for IsA.
local ANCESTORS: { [string]: { string } } = {
	Frame = { "GuiObject" }, ScrollingFrame = { "GuiObject" }, CanvasGroup = { "GuiObject" },
	TextLabel = { "GuiObject" }, TextButton = { "GuiObject", "GuiButton" },
	TextBox = { "GuiObject" }, ImageLabel = { "GuiObject" }, ImageButton = { "GuiObject", "GuiButton" },
	ViewportFrame = { "GuiObject" },
	ScreenGui = { "LayerCollector" },
	UIListLayout = { "UIComponent" }, UIGridLayout = { "UIComponent" },
	UIPadding = { "GuiObject" }, UICorner = { "GuiObject" }, UIStroke = { "GuiObject" },
	UIGradient = { "GuiObject" }, UIScale = { "GuiObject" },
	Folder = {}, CoreGui = {}, PlayerGui = { "LayerCollector" }, Players = {}, StarterGui = {},
}

local BUTTON_EVENTS = { "MouseButton1Click", "MouseButton1Down", "MouseButton1Up", "Activated" }
local GUIOBJECT_EVENTS = { "InputBegan", "InputEnded", "MouseEnter", "MouseLeave" }
local TEXTBOX_EVENTS = { "Focused", "FocusLost" }
local SCROLL_EVENTS = { "CanvasPositionChanged" }

local instanceMt: any = {}
function instanceMt.__index(self: any, k: any)
	local store = rawget(self, "_store")
	if store.methods[k] ~= nil then return store.methods[k] end
	if store.events[k] ~= nil then return store.events[k] end
	if store.props[k] ~= nil then return store.props[k] end
	if store.defaults[k] ~= nil then return store.defaults[k] end
	return nil
end
function instanceMt.__newindex(self: any, k: any, v: any)
	local store = rawget(self, "_store")
	if k == "Parent" then
		store.methods._setParent(self, v)
		return
	end
	if store.methods[k] ~= nil or store.events[k] ~= nil then
		error("Mock: cannot assign to member '" .. tostring(k) .. "' of " .. store.class, 2)
	end
	store.props[k] = v
	local changed = store.events.Changed
	changed:Fire(k)
	local sig = store.propSignals[k]
	if sig ~= nil then
		sig:Fire()
	end
end

local function buildDefaults(class: string): { [string]: any }
	return {
		Name = class,
		Visible = true,
		Active = false,
		LayoutOrder = 0,
		ZIndex = 1,
		Rotation = 0,
		BackgroundTransparency = 0,
		BorderSizePixel = 0,
		ClipsDescendants = false,
		AnchorPoint = Vector2.new(0, 0),
		Position = UDim2.new(0, 0, 0, 0),
		Size = UDim2.new(0, 0, 0, 0),
		AbsolutePosition = Vector2.new(0, 0),
		AbsoluteSize = Vector2.new(100, 100),
		Text = "",
		Font = EnumRoot.Font.Gotham,
		TextSize = 14,
		TextXAlignment = EnumRoot.TextXAlignment.Center,
		TextYAlignment = EnumRoot.TextYAlignment.Center,
		TextTransparency = 0,
		TextTruncate = EnumRoot.TextTruncate.AtEnd,
		TextWrapped = false,
		TextScaled = false,
		AutoButtonColor = true,
		ClearTextOnFocus = true,
		MultiLine = false,
		PlaceholderText = "",
		Image = "",
		ImageTransparency = 0,
		ScaleType = EnumRoot.ScaleType.Stretch,
		CanvasSize = UDim2.new(0, 0, 0, 0),
		CanvasPosition = Vector2.new(0, 0),
		ScrollBarThickness = 12,
		ScrollingDirection = EnumRoot.ScrollingDirection.XY,
		ScrollBarImageTransparency = 0,
		CornerRadius = UDim.new(0, 0),
		Thickness = 1,
		Transparency = 0,
		Scale = 1,
		Enabled = true,
		DisplayOrder = 0,
		FillDirection = EnumRoot.FillDirection.Vertical,
		SortOrder = EnumRoot.SortOrder.LayoutOrder,
		VerticalAlignment = EnumRoot.VerticalAlignment.Top,
		HorizontalAlignment = EnumRoot.HorizontalAlignment.Left,
		Padding = UDim.new(0, 0),
		PaddingTop = UDim.new(0, 0),
		PaddingBottom = UDim.new(0, 0),
		PaddingLeft = UDim.new(0, 0),
		PaddingRight = UDim.new(0, 0),
		AbsoluteContentSize = Vector2.new(0, 0),
	}
end

local Instance: any = {}

function Instance.new(class: string, parent: any?): any
	if KNOWN_CLASSES[class] == nil then
		error("Mock: unknown class '" .. tostring(class) .. "'", 2)
	end
	local obj: any = {}
	local store = {
		class = class,
		props = {},
		defaults = buildDefaults(class),
		events = { Changed = makeEvent(), Destroying = makeEvent() },
		propSignals = {},
		children = {},
		destroyed = false,
		methods = {},
	}
	rawset(obj, "_store", store)
	local methods = store.methods

	local isGuiObject = class ~= "ScreenGui" and class ~= "PlayerGui"
		and class ~= "CoreGui" and class ~= "Folder" and class ~= "Players"
		and class ~= "StarterGui" and class ~= "BillboardGui" and class ~= "SurfaceGui"
	local isButton = class == "TextButton" or class == "ImageButton"
	if isGuiObject then
		for _, e in GUIOBJECT_EVENTS do store.events[e] = makeEvent() end
	end
	if isButton then
		for _, e in BUTTON_EVENTS do store.events[e] = makeEvent() end
	end
	if class == "TextBox" then
		for _, e in TEXTBOX_EVENTS do store.events[e] = makeEvent() end
	end
	if class == "ScrollingFrame" then
		for _, e in SCROLL_EVENTS do store.events[e] = makeEvent() end
	end
	store.props.Name = class
	store.props.ClassName = class
	store.props.Parent = nil

	function methods._setParent(self: any, p: any)
		local old = store.props.Parent
		if old == p then return end
		if old ~= nil then
			local kids = rawget(old, "_store").children
			for i = #kids, 1, -1 do
				if kids[i] == self then table.remove(kids, i) break end
			end
		end
		store.props.Parent = p
		if p ~= nil then
			table.insert(rawget(p, "_store").children, self)
		end
	end
	function methods.GetChildren(_s: any)
		local out = {}
		for i = 1, #store.children do out[i] = store.children[i] end
		return out
	end
	function methods.GetDescendants(_s: any)
		local out: any = {}
		local function walk(o: any)
			for _, ch in rawget(o, "_store").children do
				table.insert(out, ch)
				walk(ch)
			end
		end
		walk(obj)
		return out
	end
	function methods.FindFirstChild(_s: any, name: string, recursive: boolean?)
		for _, ch in store.children do
			if ch.Name == name then return ch end
		end
		if recursive then
			for _, ch in store.children do
				local found = ch:FindFirstChild(name, true)
				if found ~= nil then return found end
			end
		end
		return nil
	end
	function methods.FindFirstChildOfClass(_s: any, className: string)
		for _, ch in store.children do
			if ch.ClassName == className then return ch end
		end
		return nil
	end
	function methods.FindFirstAncestor(_s: any, name: string)
		local p = store.props.Parent
		while p ~= nil do
			if p.Name == name then return p end
			p = rawget(p, "_store").props.Parent
		end
		return nil
	end
	function methods.IsA(_s: any, className: string): boolean
		if class == className then return true end
		for _, a in ANCESTORS[class] or {} do
			if a == className then return true end
		end
		return false
	end
	function methods.IsDescendantOf(_s: any, ancestor: any): boolean
		local p = store.props.Parent
		while p ~= nil do
			if p == ancestor then return true end
			p = rawget(p, "_store").props.Parent
		end
		return false
	end
	function methods.GetPropertyChangedSignal(_s: any, prop: string)
		if store.propSignals[prop] == nil then
			store.propSignals[prop] = makeEvent()
		end
		return store.propSignals[prop]
	end
	function methods.Destroy(_s: any)
		if store.destroyed then return end
		store.destroyed = true
		local kids = {}
		for i = 1, #store.children do kids[i] = store.children[i] end
		for _, ch in kids do ch:Destroy() end
		methods._setParent(obj, nil)
		store.events.Destroying:Fire()
	end
	function methods._isDestroyed(): boolean
		return store.destroyed
	end

	setmetatable(obj, instanceMt)
	if parent ~= nil then
		obj.Parent = parent
	end
	return obj
end

Mock.Instance = Instance

-- ---------------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------------

-- TweenService: applies instantly (tests assert end states), logs everything.
local tweenLog: { any } = {}
local TweenService: any = {}
function TweenService.Create(_s: any, obj: any, info: any, props: any)
	local rec = { target = obj, info = info, props = props, played = false, cancelled = false }
	table.insert(tweenLog, rec)
	local tw: any = {}
	tw.Completed = makeEvent()
	tw.PlaybackState = "Delayed"
	function tw.Play(_t: any)
		rec.played = true
		tw.PlaybackState = "Completed"
		for k, v in props do
			obj[k] = v
		end
		tw.Completed:Fire("Completed")
	end
	function tw.Cancel(_t: any)
		rec.cancelled = true
		tw.PlaybackState = "Cancelled"
	end
	function tw.Destroy(_t: any) end
	return tw
end
Mock.TweenService = TweenService
Mock.tweenLog = tweenLog

-- UserInputService.
local UserInputService: any = {
	InputBegan = makeEvent(),
	InputEnded = makeEvent(),
	InputChanged = makeEvent(),
	TouchEnabled = false,
	KeyboardEnabled = true,
	GamepadEnabled = false,
}
local focusedTextBox: any = nil
function UserInputService.GetFocusedTextBox(_s: any)
	return focusedTextBox
end
function Mock._setFocusedTextBox(tb: any)
	focusedTextBox = tb
end
local pressedKeys: { [string]: boolean } = {}
function UserInputService.IsKeyDown(_s: any, keycode: any): boolean
	local name = keycode
	if type(keycode) == "table" then
		name = keycode.Name
	end
	return pressedKeys[name] == true
end
function Mock._setKeyDown(keyName: string, down: boolean)
	if down then
		pressedKeys[keyName] = true
	else
		pressedKeys[keyName] = nil
	end
end
Mock.UserInputService = UserInputService

-- Players + mouse.
local Mouse: any = {
	X = 0, Y = 0,
	Move = makeEvent(),
	Button1Down = makeEvent(),
	Button1Up = makeEvent(),
	WheelForward = makeEvent(),
	WheelBackward = makeEvent(),
}
Mock.Mouse = Mouse
local PlayerGui = Instance.new("PlayerGui")
local LocalPlayer: any = {
	Name = "Tester",
	DisplayName = "Tester",
	UserId = 1,
	PlayerGui = PlayerGui,
}
function LocalPlayer.GetMouse(_s: any) return Mouse end
local PlayersService: any = { LocalPlayer = LocalPlayer }
Mock.Players = PlayersService

-- CoreGui.
local CoreGui = Instance.new("CoreGui")
Mock.CoreGui = CoreGui

-- HttpService with a minimal JSON codec (strings, numbers, booleans,
-- arrays, string-keyed dicts — exactly the persistence shape).
local function jsonEscape(s: string): string
	local out = string.gsub(s, '[%z\1-\31\\"]', function(ch: string)
		if ch == '"' then return '\\"'
		elseif ch == "\\" then return "\\\\"
		elseif ch == "\n" then return "\\n"
		elseif ch == "\r" then return "\\r"
		elseif ch == "\t" then return "\\t"
		elseif ch == "\b" then return "\\b"
		elseif ch == "\f" then return "\\f"
		else return string.format("\\u%04x", string.byte(ch)) end
	end)
	return '"' .. out .. '"'
end

local function jsonEncode(v: any): string
	local t = type(v)
	if t == "string" then
		return jsonEscape(v)
	elseif t == "number" then
		assert(v == v and v ~= math.huge and v ~= -math.huge, "mock JSON: bad number")
		return tostring(v)
	elseif t == "boolean" then
		return v and "true" or "false"
	elseif t == "table" then
		-- Array iff keys are exactly 1..n.
		local n = #v
		local count = 0
		local isArr = true
		for k, _ in v do
			count += 1
			if type(k) ~= "number" or k < 1 or k > n or math.floor(k) ~= k then
				isArr = false
			end
		end
		if isArr and count == n and n > 0 then
			local parts: { string } = {}
			for i = 1, n do parts[i] = jsonEncode(v[i]) end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		local keys: { string } = {}
		for k, _ in v do
			assert(type(k) == "string", "mock JSON: dict keys must be strings")
			table.insert(keys, k)
		end
		table.sort(keys)
		local parts: { string } = {}
		for _, k in keys do
			table.insert(parts, jsonEscape(k) .. ":" .. jsonEncode(v[k]))
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	error("mock JSON: cannot encode " .. t, 2)
end

local function jsonDecode(s: string): any
	local i = 1
	local function skipWs()
		while i <= #s and string.find(" \t\n\r", string.sub(s, i, i), 1, true) do
			i += 1
		end
	end
	local parseValue: () -> any
	local function parseString(): string
		assert(string.sub(s, i, i) == '"', "mock JSON: expected string")
		i += 1
		local buf: { string } = {}
		while i <= #s do
			local ch = string.sub(s, i, i)
			if ch == '"' then
				i += 1
				return table.concat(buf)
			elseif ch == "\\" then
				i += 1
				local e = string.sub(s, i, i)
				if e == "n" then table.insert(buf, "\n")
				elseif e == "r" then table.insert(buf, "\r")
				elseif e == "t" then table.insert(buf, "\t")
				elseif e == "b" then table.insert(buf, "\b")
				elseif e == "f" then table.insert(buf, "\f")
				elseif e == "u" then
					local hex = string.sub(s, i + 1, i + 4)
					local code = tonumber(hex, 16) or 63
					table.insert(buf, code < 256 and string.char(code) or "?")
					i += 4
				else table.insert(buf, e) end
				i += 1
			else
				table.insert(buf, ch)
				i += 1
			end
		end
		error("mock JSON: unterminated string")
	end
	local function parseLiteral(): any
		if string.sub(s, i, i + 3) == "true" then i += 4 return true end
		if string.sub(s, i, i + 4) == "false" then i += 5 return false end
		if string.sub(s, i, i + 3) == "null" then i += 4 return nil end
		local num = string.match(string.sub(s, i), "^%-?%d+%.?%d*[eE]?[%+%-]?%d*")
		assert(num ~= nil and num ~= "", "mock JSON: bad value at " .. i)
		i += #num
		return tonumber(num)
	end
	parseValue = function()
		skipWs()
		local ch = string.sub(s, i, i)
		if ch == '"' then
			return parseString()
		elseif ch == "{" then
			i += 1
			local obj: { [string]: any } = {}
			skipWs()
			if string.sub(s, i, i) == "}" then i += 1 return obj end
			while true do
				skipWs()
				local k = parseString()
				skipWs()
				assert(string.sub(s, i, i) == ":", "mock JSON: expected ':'")
				i += 1
				obj[k] = parseValue()
				skipWs()
				local d = string.sub(s, i, i)
				if d == "," then i += 1
				elseif d == "}" then i += 1 return obj
				else error("mock JSON: expected ',' or '}'") end
			end
		elseif ch == "[" then
			i += 1
			local arr: { any } = {}
			skipWs()
			if string.sub(s, i, i) == "]" then i += 1 return arr end
			while true do
				local v = parseValue()
				assert(v ~= nil, "mock JSON: null in array unsupported")
				table.insert(arr, v)
				skipWs()
				local d = string.sub(s, i, i)
				if d == "," then i += 1
				elseif d == "]" then i += 1 return arr
				else error("mock JSON: expected ',' or ']'") end
			end
		else
			return parseLiteral()
		end
	end
	local v = parseValue()
	skipWs()
	assert(i > #s, "mock JSON: trailing characters")
	return v
end

local HttpService: any = {}
function HttpService.JSONEncode(_s: any, v: any) return jsonEncode(v) end
function HttpService.JSONDecode(_s: any, s: string) return jsonDecode(s) end
Mock.HttpService = HttpService

-- game.
local services: { [string]: any } = {
	TweenService = TweenService,
	UserInputService = UserInputService,
	Players = PlayersService,
	CoreGui = CoreGui,
	StarterGui = Instance.new("StarterGui"),
	HttpService = HttpService,
}
local gameMock: any = {}
function gameMock.GetService(_s: any, name: string)
	local svc = services[name]
	if svc == nil then
		error("Mock: unknown service '" .. tostring(name) .. "'", 2)
	end
	return svc
end
gameMock.CoreGui = CoreGui
Mock.game = gameMock

-- Input builders for tests.
function Mock.keyInput(keyName: string, pos: any?): any
	return {
		UserInputType = EnumRoot.UserInputType.Keyboard,
		KeyCode = EnumRoot.KeyCode[keyName],
		UserInputState = "Begin",
		Position = pos or Vector2.new(0, 0),
	}
end
function Mock.mouseInput(button: string, x: number?, y: number?): any
	return {
		UserInputType = EnumRoot.UserInputType[button],
		KeyCode = EnumRoot.KeyCode.Unknown,
		UserInputState = "Begin",
		Position = Vector2.new(x or 0, y or 0),
	}
end
function Mock.touchInput(x: number?, y: number?): any
	return {
		UserInputType = EnumRoot.UserInputType.Touch,
		KeyCode = EnumRoot.KeyCode.Unknown,
		UserInputState = "Begin",
		Position = Vector2.new(x or 0, y or 0),
	}
end

-- ---------------------------------------------------------------------------
-- Fake task scheduler (virtual time)
-- ---------------------------------------------------------------------------

function Mock.FakeScheduler()
	local time = 0
	local queue: { { at: number, fn: () -> (), cancelled: boolean } } = {}
	local sched: any = {}
	local taskFake: any = {}
	function taskFake.delay(n: number, fn: () -> ()): any
		local rec = { at = time + (n or 0), fn = fn, cancelled = false }
		table.insert(queue, rec)
		return rec
	end
	function taskFake.defer(fn: () -> ())
		return taskFake.delay(0, fn)
	end
	function taskFake.spawn(fn: () -> ())
		return taskFake.delay(0, fn)
	end
	function taskFake.wait(n: number?)
		time += (n or 0)
		return time
	end
	function taskFake.cancel(handle: any)
		if handle ~= nil then handle.cancelled = true end
	end
	sched.task = taskFake
	function sched.pump()
		table.sort(queue, function(a: any, b: any) return a.at < b.at end)
		while #queue > 0 do
			local rec = table.remove(queue, 1) :: any
			if not rec.cancelled then
				time = rec.at
				rec.fn()
			end
		end
	end
	function sched.pendingCount(): number
		local n = 0
		for _, rec in queue do
			if not rec.cancelled then n += 1 end
		end
		return n
	end
	sched.realTask = nil
	function sched.install()
		sched.realTask = task
		task = taskFake;
		(getgenv or function() return _G end)();
		(_G :: any).task = taskFake
	end
	function sched.uninstall()
		if sched.realTask ~= nil then
			(_G :: any).task = sched.realTask
			sched.realTask = nil
		end
	end
	return sched
end

-- ---------------------------------------------------------------------------
-- install / reset
-- ---------------------------------------------------------------------------

function Mock.install()
	local G: any = _G
	G.Instance = Instance
	G.UDim = UDim
	G.UDim2 = UDim2
	G.Vector2 = Vector2
	G.Color3 = Color3
	G.ColorSequence = ColorSequence
	G.ColorSequenceKeypoint = ColorSequenceKeypoint
	G.NumberSequence = NumberSequence
	G.NumberSequenceKeypoint = NumberSequenceKeypoint
	G.Enum = EnumRoot
	G.TweenInfo = TweenInfo
	G.game = gameMock
	G.gethui = function() return CoreGui end
end

function Mock.reset()
	table.clear(tweenLog)
	Mouse.X, Mouse.Y = 0, 0
	focusedTextBox = nil
	for _, child in CoreGui:GetChildren() do
		child:Destroy()
	end
	for _, child in PlayerGui:GetChildren() do
		child:Destroy()
	end
end

return Mock
