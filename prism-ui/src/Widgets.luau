--!strict
-- ============================================================================
--  PRISM-UI · Widgets
-- ----------------------------------------------------------------------------
--  Controlled UI components: Toggle, Slider, Dropdown (single + multi),
--  Keybind, Textbox, ColorField, Button, Label, Divider, Section (collapsible
--  card) and Searchbox.
--
--  CONTROLLED-COMPONENT CONTRACT (every value widget):
--    * `props.value` is the initial value; `props.onChanged` fires on USER
--      gestures only.
--    * `handle:set(v)` updates the visuals SILENTLY (no onChanged). Hosts
--      (the Panel) push store values down through :set and write user
--      gestures up through onChanged — the loop cannot echo.
--    * `handle:get()` returns a defensive copy.
--    * `handle:enable(bool)` toggles interactivity (+ dimmed visuals).
--    * `handle:destroy()` disconnects everything and destroys the tree.
--    * `handle:_refresh()` re-reads Theme.current() and repaints (live
--      re-theming; called by Window:applyTheme).
--
--  Engine globals (`game`, `Instance`, …) resolve at CALL time, and services
--  are fetched lazily on first build — requiring this module never touches
--  the engine, so tests install the mock first and everything just works.
-- ============================================================================

local Color = require("./Color")
local Signal = require("./Signal")
local Theme = require("./Theme")
local Util = require("./Util")

local Widgets = {}

-- ---------------------------------------------------------------------------
-- Engine bridge (lazy; globals resolved at call time)
-- ---------------------------------------------------------------------------

local cachedServices: any = nil

local function services(): any
	if cachedServices == nil then
		local g = game
		local tweenSvc = g:GetService("TweenService")
		local uis = g:GetService("UserInputService")
		local players = g:GetService("Players")
		cachedServices = {
			tween = tweenSvc,
			uis = uis,
			players = players,
			mouse = players.LocalPlayer:GetMouse(),
		}
	end
	return cachedServices
end

--- Theme hex -> engine Color3.
local function c3(hex: string): any
	local parsed = Color.fromHex(hex)
	assert(parsed ~= nil, "Widgets: invalid hex '" .. tostring(hex) .. "'")
	local cc = parsed :: Color.RGBA
	local r, g, b = Color.toRGB255(cc.r, cc.g, cc.b)
	return Color3.fromRGB(r, g, b)
end

local function fontOf(tokenName: string): any
	local tokens: any = Theme.current()
	local name = tokens[tokenName] or "Gotham"
	return Enum.Font[name]
end

--- Create an instance, apply props BEFORE parenting (fast + flicker-free).
local function el(class: string, props: { [string]: any }?, parent: any?): any
	local o = Instance.new(class)
	if props ~= nil then
		for k, v in pairs(props) do
			(o :: any)[k] = v
		end
	end
	o.Parent = parent
	return o
end

local function corner(parent: any, radius: number): any
	return el("UICorner", { CornerRadius = UDim.new(radius == 1 and 1 or 0, radius == 1 and 0 or radius) }, parent)
end

local function stroke(parent: any, colorHex: string, thickness: number?, transparency: number?): any
	-- NOTE: ApplyStrokeMode intentionally left at its default (Contextual).
	return el("UIStroke", {
		Color = c3(colorHex),
		Thickness = thickness or 1,
		Transparency = transparency or 0,
	}, parent)
end

local function pad(parent: any, px: number): any
	return el("UIPadding", {
		PaddingTop = UDim.new(0, px),
		PaddingBottom = UDim.new(0, px),
		PaddingLeft = UDim.new(0, px),
		PaddingRight = UDim.new(0, px),
	}, parent)
end

local function vlist(parent: any, gap: number): any
	return el("UIListLayout", {
		FillDirection = Enum.FillDirection.Vertical,
		SortOrder = Enum.SortOrder.LayoutOrder,
		Padding = UDim.new(0, gap),
	}, parent)
end

local function tween(obj: any, props: { [string]: any }, secs: number?): any
	local s = services()
	local tokens = Theme.current()
	local info = TweenInfo.new(secs or tokens.tweenFast, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
	local tw = s.tween:Create(obj, info, props)
	tw:Play()
	return tw
end

-- ---------------------------------------------------------------------------
-- Handle base + value mixin
-- ---------------------------------------------------------------------------

local function baseHandle(root: any): any
	local h: any = { root = root, _conns = {}, _dead = false }
	function h._track(self: any, conn: any): any
		table.insert(self._conns, conn)
		return conn
	end
	function h.destroy(self: any)
		if self._dead then
			return
		end
		self._dead = true
		for _, c in ipairs(self._conns) do
			local conn: any = c
			pcall(function()
				conn:Disconnect()
			end)
		end
		if self._signal ~= nil then
			self._signal:DisconnectAll()
		end
		if self._onDestroy ~= nil then
			pcall(self._onDestroy)
		end
		pcall(function()
			self.root:Destroy()
		end)
	end
	return h
end

local function withValue(h: any, initial: any): any
	h._value = Util.deepCopy(initial)
	h._signal = Signal.new()
	function h.get(self: any): any
		return Util.deepCopy(self._value)
	end
	function h.onChanged(self: any, fn: (any) -> ()): () -> ()
		local conn = self._signal:Connect(fn)
		table.insert(self._conns, conn)
		return function()
			conn:Disconnect()
		end
	end
	function h._fire(self: any, v: any)
		self._signal:Fire(Util.deepCopy(v))
	end
	return h
end

-- ---------------------------------------------------------------------------
-- Standard row: label (+ optional description) with a right-side control slot
-- ---------------------------------------------------------------------------

local function makeRow(parent: any, label: string?, description: string?, controlW: number): (any, any, any)
	local tokens = Theme.current()
	local hasDesc = description ~= nil and description ~= ""
	local h = hasDesc and 48 or (tokens.rowH :: number)
	local row = el("Frame", {
		Name = "Row",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, h),
	}, parent)
	local lab: any = nil
	if label ~= nil then
		lab = el("TextLabel", {
			Name = "Label",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 0, 0, 0),
			Size = UDim2.new(1, -(controlW + 8), 0, hasDesc and 20 or h),
			Font = fontOf("fontMedium"),
			TextSize = 13,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextColor3 = c3(tokens.text),
			TextTruncate = Enum.TextTruncate.AtEnd,
			Text = label,
		}, row)
	end
	local desc: any = nil
	if hasDesc then
		desc = el("TextLabel", {
			Name = "Desc",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 0, 0, 19),
			Size = UDim2.new(1, -(controlW + 8), 0, 26),
			Font = fontOf("fontRegular"),
			TextSize = 11,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextYAlignment = Enum.TextYAlignment.Top,
			TextColor3 = c3(tokens.textDim),
			TextWrapped = true,
			Text = description,
		}, row)
	end
	return row, lab, desc
end

-- ============================================================================
-- Toggle
-- ============================================================================

