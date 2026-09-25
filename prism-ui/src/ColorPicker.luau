--!strict
-- ============================================================================
--  PRISM-UI · ColorPicker
-- ----------------------------------------------------------------------------
--  A premium 2D HSV picker rendered with ZERO image assets:
--    * Saturation/Value canvas: 25 horizontal rows, each a white→hue gradient
--      pre-multiplied by its row's V (no UIGradient rotation tricks, so the
--      math is exact and identical on every client).
--    * Hue, brightness and alpha strips: pure UIGradient sliders.
--    * Split old/new preview, hex box (RGB + RGBA), curated palette rows.
--
--  Lifecycle: `ColorPicker.new(props)` stages the value; `:open()` builds
--  into `props.overlay` anchored near `props.source`; `:close()` tears the
--  popup down (values persist); `:destroy()` closes permanently.
--  `onChanged` fires live during drags; `onCommit` fires on drag release,
--  hex commit and palette clicks; `onClose` fires whenever the popup closes.
--
--  Values are { h, s, v, a } float tables (the Schema "color" shape).
-- ============================================================================

local Color = require("./Color")
local Theme = require("./Theme")
local Util = require("./Util")

local ColorPicker = {}

-- ---------------------------------------------------------------------------
-- Local engine helpers (mirrors Widgets; kept local to avoid a dependency)
-- ---------------------------------------------------------------------------

local cachedServices: any = nil

local function services(): any
	if cachedServices == nil then
		local g = game
		local tweenSvc = g:GetService("TweenService")
		local uis = g:GetService("UserInputService")
		cachedServices = { tween = tweenSvc, uis = uis }
	end
	return cachedServices
end

local function c3(hex: string): any
	local parsed = Color.fromHex(hex)
	assert(parsed ~= nil, "ColorPicker: invalid hex")
	local cc = parsed :: Color.RGBA
	local r, g, b = Color.toRGB255(cc.r, cc.g, cc.b)
	return Color3.fromRGB(r, g, b)
end

local function c3rgb(r: number, g: number, b: number): any
	local ir, ig, ib = Color.toRGB255(r, g, b)
	return Color3.fromRGB(ir, ig, ib)
end

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

-- ---------------------------------------------------------------------------
-- Picker
-- ---------------------------------------------------------------------------

local CARD_W = 264
local CONTENT_W = 248 -- card minus 2x8 padding
local SV_H = 150
local SV_ROWS = 25
local STRIP_H = 14
local SWATCH = 20