function Widgets.Toggle(props: any, parent: any): any
	props = props or {}
	local tokens = Theme.current()
	local row, lab, desc = makeRow(parent, props.label or "Toggle", props.description, 48)

	-- Full-row click target (created first so it sits BEHIND the pill).
	el("TextButton", {
		Name = "Hit",
		Text = "",
		BackgroundTransparency = 1,
		AutoButtonColor = false,
		Size = UDim2.fromScale(1, 1),
	}, row)
	local pill = el("TextButton", {
		Name = "Pill",
		Text = "",
		AutoButtonColor = false,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, 0, 0.5, 0),
		Size = UDim2.new(0, 40, 0, 20),
		BackgroundColor3 = c3(tokens.bg3),
		BorderSizePixel = 0,
	}, row)
	corner(pill, 1)
	local knob = el("Frame", {
		Name = "Knob",
		Size = UDim2.new(0, 14, 0, 14),
		Position = UDim2.new(0, 3, 0.5, -7),
		BackgroundColor3 = c3(tokens.textDim),
		BorderSizePixel = 0,
	}, pill)
	corner(knob, 1)
	local hit = row:FindFirstChild("Hit")

	local h = withValue(baseHandle(row), props.value == true)
	local enabled = props.disabled ~= true

	local function render(animate: boolean)
		local on = h._value
		local pillColor = on and c3(tokens.accent) or c3(tokens.bg3)
		local knobColor = on and c3(tokens.accentText) or c3(tokens.textDim)
		local knobX = on and 23 or 3
		if animate then
			tween(pill, { BackgroundColor3 = pillColor })
			tween(knob, {
				Position = UDim2.new(0, knobX, 0.5, -7),
				BackgroundColor3 = knobColor,
			})
		else
			pill.BackgroundColor3 = pillColor
			knob.Position = UDim2.new(0, knobX, 0.5, -7)
			knob.BackgroundColor3 = knobColor
		end
	end

	local function userToggle()
		if not enabled or h._dead then
			return
		end
		h._value = not h._value
		render(true)
		h:_fire(h._value)
	end
	h:_track(pill.MouseButton1Click:Connect(userToggle))
	h:_track(hit.MouseButton1Click:Connect(userToggle))

	function h.set(self: any, v: any)
		if self._dead then
			return
		end
		self._value = v == true
		render(true)
	end
	function h.toggle(self: any)
		userToggle()
	end
	function h.enable(self: any, on: boolean?)
		enabled = on ~= false
		local dim = enabled and 0 or 0.55
		if lab ~= nil then
			lab.TextTransparency = dim
		end
		if desc ~= nil then
			desc.TextTransparency = dim
		end
		pill.BackgroundTransparency = enabled and 0 or 0.5
		knob.BackgroundTransparency = enabled and 0 or 0.5
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		if lab ~= nil then
			lab.TextColor3 = c3(tokens.text)
			lab.Font = fontOf("fontMedium")
		end
		if desc ~= nil then
			desc.TextColor3 = c3(tokens.textDim)
			desc.Font = fontOf("fontRegular")
		end
		render(false)
	end
	if props.onChanged ~= nil then
		h:onChanged(props.onChanged)
	end
	if props.disabled then
		h:enable(false)
	end
	render(false)
	return h
end

-- ============================================================================
-- Slider
-- ============================================================================

function Widgets.Slider(props: any, parent: any): any
	props = props or {}
	local min = props.min or 0
	local max = props.max or 100
	local step = props.step or 1
	local decimals = props.decimals or 0
	local unit = props.unit
	local tokens = Theme.current()
	local s = services()

	local hasDesc = props.description ~= nil and props.description ~= ""
	local topH = hasDesc and 48 or 26
	local row = el("Frame", {
		Name = "Row",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, topH + 20),
	}, parent)
	local lab: any = nil
	if props.label ~= nil then
		lab = el("TextLabel", {
			Name = "Label",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 0, 0, 0),
			Size = UDim2.new(1, -96, 0, 20),
			Font = fontOf("fontMedium"),
			TextSize = 13,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextColor3 = c3(tokens.text),
			TextTruncate = Enum.TextTruncate.AtEnd,
			Text = props.label,
		}, row)
	end
	local desc: any = nil
	if hasDesc then
		desc = el("TextLabel", {
			Name = "Desc",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 0, 0, 19),
			Size = UDim2.new(1, -96, 0, 26),
			Font = fontOf("fontRegular"),
			TextSize = 11,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextYAlignment = Enum.TextYAlignment.Top,
			TextColor3 = c3(tokens.textDim),
			TextWrapped = true,
			Text = props.description,
		}, row)
	end
	local valueBox = el("TextBox", {
		Name = "Value",
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, 0, 0, 0),
		Size = UDim2.new(0, 88, 0, 22),
		BackgroundColor3 = c3(tokens.bg2),
		BorderSizePixel = 0,
		Font = fontOf("fontMedium"),
		TextSize = 12,
		TextColor3 = c3(tokens.text),
		Text = "",
		ClearTextOnFocus = false,
	}, row)
	corner(valueBox, tokens.radiusSm)
	stroke(valueBox, tokens.border)

	local trackY = topH + 2
	local track = el("Frame", {
		Name = "Track",
		Position = UDim2.new(0, 0, 0, trackY),
		Size = UDim2.new(1, 0, 0, 4),
		BackgroundColor3 = c3(tokens.bg3),
		BorderSizePixel = 0,
	}, row)
	corner(track, 1)
	local fill = el("Frame", {
		Name = "Fill",
		Size = UDim2.new(0, 0, 1, 0),
		BackgroundColor3 = c3(tokens.accent),
		BorderSizePixel = 0,
	}, track)
	corner(fill, 1)
	local knob = el("Frame", {
		Name = "Knob",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Size = UDim2.new(0, 12, 0, 12),
		Position = UDim2.new(0, 0, 0.5, 0),
		BackgroundColor3 = c3(tokens.accentText),
		BorderSizePixel = 0,
	}, track)
	corner(knob, 1)
	stroke(knob, tokens.accent, 2)
	-- Generous invisible grab area over the track row.
	local grab = el("TextButton", {
		Name = "Grab",
		Text = "",
		BackgroundTransparency = 1,
		AutoButtonColor = false,
		Position = UDim2.new(0, 0, 0, trackY - 7),
		Size = UDim2.new(1, 0, 0, 18),
	}, row)

	local h = withValue(baseHandle(row), props.value or min)
	local enabled = props.disabled ~= true
	local dragging = false

	local function formatValue(v: number): string
		local num: string
		if decimals > 0 then
			num = string.format("%." .. tostring(decimals) .. "f", v)
		else
			num = Util.formatInt(v)
		end
		if unit ~= nil then
			num ..= " " .. unit
		end
		return num
	end

	local function normalize(v: number, stepOverride: number?): number
		local span = max - min
		if span <= 0 then
			return min
		end
		local useStep = stepOverride or step
		local n = Util.clamp(v, min, max)
		n = Util.snap(n, min, useStep)
		n = Util.clamp(n, min, max)
		local mult = 10 ^ decimals
		return math.floor(n * mult + 0.5) / mult
	end

	local function fractionOf(v: number): number
		local span = max - min
		if span <= 0 then
			return 0
		end
		return Util.clamp((v - min) / span, 0, 1)
	end

	local function render()
		local frac = fractionOf(h._value)
		fill.Size = UDim2.new(frac, 0, 1, 0)
		knob.Position = UDim2.new(frac, 0, 0.5, 0)
		local text = formatValue(h._value)
		if valueBox.Text ~= text then
			valueBox.Text = text
		end
	end

	local function setValue(v: number, fire: boolean, stepOverride: number?)
		local n = normalize(v, stepOverride)
		if n == h._value then
			render()
			return
		end
		h._value = n
		render()
		if fire then
			h:_fire(n)
		end
	end

	local function shiftDown(): boolean
		local uis = s.uis
		return uis:IsKeyDown(Enum.KeyCode.LeftShift) or uis:IsKeyDown(Enum.KeyCode.RightShift)
	end

	local function applyPointer(x: number)
		local pos = track.AbsolutePosition.X
		local size = track.AbsoluteSize.X
		if size <= 0 then
			return
		end
		local frac = Util.clamp((x - pos) / size, 0, 1)
		local raw = min + frac * (max - min)
		-- Shift == precision mode: snap to one tenth of the step.
		local st = shiftDown() and step / 10 or step
		setValue(raw, true, st)
	end

	h:_track(grab.InputBegan:Connect(function(input: any)
		if h._dead or not enabled then
			return
		end
		local t = input.UserInputType
		if t == Enum.UserInputType.MouseButton1 or t == Enum.UserInputType.Touch then
			dragging = true
			applyPointer(input.Position.X)
		end
	end))
	h:_track(s.uis.InputChanged:Connect(function(input: any)
		if h._dead or not dragging then
			return
		end
		local t = input.UserInputType
		if t == Enum.UserInputType.MouseMovement or t == Enum.UserInputType.Touch then
			applyPointer(input.Position.X)
		end
	end))
	h:_track(s.uis.InputEnded:Connect(function(input: any)
		if not dragging then
			return
		end
		local t = input.UserInputType
		if t == Enum.UserInputType.MouseButton1 or t == Enum.UserInputType.Touch then
			dragging = false
		end
	end))

	h:_track(valueBox.FocusLost:Connect(function(_enterPressed: boolean)
		if h._dead or not enabled then
			return
		end
		local raw = valueBox.Text
		if unit ~= nil then
			-- Strip a trailing unit with a PLAIN search (units may be UTF-8).
			local at = string.find(raw, unit, 1, true)
			if at ~= nil then
				raw = string.sub(raw, 1, at - 1)
			end
		end
		local parsed = Util.parseScalar(raw)
		if parsed ~= nil then
			setValue(parsed, true)
		else
			render() -- revert to the committed value
		end
	end))

	function h.set(self: any, v: any)
		if self._dead or type(v) ~= "number" then
			return
		end
		setValue(v, false)
	end
	function h.enable(self: any, on: boolean?)
		enabled = on ~= false
		local dim = enabled and 0 or 0.55
		if lab ~= nil then
			lab.TextTransparency = dim
		end
		if desc ~= nil then
			desc.TextTransparency = dim
		end
		valueBox.TextTransparency = dim
		track.BackgroundTransparency = enabled and 0 or 0.5
		fill.BackgroundTransparency = enabled and 0 or 0.5
		knob.BackgroundTransparency = enabled and 0 or 0.5
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		if lab ~= nil then
			lab.TextColor3 = c3(tokens.text)
		end
		if desc ~= nil then
			desc.TextColor3 = c3(tokens.textDim)
		end
		valueBox.BackgroundColor3 = c3(tokens.bg2)
		valueBox.TextColor3 = c3(tokens.text)
		track.BackgroundColor3 = c3(tokens.bg3)
		fill.BackgroundColor3 = c3(tokens.accent)
		knob.BackgroundColor3 = c3(tokens.accentText)
		local ks = knob:FindFirstChildOfClass("UIStroke")
		if ks ~= nil then
			ks.Color = c3(tokens.accent)
		end
		local vs = valueBox:FindFirstChildOfClass("UIStroke")
		if vs ~= nil then
			vs.Color = c3(tokens.border)
		end
	end
	if props.onChanged ~= nil then
		h:onChanged(props.onChanged)
	end
	if props.disabled then
		h:enable(false)
	end
	h._value = normalize(h._value)
	render()
	return h
end

-- ============================================================================
-- Dropdown (single + multi, popup rendered into an overlay layer)
-- ============================================================================

local CHECK = "✓"
local CHEV_DOWN = "▼"
local CHEV_UP = "▲"