function ColorPicker.new(props: any): any
	props = props or {}
	local onChangedCb = props.onChanged
	local onCommitCb = props.onCommit
	local onCloseCb = props.onClose
	local overlay = props.overlay
	assert(overlay ~= nil, "ColorPicker requires props.overlay")
	local value = Util.deepCopy(props.value or { h = 0, s = 0, v = 1, a = 1 })
	local tokens = Theme.current()

	local picker: any = {
		_conns = {},
		_open = false,
		_dead = false,
	}
	local root: any = nil -- popup root (exists only while open)
	local nodes: { [string]: any } = {} -- named live nodes, rebuilt per open
	local lastHueRendered = -1
	local lastStripRendered = ""

	local function track(conn: any)
		table.insert(picker._conns, conn)
		return conn
	end

	function picker.get(self: any): any
		return Util.deepCopy(value)
	end

	function picker.set(self: any, v: any)
		if self._dead or type(v) ~= "table" then
			return
		end
		value = {
			h = Color.wrapHue(v.h or 0),
			s = Color.clamp01(v.s == nil and 1 or v.s),
			v = Color.clamp01(v.v == nil and 1 or v.v),
			a = Color.clamp01(v.a == nil and 1 or v.a),
		}
		if self._open then
			self:_render()
		end
	end

	function picker.isOpen(self: any): boolean
		return self._open
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- render --
	function picker._render(self: any)
		if root == nil then
			return
		end
		local h, s, v, a = value.h, value.s, value.v, value.a
		-- SV cursor.
		if nodes.svCursor ~= nil then
			nodes.svCursor.Position = UDim2.new(s, 0, 1 - v, 0)
		end
		-- Strip cursors.
		if nodes.hueCursor ~= nil then
			nodes.hueCursor.Position = UDim2.new(h, 0, 0, -2)
		end
		if nodes.brightCursor ~= nil then
			nodes.brightCursor.Position = UDim2.new(v, 0, 0, -2)
		end
		if nodes.alphaCursor ~= nil then
			nodes.alphaCursor.Position = UDim2.new(a, 0, 0, -2)
		end
		-- SV rows depend ONLY on hue: rebuild gradients when it changes.
		local svRows = nodes.svRows
		if h ~= lastHueRendered and svRows ~= nil then
			lastHueRendered = h
			local hr, hg, hb = Color.hsvToRgb(h, 1, 1)
			for i, grad in ipairs(svRows) do
				local g: any = grad
				local vv = 1 - (i - 0.5) / SV_ROWS
				g.Color = ColorSequence.new({
					ColorSequenceKeypoint.new(0, c3rgb(vv, vv, vv)),
					ColorSequenceKeypoint.new(1, c3rgb(hr * vv, hg * vv, hb * vv)),
				})
			end
		end
		-- Brightness (black -> full H/S) and alpha strips.
		local stripKey = string.format("%.4f|%.4f|%.4f", h, s, v)
		if stripKey ~= lastStripRendered then
			lastStripRendered = stripKey
			local fr, fg, fb = Color.hsvToRgb(h, s, 1)
			if nodes.brightGrad ~= nil then
				nodes.brightGrad.Color = ColorSequence.new({
					ColorSequenceKeypoint.new(0, c3rgb(0, 0, 0)),
					ColorSequenceKeypoint.new(1, c3rgb(fr, fg, fb)),
				})
			end
			if nodes.alphaGrad ~= nil then
				local cr, cg, cb = Color.hsvToRgb(h, s, v)
				nodes.alphaGrad.Color = ColorSequence.new({
					ColorSequenceKeypoint.new(0, c3rgb(cr, cg, cb)),
					ColorSequenceKeypoint.new(1, c3rgb(cr, cg, cb)),
				})
			end
		end
		-- Preview + hex.
		if nodes.newSwatch ~= nil then
			local cr, cg, cb = Color.hsvToRgb(h, s, v)
			nodes.newSwatch.BackgroundColor3 = c3rgb(cr, cg, cb)
			nodes.newSwatch.BackgroundTransparency = 1 - a
		end
		if nodes.hexBox ~= nil and not nodes.hexTyping then
			local cr, cg, cb = Color.hsvToRgb(h, s, v)
			nodes.hexBox.Text = Color.toHexA(cr, cg, cb, a)
		end
	end

	local function fireChanged()
		if onChangedCb ~= nil then
			onChangedCb(Util.deepCopy(value))
		end
	end

	local function fireCommit()
		if onCommitCb ~= nil then
			onCommitCb(Util.deepCopy(value))
		end
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- open --
	function picker.open(self: any)
		if self._open or self._dead then
			return
		end
		self._open = true
		tokens = Theme.current()
		local s = services()
		lastHueRendered = -1
		lastStripRendered = ""
		nodes = {}

		root = el("Frame", {
			Name = "ColorPopup",
			BackgroundTransparency = 1,
			Size = UDim2.fromScale(1, 1),
			ZIndex = 300,
		}, overlay)
		local closer = el("TextButton", {
			Name = "Closer",
			Text = "",
			BackgroundTransparency = 1,
			AutoButtonColor = false,
			Size = UDim2.fromScale(1, 1),
			ZIndex = 300,
		}, root)
		track(closer.MouseButton1Click:Connect(function()
			self:close()
		end))

		-- Card height: pad + SV + hue + bright + alpha + footer + palettes.
		local paletteRows = 0
		for _ in pairs(Color.palettes) do
			paletteRows += 1
		end
		local cardH = 8 + SV_H + 8 + STRIP_H + 8 + STRIP_H + 8 + STRIP_H
			+ 10 + 30 + 10 + paletteRows * (SWATCH + 4) + 8
		local card = el("Frame", {
			Name = "Card",
			Size = UDim2.fromOffset(CARD_W, cardH),
			BackgroundColor3 = c3(tokens.overlay),
			BorderSizePixel = 0,
			ZIndex = 301,
			ClipsDescendants = true,
		}, root)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusMd) }, card)
		el("UIStroke", { Color = c3(tokens.borderStrong), Thickness = 1 }, card)

		-- Anchor near the source button; clamp into the viewport.
		local ax, ay = 0, 0
		if props.source ~= nil then
			ax = props.source.AbsolutePosition.X
			ay = props.source.AbsolutePosition.Y + props.source.AbsoluteSize.Y + 4
		else
			ax = (overlay.AbsoluteSize.X - CARD_W) / 2
			ay = (overlay.AbsoluteSize.Y - cardH) / 2
		end
		ax = Util.clamp(ax, 4, math.max(4, overlay.AbsoluteSize.X - CARD_W - 4))
		ay = Util.clamp(ay, 4, math.max(4, overlay.AbsoluteSize.Y - cardH - 4))
		-- Flip above the source when there is no room below.
		if props.source ~= nil then
			local below = props.source.AbsolutePosition.Y + props.source.AbsoluteSize.Y + 4
			if below + cardH > overlay.AbsoluteSize.Y
				and props.source.AbsolutePosition.Y - 4 - cardH >= 0
			then
				ay = props.source.AbsolutePosition.Y - 4 - cardH
			end
		end
		card.Position = UDim2.fromOffset(ax, ay)

		local y = 8
		local function panelX(): number
			return 8
		end

		-- -- SV canvas --
		local svBox = el("Frame", {
			Name = "SV",
			Position = UDim2.fromOffset(panelX(), y),
			Size = UDim2.fromOffset(CONTENT_W, SV_H),
			BackgroundColor3 = c3rgb(1, 1, 1),
			BorderSizePixel = 0,
			ZIndex = 302,
			ClipsDescendants = true,
		}, card)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, svBox)
		el("UIStroke", { Color = c3(tokens.border), Thickness = 1 }, svBox)
		nodes.svRows = {}
		local rowH = SV_H / SV_ROWS
		for i = 1, SV_ROWS do
			local rowFrame = el("Frame", {
				Position = UDim2.fromOffset(0, (i - 1) * rowH),
				Size = UDim2.fromOffset(CONTENT_W, rowH + 0.5), -- overlap avoids seams
				BackgroundColor3 = c3rgb(1, 1, 1),
				BorderSizePixel = 0,
				ZIndex = 302,
			}, svBox)
			local grad = el("UIGradient", {
				Color = ColorSequence.new({
					ColorSequenceKeypoint.new(0, c3rgb(1, 1, 1)),
					ColorSequenceKeypoint.new(1, c3rgb(1, 0, 0)),
				}),
			}, rowFrame)
			nodes.svRows[i] = grad
		end
		local svCursor = el("Frame", {
			Name = "SVCursor",
			AnchorPoint = Vector2.new(0.5, 0.5),
			Size = UDim2.fromOffset(14, 14),
			BackgroundTransparency = 1,
			ZIndex = 304,
		}, svBox)
		el("UICorner", { CornerRadius = UDim.new(1, 0) }, svCursor)
		el("UIStroke", { Color = c3rgb(1, 1, 1), Thickness = 2 }, svCursor)
		nodes.svCursor = svCursor
		local svGrab = el("TextButton", {
			Name = "SVGrab",
			Text = "",
			BackgroundTransparency = 1,
			AutoButtonColor = false,
			Size = UDim2.fromScale(1, 1),
			ZIndex = 303,
		}, svBox)
		y += SV_H + 8

		-- -- Hue strip (static rainbow) --
		local hueBox = el("Frame", {
			Name = "Hue",
			Position = UDim2.fromOffset(panelX(), y),
			Size = UDim2.fromOffset(CONTENT_W, STRIP_H),
			BackgroundColor3 = c3rgb(1, 1, 1),
			BorderSizePixel = 0,
			ZIndex = 302,
			ClipsDescendants = true,
		}, card)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, hueBox)
		el("UIGradient", {
			Color = ColorSequence.new({
				ColorSequenceKeypoint.new(0.00, c3rgb(1, 0, 0)),
				ColorSequenceKeypoint.new(1 / 6, c3rgb(1, 1, 0)),
				ColorSequenceKeypoint.new(2 / 6, c3rgb(0, 1, 0)),
				ColorSequenceKeypoint.new(3 / 6, c3rgb(0, 1, 1)),
				ColorSequenceKeypoint.new(4 / 6, c3rgb(0, 0, 1)),
				ColorSequenceKeypoint.new(5 / 6, c3rgb(1, 0, 1)),
				ColorSequenceKeypoint.new(1.00, c3rgb(1, 0, 0)),
			}),
		}, hueBox)
		local hueCursor = el("Frame", {
			Name = "HueCursor",
			AnchorPoint = Vector2.new(0.5, 0),
			Size = UDim2.fromOffset(4, STRIP_H + 4),
			BackgroundColor3 = c3rgb(1, 1, 1),
			BorderSizePixel = 0,
			ZIndex = 304,
		}, hueBox)
		el("UICorner", { CornerRadius = UDim.new(0, 2) }, hueCursor)
		nodes.hueCursor = hueCursor
		local hueGrab = el("TextButton", {
			Name = "HueGrab",
			Text = "",
			BackgroundTransparency = 1,
			AutoButtonColor = false,
			Position = UDim2.fromOffset(0, -3),
			Size = UDim2.new(1, 0, 0, STRIP_H + 6),
			ZIndex = 303,
		}, hueBox)
		y += STRIP_H + 8

		-- -- Brightness + alpha strips share one builder --
		local function makeStrip(name: string): (any, any, any, any)
			local box = el("Frame", {
				Name = name,
				Position = UDim2.fromOffset(panelX(), y),
				Size = UDim2.fromOffset(CONTENT_W, STRIP_H),
				BackgroundColor3 = name == "Alpha" and c3rgb(0.5, 0.5, 0.5) or c3rgb(0, 0, 0),
				BorderSizePixel = 0,
				ZIndex = 302,
				ClipsDescendants = true,
			}, card)
			el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, box)
			local grad: any = nil
			if name == "Alpha" then
				grad = el("UIGradient", {
					Color = ColorSequence.new({
						ColorSequenceKeypoint.new(0, c3rgb(1, 1, 1)),
						ColorSequenceKeypoint.new(1, c3rgb(1, 1, 1)),
					}),
					Transparency = NumberSequence.new({
						NumberSequenceKeypoint.new(0, 1),
						NumberSequenceKeypoint.new(1, 0),
					}),
				}, box)
			else
				grad = el("UIGradient", {
					Color = ColorSequence.new({
						ColorSequenceKeypoint.new(0, c3rgb(0, 0, 0)),
						ColorSequenceKeypoint.new(1, c3rgb(1, 1, 1)),
					}),
				}, box)
			end
			local cursor = el("Frame", {
				Name = name .. "Cursor",
				AnchorPoint = Vector2.new(0.5, 0),
				Size = UDim2.fromOffset(4, STRIP_H + 4),
				BackgroundColor3 = c3rgb(1, 1, 1),
				BorderSizePixel = 0,
				ZIndex = 304,
			}, box)
			el("UICorner", { CornerRadius = UDim.new(0, 2) }, cursor)
			local grab = el("TextButton", {
				Name = name .. "Grab",
				Text = "",
				BackgroundTransparency = 1,
				AutoButtonColor = false,
				Position = UDim2.fromOffset(0, -3),
				Size = UDim2.new(1, 0, 0, STRIP_H + 6),
				ZIndex = 303,
			}, box)
			y += STRIP_H + 8
			return box, grad, grab, cursor
		end

		local brightBox, brightGrad, brightGrab, brightCursor = makeStrip("Brightness")
		nodes.brightGrad = brightGrad
		nodes.brightCursor = brightCursor
		local alphaBox, alphaGrad, alphaGrab, alphaCursor = makeStrip("Alpha")
		nodes.alphaGrad = alphaGrad
		nodes.alphaCursor = alphaCursor

		-- -- Footer: old/new preview + hex --
		y += 2
		local oldSwatch = el("Frame", {
			Name = "OldSwatch",
			Position = UDim2.fromOffset(panelX(), y),
			Size = UDim2.fromOffset(40, 26),
			BackgroundColor3 = c3rgb(0.5, 0.5, 0.5),
			BorderSizePixel = 0,
			ZIndex = 302,
		}, card)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, oldSwatch)
		do
			local r, g, b = Color.hsvToRgb(value.h, value.s, value.v)
			local oldFill = el("Frame", {
				Size = UDim2.fromScale(1, 1),
				BackgroundColor3 = c3rgb(r, g, b),
				BackgroundTransparency = 1 - value.a,
				BorderSizePixel = 0,
			}, oldSwatch)
			el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, oldFill)
		end
		local newSwatchBase = el("Frame", {
			Name = "NewSwatchBase",
			Position = UDim2.fromOffset(panelX() + 44, y),
			Size = UDim2.fromOffset(40, 26),
			BackgroundColor3 = c3rgb(0.5, 0.5, 0.5),
			BorderSizePixel = 0,
			ZIndex = 302,
		}, card)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, newSwatchBase)
		local newSwatch = el("Frame", {
			Name = "NewSwatch",
			Size = UDim2.fromScale(1, 1),
			BackgroundColor3 = c3rgb(1, 1, 1),
			BorderSizePixel = 0,
			ZIndex = 303,
		}, newSwatchBase)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, newSwatch)
		nodes.newSwatch = newSwatch
		local hexBox = el("TextBox", {
			Name = "Hex",
			Position = UDim2.fromOffset(panelX() + 92, y),
			Size = UDim2.fromOffset(CONTENT_W - 92, 26),
			BackgroundColor3 = c3(tokens.bg2),
			BorderSizePixel = 0,
			Font = Enum.Font[tokens.fontMono],
			TextSize = 12,
			TextXAlignment = Enum.TextXAlignment.Center,
			TextColor3 = c3(tokens.text),
			Text = "",
			ClearTextOnFocus = false,
			ZIndex = 302,
		}, card)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, hexBox)
		nodes.hexBox = hexBox
		nodes.hexTyping = false
		y += 30 + 10

		-- -- Palette rows --
		local paletteNames = Util.keys(Color.palettes)
		for _, pname in ipairs(paletteNames) do
			local px = panelX()
			for _, hex in ipairs(Color.palettes[pname]) do
				local parsed = Color.fromHex(hex)
				assert(parsed ~= nil, "ColorPicker: bad palette hex")
				local pc = parsed :: Color.RGBA
				local sw = el("TextButton", {
					Name = "PaletteSwatch",
					Text = "",
					AutoButtonColor = false,
					Position = UDim2.fromOffset(px, y),
					Size = UDim2.fromOffset(SWATCH, SWATCH),
					BackgroundColor3 = c3(hex),
					BorderSizePixel = 0,
					ZIndex = 302,
				}, card)
				el("UICorner", { CornerRadius = UDim.new(0, 4) }, sw)
				local ph, ps, pv = Color.rgbToHsv(pc.r, pc.g, pc.b)
				track(sw.MouseButton1Click:Connect(function()
					if self._dead or not self._open then
						return
					end
					value = { h = ph, s = ps, v = pv, a = value.a }
					self:_render()
					fireChanged()
					fireCommit()
				end))
				px += SWATCH + 4
			end
			y += SWATCH + 4
		end

		-- -- Drag wiring (shared pattern per surface) --
		local dragging: string? = nil
		local function fracOf(box: any, x: number): number
			local w = box.AbsoluteSize.X
			if w <= 0 then
				return 0
			end
			return Util.clamp((x - box.AbsolutePosition.X) / w, 0, 1)
		end
		local function applySurface(which: string, x: number, py: number?)
			if which == "sv" then
				local hgt = svBox.AbsoluteSize.Y
				local vv = 1
				if hgt > 0 and py ~= nil then
					vv = Util.clamp(1 - (py - svBox.AbsolutePosition.Y) / hgt, 0, 1)
				end
				value = { h = value.h, s = fracOf(svBox, x), v = vv, a = value.a }
			elseif which == "hue" then
				value = { h = fracOf(hueBox, x), s = value.s, v = value.v, a = value.a }
			elseif which == "bright" then
				value = { h = value.h, s = value.s, v = fracOf(brightBox, x), a = value.a }
			elseif which == "alpha" then
				value = { h = value.h, s = value.s, v = value.v, a = fracOf(alphaBox, x) }
			end
			self:_render()
			fireChanged()
		end
		local function grabBegin(which: string, input: any)
			local t = input.UserInputType
			if t == Enum.UserInputType.MouseButton1 or t == Enum.UserInputType.Touch then
				dragging = which
				applySurface(which, input.Position.X, input.Position.Y)
			end
		end
		track(svGrab.InputBegan:Connect(function(input: any)
			grabBegin("sv", input)
		end))
		track(hueGrab.InputBegan:Connect(function(input: any)
			grabBegin("hue", input)
		end))
		track(brightGrab.InputBegan:Connect(function(input: any)
			grabBegin("bright", input)
		end))
		track(alphaGrab.InputBegan:Connect(function(input: any)
			grabBegin("alpha", input)
		end))
		track(s.uis.InputChanged:Connect(function(input: any)
			if self._dead or dragging == nil then
				return
			end
			local t = input.UserInputType
			if t == Enum.UserInputType.MouseMovement or t == Enum.UserInputType.Touch then
				applySurface(dragging :: string, input.Position.X, input.Position.Y)
			end
		end))
		track(s.uis.InputEnded:Connect(function(input: any)
			if dragging == nil then
				return
			end
			local t = input.UserInputType
			if t == Enum.UserInputType.MouseButton1 or t == Enum.UserInputType.Touch then
				dragging = nil
				fireCommit()
			end
		end))
		track(s.uis.InputBegan:Connect(function(input: any)
			if self._open and not self._dead and input.KeyCode == Enum.KeyCode.Escape then
				self:close()
			end
		end))

		-- Hex commit.
		track(hexBox.Focused:Connect(function()
			nodes.hexTyping = true
		end))
		track(hexBox.FocusLost:Connect(function(_enter: boolean)
			nodes.hexTyping = false
			if self._dead or not self._open then
				return
			end
			local parsed = Color.fromHex(hexBox.Text)
			if parsed ~= nil then
				local h2, s2, v2 = Color.rgbToHsv(parsed.r, parsed.g, parsed.b)
				value = { h = h2, s = s2, v = v2, a = Color.clamp01(parsed.a) }
				self:_render()
				fireChanged()
				fireCommit()
			else
				self:_render() -- revert to the committed value
			end
		end))

		self:_render()
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- close/destroy --
	function picker.close(self: any)
		if not self._open then
			return
		end
		self._open = false
		for _, c in ipairs(self._conns) do
			pcall(function()
				local conn: any = c
				conn:Disconnect()
			end)
		end
		table.clear(self._conns)
		if root ~= nil then
			pcall(function()
				root:Destroy()
			end)
			root = nil
		end
		nodes = {}
		if onCloseCb ~= nil then
			onCloseCb()
		end
	end

	function picker.destroy(self: any)
		if self._dead then
			return
		end
		self._dead = true
		self:close()
	end

	return picker
end

return ColorPicker