function Widgets.Dropdown(props: any, parent: any): any
	props = props or {}
	local options: { string } = props.options or {}
	local multi = props.multi == true
	local minSelect = props.minSelect or 0
	local maxSelect = props.maxSelect
	local overlay = props.overlay
	assert(overlay ~= nil, "Dropdown requires props.overlay (popup layer)")
	local enableSearch = props.search
	if enableSearch == nil then
		enableSearch = multi or #options > 6
	end
	local tokens = Theme.current()
	local s = services()
	local width = props.width or 180

	local row, lab, desc = makeRow(parent, props.label or "Dropdown", props.description, width + 8)
	local button = el("TextButton", {
		Name = "Button",
		Text = "",
		AutoButtonColor = false,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, 0, 0.5, 0),
		Size = UDim2.new(0, width, 0, 26),
		BackgroundColor3 = c3(tokens.bg2),
		BorderSizePixel = 0,
	}, row)
	corner(button, tokens.radiusSm)
	stroke(button, tokens.border)
	local buttonText = el("TextLabel", {
		Name = "Text",
		BackgroundTransparency = 1,
		Position = UDim2.new(0, 8, 0, 0),
		Size = UDim2.new(1, -30, 1, 0),
		Font = fontOf("fontRegular"),
		TextSize = 12,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextColor3 = c3(tokens.text),
		TextTruncate = Enum.TextTruncate.AtEnd,
		Text = "",
	}, button)
	local chev = el("TextLabel", {
		Name = "Chevron",
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -8, 0.5, 0),
		Size = UDim2.new(0, 14, 0, 14),
		Font = fontOf("fontRegular"),
		TextSize = 10,
		TextColor3 = c3(tokens.textDim),
		Text = CHEV_DOWN,
	}, button)

	local initial: any = multi and {} or ""
	if props.value ~= nil then
		initial = props.value
	end
	local h = withValue(baseHandle(row), initial)
	local enabled = props.disabled ~= true
	local open = false
	local popupConns: { any } = {}
	local popupRoot: any = nil

	local function summaryText(): string
		if not multi then
			if h._value == nil or h._value == "" then
				return "Select..."
			end
			return tostring(h._value)
		end
		local list: { string } = h._value
		if #list == 0 then
			return "None"
		elseif #list == 1 then
			return list[1]
		end
		return tostring(#list) .. " selected"
	end

	local function renderButton()
		buttonText.Text = summaryText()
		buttonText.TextTransparency = (not multi and (h._value == nil or h._value == "")) and 0.4 or 0
		chev.Text = open and CHEV_UP or CHEV_DOWN
	end

	local function trackPopup(conn: any)
		table.insert(popupConns, conn)
		return conn
	end

	local function close()
		if not open then
			return
		end
		open = false
		for _, c in ipairs(popupConns) do
			pcall(function()
				c:Disconnect()
			end)
		end
		table.clear(popupConns)
		if popupRoot ~= nil then
			pcall(function()
				popupRoot:Destroy()
			end)
			popupRoot = nil
		end
		renderButton()
	end

	local function isSelected(opt: string): boolean
		if not multi then
			return h._value == opt
		end
		for _, v in ipairs(h._value) do
			if v == opt then
				return true
			end
		end
		return false
	end

	local function choose(opt: string)
		if multi then
			local list: { string } = Util.deepCopy(h._value)
			local at: number? = nil
			for i, v in ipairs(list) do
				if v == opt then
					at = i
					break
				end
			end
			if at ~= nil then
				if #list - 1 < minSelect then
					return -- refuse to drop below the minimum
				end
				table.remove(list, at)
			else
				if maxSelect ~= nil and #list + 1 > (maxSelect :: number) then
					return -- refuse to exceed the maximum
				end
				table.insert(list, opt)
			end
			h._value = list
			renderButton()
			h:_fire(list)
		else
			h._value = opt
			close()
			h:_fire(opt)
		end
	end

	local function filteredOptions(query: string): { string }
		if query == nil or query == "" then
			return Util.shallowCopy(options)
		end
		local items: { Util.SearchItem } = {}
		for _, opt in ipairs(options) do
			table.insert(items, { id = opt, text = opt })
		end
		local hits = Util.rankedSearch(items, query)
		local out: { string } = {}
		for _, hit in ipairs(hits) do
			table.insert(out, hit.id)
		end
		return out
	end

	local OPTION_H = 28

	local function openPopup()
		if open or h._dead or not enabled then
			return
		end
		open = true
		-- Modal click-catcher behind the popup.
		popupRoot = el("Frame", {
			Name = "DropdownPopup",
			BackgroundTransparency = 1,
			Size = UDim2.fromScale(1, 1),
			ZIndex = 200,
		}, overlay)
		local closer = el("TextButton", {
			Name = "Closer",
			Text = "",
			BackgroundTransparency = 1,
			AutoButtonColor = false,
			Size = UDim2.fromScale(1, 1),
			ZIndex = 200,
		}, popupRoot)
		trackPopup(closer.MouseButton1Click:Connect(close))

		local listW = button.AbsoluteSize.X
		if listW <= 0 then
			listW = width
		end
		local searchH = enableSearch and 36 or 0
		local footerH = multi and 32 or 0

		local listFrame: any = nil
		local emptyLabel: any = nil
		local card: any = nil
		local sizeCard: () -> () -- forward: assigned below, used by the filter

		local function renderOptions(query: string)
			local shown = filteredOptions(query)
			-- Clear old rows.
			for _, child in ipairs(listFrame:GetChildren()) do
				if child:IsA("TextButton") or child:IsA("TextLabel") then
					child:Destroy()
				end
			end
			local y = 0
			for _, opt in ipairs(shown) do
				y += 1
				local selected = isSelected(opt)
				local optBtn = el("TextButton", {
					Name = "Option",
					Text = "",
					AutoButtonColor = false,
					Size = UDim2.new(1, 0, 0, OPTION_H),
					LayoutOrder = y,
					BackgroundColor3 = c3(tokens.bg2),
					BorderSizePixel = 0,
				}, listFrame)
				if multi then
					local box = el("Frame", {
						Name = "Box",
						AnchorPoint = Vector2.new(0, 0.5),
						Position = UDim2.new(0, 8, 0.5, 0),
						Size = UDim2.new(0, 14, 0, 14),
						BackgroundColor3 = selected and c3(tokens.accent) or c3(tokens.bg3),
						BorderSizePixel = 0,
					}, optBtn)
					corner(box, 3)
					if selected then
						el("TextLabel", {
							BackgroundTransparency = 1,
							Size = UDim2.fromScale(1, 1),
							Font = fontOf("fontBold"),
							TextSize = 10,
							TextColor3 = c3(tokens.accentText),
							Text = CHECK,
						}, box)
					end
					el("TextLabel", {
						BackgroundTransparency = 1,
						Position = UDim2.new(0, 28, 0, 0),
						Size = UDim2.new(1, -36, 1, 0),
						Font = fontOf("fontRegular"),
						TextSize = 12,
						TextXAlignment = Enum.TextXAlignment.Left,
						TextColor3 = c3(selected and tokens.text or tokens.textDim),
						TextTruncate = Enum.TextTruncate.AtEnd,
						Text = opt,
					}, optBtn)
				else
					el("TextLabel", {
						BackgroundTransparency = 1,
						Position = UDim2.new(0, 8, 0, 0),
						Size = UDim2.new(1, -32, 1, 0),
						Font = fontOf("fontRegular"),
						TextSize = 12,
						TextXAlignment = Enum.TextXAlignment.Left,
						TextColor3 = c3(selected and tokens.accent or tokens.text),
						TextTruncate = Enum.TextTruncate.AtEnd,
						Text = opt,
					}, optBtn)
					if selected then
						el("TextLabel", {
							BackgroundTransparency = 1,
							AnchorPoint = Vector2.new(1, 0.5),
							Position = UDim2.new(1, -8, 0.5, 0),
							Size = UDim2.new(0, 16, 0, 16),
							Font = fontOf("fontBold"),
							TextSize = 12,
							TextColor3 = c3(tokens.accent),
							Text = CHECK,
						}, optBtn)
					end
				end
				local captured = opt
				trackPopup(optBtn.MouseButton1Click:Connect(function()
					choose(captured)
					if multi and open then
						-- Re-render in place for multi (stays open),
						-- preserving the current filter text.
						local f = ""
						local fb = card:FindFirstChild("Filter")
						if fb ~= nil then
							f = fb.Text
						end
						renderOptions(f)
					end
				end))
				trackPopup(optBtn.MouseEnter:Connect(function()
					tween(optBtn, { BackgroundColor3 = c3(tokens.bg3) }, 0.08)
				end))
				trackPopup(optBtn.MouseLeave:Connect(function()
					tween(optBtn, { BackgroundColor3 = c3(tokens.bg2) }, 0.08)
				end))
			end
			emptyLabel.Visible = #shown == 0
			listFrame.CanvasSize = UDim2.new(0, 0, 0, math.max(#shown, 1) * OPTION_H)
		end

		-- Popup card (sized after measuring; rebuilt height on filter).
		local bx = button.AbsolutePosition.X
		local by = button.AbsolutePosition.Y + button.AbsoluteSize.Y + 4
		card = el("Frame", {
			Name = "Card",
			Position = UDim2.fromOffset(bx, by),
			Size = UDim2.fromOffset(listW, 200),
			BackgroundColor3 = c3(tokens.overlay),
			BorderSizePixel = 0,
			ZIndex = 201,
			ClipsDescendants = true,
		}, popupRoot)
		corner(card, tokens.radiusMd)
		stroke(card, tokens.borderStrong)

		local cursorY = 4
		if enableSearch then
			local filter = el("TextBox", {
				Name = "Filter",
				Position = UDim2.fromOffset(4, 4),
				Size = UDim2.new(1, -8, 0, 28),
				BackgroundColor3 = c3(tokens.bg2),
				BorderSizePixel = 0,
				Font = fontOf("fontRegular"),
				TextSize = 12,
				TextXAlignment = Enum.TextXAlignment.Left,
				TextColor3 = c3(tokens.text),
				PlaceholderText = "Filter...",
				PlaceholderColor3 = c3(tokens.textFaint),
				Text = "",
				ClearTextOnFocus = false,
				ZIndex = 202,
			}, card)
			corner(filter, tokens.radiusSm)
			trackPopup(filter:GetPropertyChangedSignal("Text"):Connect(function()
				renderOptions(filter.Text)
				sizeCard()
			end))
			cursorY = 36
		end

		listFrame = el("ScrollingFrame", {
			Name = "List",
			Position = UDim2.new(0, 4, 0, cursorY),
			Size = UDim2.new(1, -8, 0, 100),
			BackgroundTransparency = 1,
			BorderSizePixel = 0,
			ScrollBarThickness = 6,
			CanvasSize = UDim2.new(0, 0, 0, 0),
			ZIndex = 202,
		}, card)
		vlist(listFrame, 0)
		-- Parented to the card (NOT the scrolling list) so it never
		-- disturbs layout when hidden.
		emptyLabel = el("TextLabel", {
			Name = "Empty",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 4, 0, cursorY),
			Size = UDim2.new(1, -8, 0, OPTION_H),
			Font = fontOf("fontRegular"),
			TextSize = 12,
			TextColor3 = c3(tokens.textFaint),
			Text = "No matches",
			Visible = false,
			ZIndex = 203,
		}, card)

		local footer: any = nil
		if multi then
			footer = el("Frame", {
				Name = "Footer",
				BackgroundTransparency = 1,
				Size = UDim2.new(1, 0, 0, 28),
				ZIndex = 202,
			}, card)
			local allBtn = el("TextButton", {
				Text = "All",
				AutoButtonColor = false,
				Size = UDim2.new(0.5, -6, 1, -4),
				Position = UDim2.new(0, 4, 0, 2),
				BackgroundColor3 = c3(tokens.bg2),
				BorderSizePixel = 0,
				Font = fontOf("fontMedium"),
				TextSize = 11,
				TextColor3 = c3(tokens.textDim),
				ZIndex = 203,
			}, footer)
			corner(allBtn, tokens.radiusSm)
			local noneBtn = el("TextButton", {
				Text = "None",
				AutoButtonColor = false,
				Size = UDim2.new(0.5, -6, 1, -4),
				Position = UDim2.new(0.5, 2, 0, 2),
				BackgroundColor3 = c3(tokens.bg2),
				BorderSizePixel = 0,
				Font = fontOf("fontMedium"),
				TextSize = 11,
				TextColor3 = c3(tokens.textDim),
				ZIndex = 203,
			}, footer)
			corner(noneBtn, tokens.radiusSm)
			trackPopup(allBtn.MouseButton1Click:Connect(function()
				local all: { string } = {}
				for _, opt in ipairs(options) do
					if maxSelect == nil or #all < (maxSelect :: number) then
						table.insert(all, opt)
					end
				end
				h._value = all
				renderButton()
				renderOptions("")
				h:_fire(all)
			end))
			trackPopup(noneBtn.MouseButton1Click:Connect(function()
				local none: { string } = {}
				h._value = none
				renderButton()
				renderOptions("")
				h:_fire(none)
			end))
		end

		sizeCard = function()
			if popupRoot == nil or card == nil then
				return
			end
			-- Measure from the rendered rows (CanvasSize was set by renderOptions).
			local rows = #filteredOptions("")
			local filterText = ""
			local filterBox = card:FindFirstChild("Filter")
			if filterBox ~= nil then
				filterText = filterBox.Text
				rows = #filteredOptions(filterText)
			end
			local visibleRows = math.clamp(math.max(rows, 1), 1, 6)
			local listH = visibleRows * OPTION_H
			listFrame.Size = UDim2.new(1, -8, 0, listH)
			local total = searchH + listH + footerH + 8
			if footer ~= nil then
				footer.Position = UDim2.new(0, 0, 0, searchH + listH + 4)
			end
			card.Size = UDim2.fromOffset(listW, total)
			-- Flip upward when there is no room below.
			local oy = button.AbsolutePosition.Y + button.AbsoluteSize.Y + 4
			local viewH = overlay.AbsoluteSize.Y
			if viewH > 0 and oy + total > viewH then
				oy = button.AbsolutePosition.Y - 4 - total
			end
			card.Position = UDim2.fromOffset(button.AbsolutePosition.X, oy)
		end

		renderOptions("")
		sizeCard()
		renderButton()
	end

	h:_track(button.MouseButton1Click:Connect(function()
		if h._dead or not enabled then
			return
		end
		if open then
			close()
		else
			openPopup()
		end
	end))
	h:_track(s.uis.InputBegan:Connect(function(input: any)
		if open and not h._dead and input.KeyCode == Enum.KeyCode.Escape then
			close()
		end
	end))

	function h.set(self: any, v: any)
		if self._dead then
			return
		end
		if multi then
			if type(v) ~= "table" then
				return
			end
			-- Keep only known options, order preserved.
			local out: { string } = {}
			for _, item in ipairs(v) do
				for _, opt in ipairs(options) do
					if type(item) == "string" and opt == item then
						table.insert(out, item)
						break
					end
				end
			end
			self._value = out
		else
			if type(v) ~= "string" then
				return
			end
			local known = false
			for _, opt in ipairs(options) do
				if opt == v then
					known = true
					break
				end
			end
			if not known then
				return
			end
			self._value = v
		end
		if open then
			close()
		end
		renderButton()
	end
	function h.enable(self: any, on: boolean?)
		enabled = on ~= false
		if not enabled and open then
			close()
		end
		local dim = enabled and 0 or 0.55
		if lab ~= nil then
			lab.TextTransparency = dim
		end
		if desc ~= nil then
			desc.TextTransparency = dim
		end
		button.BackgroundTransparency = enabled and 0 or 0.5
		buttonText.TextTransparency = dim
		chev.TextTransparency = dim
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		if open then
			close() -- popup rebuilds with fresh tokens on next open
		end
		if lab ~= nil then
			lab.TextColor3 = c3(tokens.text)
		end
		if desc ~= nil then
			desc.TextColor3 = c3(tokens.textDim)
		end
		button.BackgroundColor3 = c3(tokens.bg2)
		buttonText.TextColor3 = c3(tokens.text)
		chev.TextColor3 = c3(tokens.textDim)
	end
	h._onDestroy = close
	if props.onChanged ~= nil then
		h:onChanged(props.onChanged)
	end
	if props.disabled then
		h:enable(false)
	end
	-- Normalize the initial value through the same guards as set().
	local seed = h._value
	h._value = multi and {} or ""
	h:set(seed)
	return h
end

-- ============================================================================
-- Keybind
-- ============================================================================

function Widgets.Keybind(props: any, parent: any): any
	props = props or {}
	local allowMouse = props.allowMouse ~= false
	local tokens = Theme.current()
	local s = services()

	local row, lab, desc = makeRow(parent, props.label or "Keybind", props.description, 138)
	local button = el("TextButton", {
		Name = "Button",
		Text = "",
		AutoButtonColor = false,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, 0, 0.5, 0),
		Size = UDim2.new(0, 130, 0, 26),
		BackgroundColor3 = c3(tokens.bg2),
		BorderSizePixel = 0,
	}, row)
	corner(button, tokens.radiusSm)
	stroke(button, tokens.border)
	local buttonText = el("TextLabel", {
		Name = "Text",
		BackgroundTransparency = 1,
		Size = UDim2.fromScale(1, 1),
		Font = fontOf("fontMedium"),
		TextSize = 12,
		TextColor3 = c3(tokens.text),
		TextTruncate = Enum.TextTruncate.AtEnd,
		Text = "None",
	}, button)

	local h = withValue(baseHandle(row), props.value or "None")
	local enabled = props.disabled ~= true
	local listening = false

	local function render()
		if listening then
			buttonText.Text = "..."
			buttonText.TextTransparency = 0
			local bs = button:FindFirstChildOfClass("UIStroke")
			if bs ~= nil then
				bs.Color = c3(tokens.accent)
			end
		else
			local v = h._value
			buttonText.Text = v
			buttonText.TextTransparency = (v == "None" or v == "") and 0.45 or 0
			local bs = button:FindFirstChildOfClass("UIStroke")
			if bs ~= nil then
				bs.Color = c3(tokens.border)
			end
		end
	end

	local function stopListen()
		listening = false
		render()
	end

	h:_track(button.MouseButton1Click:Connect(function()
		if h._dead or not enabled then
			return
		end
		listening = true
		render()
	end))

	h:_track(s.uis.InputBegan:Connect(function(input: any, gameProcessed: boolean?)
		if h._dead or not listening then
			return
		end
		if gameProcessed then
			return
		end
		local kc = input.KeyCode
		if kc == Enum.KeyCode.Escape then
			stopListen() -- cancel, keep old value
			return
		end
		if kc == Enum.KeyCode.Backspace or kc == Enum.KeyCode.Delete then
			h._value = "None"
			stopListen()
			h:_fire("None")
			return
		end
		if kc ~= nil and kc ~= Enum.KeyCode.Unknown then
			h._value = kc.Name
			stopListen()
			h:_fire(kc.Name)
			return
		end
		-- Mouse buttons arrive with KeyCode.Unknown; bind by input type.
		if allowMouse then
			local t = input.UserInputType
			if t == Enum.UserInputType.MouseButton1
				or t == Enum.UserInputType.MouseButton2
				or t == Enum.UserInputType.MouseButton3
			then
				h._value = t.Name
				stopListen()
				h:_fire(t.Name)
			end
		end
	end))

	function h.set(self: any, v: any)
		if self._dead or type(v) ~= "string" then
			return
		end
		if listening then
			stopListen()
		end
		self._value = v
		render()
	end
	function h.isListening(self: any): boolean
		return listening
	end
	function h.enable(self: any, on: boolean?)
		enabled = on ~= false
		if not enabled and listening then
			stopListen()
		end
		local dim = enabled and 0 or 0.55
		if lab ~= nil then
			lab.TextTransparency = dim
		end
		if desc ~= nil then
			desc.TextTransparency = dim
		end
		button.BackgroundTransparency = enabled and 0 or 0.5
		buttonText.TextTransparency = dim
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		if lab ~= nil then
			lab.TextColor3 = c3(tokens.text)
		end
		if desc ~= nil then
			desc.TextColor3 = c3(tokens.textDim)
		end
		button.BackgroundColor3 = c3(tokens.bg2)
		buttonText.TextColor3 = c3(tokens.text)
		render()
	end
	if props.onChanged ~= nil then
		h:onChanged(props.onChanged)
	end
	if props.disabled then
		h:enable(false)
	end
	render()
	return h
end

-- ============================================================================
-- Textbox
-- ============================================================================

function Widgets.Textbox(props: any, parent: any): any
	props = props or {}
	local onCommitCb = props.onCommit
	local commitOn = props.commitOn or "focus" -- "focus" | "enter"
	local tokens = Theme.current()

	local hasLabel = props.label ~= nil
	local rowH = hasLabel and 52 or 30
	local row = el("Frame", {
		Name = "Row",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, rowH),
	}, parent)
	if hasLabel then
		el("TextLabel", {
			Name = "Label",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 0, 0, 0),
			Size = UDim2.new(1, 0, 0, 18),
			Font = fontOf("fontMedium"),
			TextSize = 13,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextColor3 = c3(tokens.text),
			TextTruncate = Enum.TextTruncate.AtEnd,
			Text = props.label,
		}, row)
	end
	local box = el("TextBox", {
		Name = "Box",
		Position = UDim2.new(0, 0, 0, hasLabel and 20 or 0),
		Size = UDim2.new(1, 0, 0, 30),
		BackgroundColor3 = c3(tokens.bg2),
		BorderSizePixel = 0,
		Font = fontOf(props.mono and "fontMono" or "fontRegular"),
		TextSize = 12,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextColor3 = c3(tokens.text),
		PlaceholderText = props.placeholder or "",
		PlaceholderColor3 = c3(tokens.textFaint),
		Text = props.value or "",
		ClearTextOnFocus = props.clearOnFocus ~= false,
	}, row)
	corner(box, tokens.radiusSm)
	stroke(box, tokens.border)
	pad(box, 0)
	local inner = box:FindFirstChildOfClass("UIPadding")
	inner.PaddingLeft = UDim.new(0, 8)
	inner.PaddingRight = UDim.new(0, 8)

	local h = withValue(baseHandle(row), props.value or "")
	local enabled = props.disabled ~= true
	local selfSet = false

	h:_track(box:GetPropertyChangedSignal("Text"):Connect(function()
		if h._dead or selfSet then
			return
		end
		h._value = box.Text
		h:_fire(box.Text) -- live keystroke updates via onChanged
	end))
	h:_track(box.FocusLost:Connect(function(enterPressed: boolean)
		if h._dead then
			return
		end
		h._value = box.Text
		if commitOn == "enter" and not enterPressed then
			return
		end
		if onCommitCb ~= nil then
			onCommitCb(box.Text)
		end
	end))

	function h.set(self: any, v: any)
		if self._dead or type(v) ~= "string" then
			return
		end
		self._value = v
		selfSet = true
		box.Text = v
		selfSet = false
	end
	function h.enable(self: any, on: boolean?)
		enabled = on ~= false
		box.TextEditable = enabled
		box.BackgroundTransparency = enabled and 0 or 0.5
		box.TextTransparency = enabled and 0 or 0.55
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		box.BackgroundColor3 = c3(tokens.bg2)
		box.TextColor3 = c3(tokens.text)
		box.PlaceholderColor3 = c3(tokens.textFaint)
		local bs = box:FindFirstChildOfClass("UIStroke")
		if bs ~= nil then
			bs.Color = c3(tokens.border)
		end
	end
	if props.onChanged ~= nil then
		h:onChanged(props.onChanged)
	end
	if props.disabled then
		h:enable(false)
	end
	return h
end

-- ============================================================================
-- ColorField (swatch button; opens an injected picker module)
-- ============================================================================

function Widgets.ColorField(props: any, parent: any): any
	props = props or {}
	local onCommitCb = props.onCommit
	local pickerModule = props.picker
	assert(pickerModule ~= nil, "ColorField requires props.picker (ColorPicker module)")
	local overlay = props.overlay
	assert(overlay ~= nil, "ColorField requires props.overlay (popup layer)")
	local tokens = Theme.current()

	local row, lab, desc = makeRow(parent, props.label or "Color", props.description, 158)
	local hexLabel = el("TextLabel", {
		Name = "Hex",
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -64, 0.5, 0),
		Size = UDim2.new(0, 86, 0, 18),
		Font = fontOf("fontMono"),
		TextSize = 11,
		TextXAlignment = Enum.TextXAlignment.Right,
		TextColor3 = c3(tokens.textDim),
		Text = "",
	}, row)
	local swatch = el("TextButton", {
		Name = "Swatch",
		Text = "",
		AutoButtonColor = false,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, 0, 0.5, 0),
		Size = UDim2.new(0, 56, 0, 22),
		BackgroundColor3 = Color3.fromRGB(127, 127, 127), -- mid grey reveals alpha
		BorderSizePixel = 0,
	}, row)
	corner(swatch, tokens.radiusSm)
	stroke(swatch, tokens.border)
	local swatchFill = el("Frame", {
		Name = "Fill",
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = Color3.fromRGB(255, 255, 255),
		BorderSizePixel = 0,
	}, swatch)
	corner(swatchFill, tokens.radiusSm)

	local h = withValue(baseHandle(row), props.value or { h = 0, s = 0, v = 1, a = 1 })
	local enabled = props.disabled ~= true
	local picker: any = nil

	local function render()
		local v = h._value
		local r, g, b = Color.hsvToRgb(v.h or 0, v.s or 0, v.v or 1)
		local ir, ig, ib = Color.toRGB255(r, g, b)
		swatchFill.BackgroundColor3 = Color3.fromRGB(ir, ig, ib)
		swatchFill.BackgroundTransparency = 1 - (v.a == nil and 1 or v.a)
		local hex = Color.toHex(r, g, b)
		if v.a ~= nil and v.a < 0.999 then
			hex ..= " " .. tostring(math.floor(v.a * 100 + 0.5)) .. "%"
		end
		hexLabel.Text = hex
	end

	local function closePicker()
		if picker ~= nil then
			pcall(function()
				picker:destroy()
			end)
			picker = nil
		end
	end

	h:_track(swatch.MouseButton1Click:Connect(function()
		if h._dead or not enabled then
			return
		end
		if picker ~= nil then
			closePicker()
			return
		end
		picker = pickerModule.new({
			value = h:get(),
			overlay = overlay,
			source = swatch,
			onChanged = function(v: any)
				if h._dead then
					return
				end
				h._value = Util.deepCopy(v)
				render()
				h:_fire(v)
			end,
			onCommit = function(v: any)
				if h._dead then
					return
				end
				h._value = Util.deepCopy(v)
				render()
				if onCommitCb ~= nil then
					onCommitCb(Util.deepCopy(v))
				end
			end,
			onClose = function()
				picker = nil
			end,
		})
		picker:open()
	end))

	function h.set(self: any, v: any)
		if self._dead or type(v) ~= "table" then
			return
		end
		self._value = Util.deepCopy(v)
		render()
		if picker ~= nil then
			picker:set(Util.deepCopy(v))
		end
	end
	function h.isOpen(self: any): boolean
		return picker ~= nil
	end
	function h.enable(self: any, on: boolean?)
		enabled = on ~= false
		if not enabled then
			closePicker()
		end
		local dim = enabled and 0 or 0.55
		if lab ~= nil then
			lab.TextTransparency = dim
		end
		if desc ~= nil then
			desc.TextTransparency = dim
		end
		hexLabel.TextTransparency = dim
		swatch.BackgroundTransparency = enabled and 0 or 0.5
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		if lab ~= nil then
			lab.TextColor3 = c3(tokens.text)
		end
		if desc ~= nil then
			desc.TextColor3 = c3(tokens.textDim)
		end
		hexLabel.TextColor3 = c3(tokens.textDim)
	end
	h._onDestroy = closePicker
	if props.onChanged ~= nil then
		h:onChanged(props.onChanged)
	end
	if props.disabled then
		h:enable(false)
	end
	render()
	return h
end

-- ============================================================================
-- Button / Label / Divider
-- ============================================================================

function Widgets.Button(props: any, parent: any): any
	props = props or {}
	local onClickCb = props.onClick
	local variant = props.variant or "primary" -- primary | ghost | danger
	local tokens = Theme.current()

	local row = el("Frame", {
		Name = "Row",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, props.height or 32),
	}, parent)
	local button = el("TextButton", {
		Name = "Button",
		Text = props.text or "Button",
		AutoButtonColor = false,
		Size = UDim2.fromScale(1, 1),
		BorderSizePixel = 0,
		Font = fontOf("fontMedium"),
		TextSize = 13,
	}, row)
	corner(button, tokens.radiusSm)
	local border: any = nil
	if variant ~= "primary" then
		border = stroke(button, variant == "danger" and tokens.danger or tokens.border)
	end

	local h = baseHandle(row)
	local enabled = props.disabled ~= true

	local function paint()
		if variant == "primary" then
			button.BackgroundColor3 = c3(tokens.accent)
			button.TextColor3 = c3(tokens.accentText)
		elseif variant == "danger" then
			button.BackgroundColor3 = c3(tokens.bg2)
			button.TextColor3 = c3(tokens.danger)
		else
			button.BackgroundColor3 = c3(tokens.bg2)
			button.TextColor3 = c3(tokens.text)
		end
		if border ~= nil then
			border.Color = variant == "danger" and c3(tokens.danger) or c3(tokens.border)
		end
		button.BackgroundTransparency = enabled and 0 or 0.5
		button.TextTransparency = enabled and 0 or 0.5
	end

	h:_track(button.MouseButton1Click:Connect(function()
		if h._dead or not enabled then
			return
		end
		tween(button, { BackgroundTransparency = 0.35 }, 0.06)
		if onClickCb ~= nil then
			onClickCb()
		end
	end))
	h:_track(button.MouseEnter:Connect(function()
		if not enabled or h._dead then
			return
		end
		if variant == "primary" then
			tween(button, { BackgroundColor3 = c3(Theme.mix(tokens.accent, "#FFFFFF", 0.12)) }, 0.1)
		else
			tween(button, { BackgroundColor3 = c3(tokens.bg3) }, 0.1)
		end
	end))
	h:_track(button.MouseLeave:Connect(function()
		if not enabled or h._dead then
			return
		end
		paint()
	end))

	function h.setText(self: any, text: string)
		button.Text = text
	end
	function h.enable(self: any, on: boolean?)
		enabled = on ~= false
		paint()
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		paint()
	end
	if props.disabled then
		h:enable(false)
	end
	paint()
	return h
end

function Widgets.Label(props: any, parent: any): any
	props = props or {}
	local tokens = Theme.current()
	local row = el("Frame", {
		Name = "Row",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 22),
	}, parent)
	local text = el("TextLabel", {
		Name = "Label",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, -16, 1, 0),
		Font = fontOf("fontBold"),
		TextSize = 11,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextColor3 = c3(tokens.textDim),
		Text = string.upper(props.text or ""),
	}, row)
	local line = el("Frame", {
		Name = "Line",
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, 0, 0.5, 0),
		Size = UDim2.new(0, 12, 0, 1),
		BackgroundColor3 = c3(tokens.border),
		BorderSizePixel = 0,
	}, row)
	local h = baseHandle(row)
	function h.setText(self: any, t: string)
		text.Text = string.upper(t)
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		text.TextColor3 = c3(tokens.textDim)
		line.BackgroundColor3 = c3(tokens.border)
	end
	return h
end

function Widgets.Divider(_props: any?, parent: any): any
	local tokens = Theme.current()
	local row = el("Frame", {
		Name = "Row",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 9),
	}, parent)
	local line = el("Frame", {
		Name = "Line",
		AnchorPoint = Vector2.new(0, 0.5),
		Position = UDim2.new(0, 0, 0.5, 0),
		Size = UDim2.new(1, 0, 0, 1),
		BackgroundColor3 = c3(tokens.border),
		BorderSizePixel = 0,
	}, row)
	local h = baseHandle(row)
	function h._refresh(self: any)
		tokens = Theme.current()
		line.BackgroundColor3 = c3(tokens.border)
	end
	return h
end

-- ============================================================================
-- Section (collapsible card)
-- ============================================================================

function Widgets.Section(props: any, parent: any): any
	props = props or {}
	local onToggleCb = props.onToggle
	local tokens = Theme.current()

	local card = el("Frame", {
		Name = "Section",
		BackgroundColor3 = c3(tokens.bg1),
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
	}, parent)
	corner(card, tokens.radiusMd)
	stroke(card, tokens.border)
	vlist(card, 0)

	local header = el("TextButton", {
		Name = "Header",
		Text = "",
		AutoButtonColor = false,
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, props.hint and 46 or 36),
		LayoutOrder = 1,
	}, card)
	local title = el("TextLabel", {
		Name = "Title",
		BackgroundTransparency = 1,
		Position = UDim2.new(0, 12, 0, 6),
		Size = UDim2.new(1, -48, 0, 16),
		Font = fontOf("fontBold"),
		TextSize = 13,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextColor3 = c3(tokens.text),
		TextTruncate = Enum.TextTruncate.AtEnd,
		Text = props.title or "Section",
	}, header)
	local hint: any = nil
	if props.hint then
		hint = el("TextLabel", {
			Name = "Hint",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 12, 0, 23),
			Size = UDim2.new(1, -48, 0, 14),
			Font = fontOf("fontRegular"),
			TextSize = 11,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextColor3 = c3(tokens.textDim),
			TextTruncate = Enum.TextTruncate.AtEnd,
			Text = props.hint,
		}, header)
	end
	local chev = el("TextLabel", {
		Name = "Chevron",
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -12, 0, 18),
		Size = UDim2.new(0, 16, 0, 16),
		Font = fontOf("fontRegular"),
		TextSize = 11,
		TextColor3 = c3(tokens.textDim),
		Text = CHEV_UP,
	}, header)

	local body = el("Frame", {
		Name = "Body",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		LayoutOrder = 2,
	}, card)
	vlist(body, 6)
	pad(body, 12)

	local h = baseHandle(card)
	local collapsed = props.collapsed == true

	local function render()
		body.Visible = not collapsed
		chev.Text = collapsed and CHEV_DOWN or CHEV_UP
	end
	h:_track(header.MouseButton1Click:Connect(function()
		if h._dead then
			return
		end
		collapsed = not collapsed
		render()
		if onToggleCb ~= nil then
			onToggleCb(collapsed)
		end
	end))

	function h.content(self: any): any
		return body
	end
	function h.setCollapsed(self: any, v: boolean)
		collapsed = v == true
		render()
	end
	function h.isCollapsed(self: any): boolean
		return collapsed
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		card.BackgroundColor3 = c3(tokens.bg1)
		title.TextColor3 = c3(tokens.text)
		if hint ~= nil then
			hint.TextColor3 = c3(tokens.textDim)
		end
		chev.TextColor3 = c3(tokens.textDim)
		local bs = card:FindFirstChildOfClass("UIStroke")
		if bs ~= nil then
			bs.Color = c3(tokens.border)
		end
	end
	render()
	return h
end

-- ============================================================================
-- Searchbox
-- ============================================================================

function Widgets.Searchbox(props: any, parent: any): any
	props = props or {}
	local tokens = Theme.current()

	local row = el("Frame", {
		Name = "Row",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 30),
	}, parent)
	local box = el("TextBox", {
		Name = "Box",
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = c3(tokens.bg2),
		BorderSizePixel = 0,
		Font = fontOf("fontRegular"),
		TextSize = 12,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextColor3 = c3(tokens.text),
		PlaceholderText = props.placeholder or "Search settings...",
		PlaceholderColor3 = c3(tokens.textFaint),
		Text = props.value or "",
		ClearTextOnFocus = false,
	}, row)
	corner(box, tokens.radiusSm)
	stroke(box, tokens.border)
	pad(box, 0)
	local inner = box:FindFirstChildOfClass("UIPadding")
	inner.PaddingLeft = UDim.new(0, 10)
	inner.PaddingRight = UDim.new(0, 30)
	local clearBtn = el("TextButton", {
		Name = "Clear",
		Text = "×",
		AutoButtonColor = false,
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -4, 0.5, 0),
		Size = UDim2.new(0, 22, 0, 22),
		Font = fontOf("fontRegular"),
		TextSize = 14,
		TextColor3 = c3(tokens.textDim),
		Visible = false,
	}, row)

	local h = withValue(baseHandle(row), props.value or "")
	local selfSet = false

	local function renderClear()
		clearBtn.Visible = h._value ~= ""
	end
	h:_track(box:GetPropertyChangedSignal("Text"):Connect(function()
		if h._dead or selfSet then
			return
		end
		h._value = box.Text
		renderClear()
		h:_fire(box.Text)
	end))
	h:_track(clearBtn.MouseButton1Click:Connect(function()
		if h._dead then
			return
		end
		selfSet = true
		box.Text = ""
		selfSet = false
		h._value = ""
		renderClear()
		h:_fire("")
	end))

	function h.set(self: any, v: any)
		if self._dead or type(v) ~= "string" then
			return
		end
		self._value = v
		selfSet = true
		box.Text = v
		selfSet = false
		renderClear()
	end
	function h._refresh(self: any)
		tokens = Theme.current()
		box.BackgroundColor3 = c3(tokens.bg2)
		box.TextColor3 = c3(tokens.text)
		box.PlaceholderColor3 = c3(tokens.textFaint)
		clearBtn.TextColor3 = c3(tokens.textDim)
	end
	if props.onChanged ~= nil then
		h:onChanged(props.onChanged)
	end
	renderClear()
	return h
end

return Widgets
