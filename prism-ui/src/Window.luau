--!strict
-- ============================================================================
--  PRISM-UI · Window
-- ----------------------------------------------------------------------------
--  Application chrome: ScreenGui + ambient scale, draggable center card,
--  title bar (drag, minimize, hide), sidebar tabs, content area, a topmost
--  overlay layer (dropdowns, pickers, toasts), toast notifications, corner
--  resize and UI-scale support.
--
--  The window is deliberately store-agnostic: hosts drive visibility, scale
--  and theme through the methods below (Init wires them to the store).
-- ============================================================================

local Color = require("./Color")
local Theme = require("./Theme")
local Util = require("./Util")

local Window = {}

local cachedServices: any = nil
local function services(): any
	if cachedServices == nil then
		local g = game
		cachedServices = {
			tween = g:GetService("TweenService"),
			uis = g:GetService("UserInputService"),
		}
	end
	return cachedServices
end

local function c3hex(tokenName: string): any
	local parsed = Color.fromHex(Theme.get(tokenName)) or { r = 1, g = 1, b = 1, a = 1 }
	local ir, ig, ib = Color.toRGB255(parsed.r, parsed.g, parsed.b)
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

function Window.new(props: any): any
	props = props or {}
	local onToggleCb = props.onToggle
	local parent = props.parent
	assert(parent ~= nil, "Window requires props.parent (a Gui container)")
	local tokens = Theme.current()
	local s = services()
	local W = props.width or 640
	local H = props.height or 620
	local SIDEBAR = 150

	local gui = el("ScreenGui", {
		Name = props.name or "PRISM",
		ResetOnSpawn = false,
		IgnoreGuiInset = true,
		DisplayOrder = 10,
		ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
	}, parent)

	-- Full-screen root so a UIScale can zoom the whole app at once.
	local root = el("Frame", {
		Name = "Root",
		BackgroundTransparency = 1,
		Size = UDim2.fromScale(1, 1),
	}, gui)
	local rootScale = el("UIScale", { Scale = props.scale or 1 }, root)

	local card = el("Frame", {
		Name = "Card",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5),
		Size = UDim2.fromOffset(W, H),
		BackgroundColor3 = c3hex("bg1"),
		BorderSizePixel = 0,
		ClipsDescendants = false,
	}, root)
	el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusLg) }, card)
	local cardStroke = el("UIStroke", { Color = c3hex("borderStrong"), Thickness = 1 }, card)
	local popScale = el("UIScale", { Scale = 1 }, card)

	local window: any = {
		root = gui,
		_conns = {},
		_tabs = {},
		_tabOrder = {},
		_refreshers = {},
		_dead = false,
		_visible = true,
		_minimized = false,
	}
	local function track(conn: any)
		table.insert(window._conns, conn)
		return conn
	end

	local function tween(obj: any, tweenProps: { [string]: any }, secs: number?): any
		local info = TweenInfo.new(secs or tokens.tweenFast, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
		local tw = s.tween:Create(obj, info, tweenProps)
		tw:Play()
		return tw
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- title bar --
	local titleBar = el("TextButton", {
		Name = "TitleBar",
		Text = "",
		AutoButtonColor = false,
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 46),
	}, card)
	local logo = el("Frame", {
		Name = "Logo",
		AnchorPoint = Vector2.new(0, 0.5),
		Position = UDim2.new(0, 14, 0.5, 0),
		Size = UDim2.fromOffset(10, 10),
		BackgroundColor3 = c3hex("accent"),
		BorderSizePixel = 0,
	}, titleBar)
	el("UICorner", { CornerRadius = UDim.new(1, 0) }, logo)
	local titleLabel = el("TextLabel", {
		Name = "Title",
		BackgroundTransparency = 1,
		Position = UDim2.new(0, 32, 0, 6),
		Size = UDim2.new(1, -120, 0, 18),
		Font = Enum.Font[tokens.fontBold],
		TextSize = 15,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextColor3 = c3hex("text"),
		TextTruncate = Enum.TextTruncate.AtEnd,
		Text = props.title or "PRISM",
	}, titleBar)
	local subtitleLabel = el("TextLabel", {
		Name = "Subtitle",
		BackgroundTransparency = 1,
		Position = UDim2.new(0, 32, 0, 24),
		Size = UDim2.new(1, -120, 0, 14),
		Font = Enum.Font[tokens.fontRegular],
		TextSize = 11,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextColor3 = c3hex("textDim"),
		TextTruncate = Enum.TextTruncate.AtEnd,
		Text = props.subtitle or "Visuals",
	}, titleBar)
	local function titleButton(name: string, text: string, x: number): any
		return el("TextButton", {
			Name = name,
			Text = text,
			AutoButtonColor = false,
			BackgroundTransparency = 1,
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, x, 0.5, 0),
			Size = UDim2.fromOffset(28, 28),
			Font = Enum.Font[tokens.fontRegular],
			TextSize = 15,
			TextColor3 = c3hex("textDim"),
		}, titleBar)
	end
	local minBtn = titleButton("Minimize", "-", -44)
	local closeBtn = titleButton("Close", "×", -10)
	local titleDivider = el("Frame", {
		Name = "TitleDivider",
		Position = UDim2.new(0, 0, 0, 46),
		Size = UDim2.new(1, 0, 0, 1),
		BackgroundColor3 = c3hex("border"),
		BorderSizePixel = 0,
	}, card)

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- sidebar + content --
	local body = el("Frame", {
		Name = "Body",
		BackgroundTransparency = 1,
		Position = UDim2.new(0, 0, 0, 47),
		Size = UDim2.new(1, 0, 1, -47),
	}, card)
	local sidebar = el("Frame", {
		Name = "Sidebar",
		BackgroundTransparency = 1,
		Size = UDim2.new(0, SIDEBAR, 1, 0),
	}, body)
	el("UIPadding", {
		PaddingTop = UDim.new(0, 10),
		PaddingBottom = UDim.new(0, 10),
		PaddingLeft = UDim.new(0, 10),
		PaddingRight = UDim.new(0, 10),
	}, sidebar)
	local _sideList = el("UIListLayout", {
		Name = "SideList",
		FillDirection = Enum.FillDirection.Vertical,
		SortOrder = Enum.SortOrder.LayoutOrder,
		Padding = UDim.new(0, 4),
		VerticalAlignment = Enum.VerticalAlignment.Top,
	}, sidebar)
	-- (_sideList is intentionally unused beyond this point.)
	local sideDivider = el("Frame", {
		Name = "SideDivider",
		Position = UDim2.new(0, SIDEBAR, 0, 10),
		Size = UDim2.new(0, 1, 1, -20),
		BackgroundColor3 = c3hex("border"),
		BorderSizePixel = 0,
	}, body)
	local contentArea = el("Frame", {
		Name = "Content",
		BackgroundTransparency = 1,
		Position = UDim2.new(0, SIDEBAR + 1, 0, 0),
		Size = UDim2.new(1, -SIDEBAR - 1, 1, 0),
	}, body)
	el("UIPadding", {
		PaddingTop = UDim.new(0, 12),
		PaddingBottom = UDim.new(0, 12),
		PaddingLeft = UDim.new(0, 12),
		PaddingRight = UDim.new(0, 12),
	}, contentArea)
	local versionLabel = el("TextLabel", {
		Name = "Version",
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(0, 1),
		Position = UDim2.new(0, 10, 1, -10),
		Size = UDim2.new(0, SIDEBAR - 20, 0, 14),
		Font = Enum.Font[tokens.fontRegular],
		TextSize = 10,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextColor3 = c3hex("textFaint"),
		TextTruncate = Enum.TextTruncate.AtEnd,
		Text = "v" .. tostring(props.version or "1.0.0"),
	}, sidebar)

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- overlay + toasts --
	local overlay = el("Frame", {
		Name = "Overlay",
		BackgroundTransparency = 1,
		Size = UDim2.fromScale(1, 1),
		ZIndex = 100,
	}, root)
	window.overlay = overlay
	local toastBin = el("Frame", {
		Name = "Toasts",
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(1, 1),
		Position = UDim2.new(1, -16, 1, -16),
		Size = UDim2.new(0, 280, 1, -32),
		ZIndex = 400,
	}, overlay)
	el("UIListLayout", {
		FillDirection = Enum.FillDirection.Vertical,
		SortOrder = Enum.SortOrder.LayoutOrder,
		Padding = UDim.new(0, 8),
		VerticalAlignment = Enum.VerticalAlignment.Bottom,
	}, toastBin)

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- resize grip --
	local grip = el("TextButton", {
		Name = "ResizeGrip",
		Text = "",
		AutoButtonColor = false,
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(1, 1),
		Position = UDim2.new(1, 0, 1, 0),
		Size = UDim2.fromOffset(22, 22),
	}, card)
	-- A tiny diagonal hint (two short bars).
	el("Frame", {
		AnchorPoint = Vector2.new(1, 1),
		Position = UDim2.new(1, -6, 1, -6),
		Size = UDim2.fromOffset(10, 2),
		Rotation = -45,
		BackgroundColor3 = c3hex("borderStrong"),
		BorderSizePixel = 0,
	}, grip)

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- behavior: drag --
	local dragging = false
	local dragStart: any = nil
	local centerStart: any = nil
	track(titleBar.InputBegan:Connect(function(input: any)
		if window._dead then
			return
		end
		local t = input.UserInputType
		if t == Enum.UserInputType.MouseButton1 or t == Enum.UserInputType.Touch then
			dragging = true
			dragStart = input.Position
			-- Freeze the current center in offset space (no visual jump).
			local abs = card.AbsolutePosition
			local size = card.AbsoluteSize
			centerStart = Vector2.new(abs.X + size.X / 2, abs.Y + size.Y / 2)
			card.Position = UDim2.fromOffset(centerStart.X, centerStart.Y)
		end
	end))
	track(s.uis.InputChanged:Connect(function(input: any)
		if window._dead or not dragging then
			return
		end
		local t = input.UserInputType
		if t ~= Enum.UserInputType.MouseMovement and t ~= Enum.UserInputType.Touch then
			return
		end
		local view = root.AbsoluteSize
		local dx = input.Position.X - dragStart.X
		local dy = input.Position.Y - dragStart.Y
		-- Keep the card center inside the viewport (never lose the window).
		local cx = Util.clamp(centerStart.X + dx, 0, math.max(view.X, 1))
		local cy = Util.clamp(centerStart.Y + dy, 0, math.max(view.Y, 1))
		card.Position = UDim2.fromOffset(cx, cy)
	end))
	track(s.uis.InputEnded:Connect(function(input: any)
		if not dragging then
			return
		end
		local t = input.UserInputType
		if t == Enum.UserInputType.MouseButton1 or t == Enum.UserInputType.Touch then
			dragging = false
		end
	end))

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- behavior: resize --
	local resizing = false
	local resizeStart: any = nil
	local sizeStart: any = nil
	track(grip.InputBegan:Connect(function(input: any)
		if window._dead or window._minimized then
			return
		end
		local t = input.UserInputType
		if t == Enum.UserInputType.MouseButton1 or t == Enum.UserInputType.Touch then
			resizing = true
			resizeStart = input.Position
			sizeStart = card.AbsoluteSize
		end
	end))
	track(s.uis.InputChanged:Connect(function(input: any)
		if window._dead or not resizing then
			return
		end
		local t = input.UserInputType
		if t ~= Enum.UserInputType.MouseMovement and t ~= Enum.UserInputType.Touch then
			return
		end
		local w = Util.clamp(sizeStart.X + (input.Position.X - resizeStart.X), 480, 860)
		local h = Util.clamp(sizeStart.Y + (input.Position.Y - resizeStart.Y), 420, 920)
		card.Size = UDim2.fromOffset(w, h)
	end))
	track(s.uis.InputEnded:Connect(function(input: any)
		if not resizing then
			return
		end
		local t = input.UserInputType
		if t == Enum.UserInputType.MouseButton1 or t == Enum.UserInputType.Touch then
			resizing = false
		end
	end))

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- tabs --
	local activeTab: string? = nil
	local function paintTabButton(btn: any, active: boolean)
		local label = btn:FindFirstChild("Label")
		local bar = btn:FindFirstChild("Bar")
		btn.BackgroundColor3 = active and c3hex("bg3") or c3hex("bg1")
		btn.BackgroundTransparency = active and 0 or 1
		if label ~= nil then
			label.TextColor3 = active and c3hex("text") or c3hex("textDim")
		end
		if bar ~= nil then
			bar.Visible = active
		end
	end

	function window.addTab(self: any, name: string): any
		assert(self._tabs[name] == nil, "Window: duplicate tab '" .. name .. "'")
		local order = #self._tabOrder + 1
		local btn = el("TextButton", {
			Name = "Tab_" .. name,
			Text = "",
			AutoButtonColor = false,
			BackgroundTransparency = 1,
			Size = UDim2.new(1, 0, 0, 32),
			LayoutOrder = order,
		}, sidebar)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, btn)
		local bar = el("Frame", {
			Name = "Bar",
			AnchorPoint = Vector2.new(0, 0.5),
			Position = UDim2.new(0, 0, 0.5, 0),
			Size = UDim2.new(0, 3, 0, 18),
			BackgroundColor3 = c3hex("accent"),
			BorderSizePixel = 0,
			Visible = false,
		}, btn)
		el("UICorner", { CornerRadius = UDim.new(0, 2) }, bar)
		el("TextLabel", {
			Name = "Label",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 12, 0, 0),
			Size = UDim2.new(1, -16, 1, 0),
			Font = Enum.Font[tokens.fontMedium],
			TextSize = 13,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextColor3 = c3hex("textDim"),
			TextTruncate = Enum.TextTruncate.AtEnd,
			Text = name,
		}, btn)
		local page = el("Frame", {
			Name = "Page_" .. name,
			BackgroundTransparency = 1,
			Size = UDim2.fromScale(1, 1),
			Visible = false,
		}, contentArea)
		self._tabs[name] = { button = btn, page = page }
		table.insert(self._tabOrder, name)
		track(btn.MouseButton1Click:Connect(function()
			if not self._dead then
				self:setTab(name)
			end
		end))
		track(btn.MouseEnter:Connect(function()
			if not self._dead and activeTab ~= name then
				tween(btn, { BackgroundTransparency = 0, BackgroundColor3 = c3hex("bg2") }, 0.1)
			end
		end))
		track(btn.MouseLeave:Connect(function()
			if not self._dead and activeTab ~= name then
				paintTabButton(btn, false)
			end
		end))
		table.insert(self._refreshers, function()
			paintTabButton(btn, activeTab == name)
			local lbl = btn:FindFirstChild("Label")
			if lbl ~= nil then
				lbl.Font = Enum.Font[Theme.current().fontMedium]
			end
		end)
		if activeTab == nil then
			self:setTab(name)
		end
		return page
	end

	function window.setTab(self: any, name: string)
		assert(self._tabs[name] ~= nil, "Window: unknown tab '" .. name .. "'")
		activeTab = name
		for tabName, tab in pairs(self._tabs) do
			local on = tabName == name
			tab.page.Visible = on
			paintTabButton(tab.button, on)
		end
	end

	function window.activeTabName(self: any): string?
		return activeTab
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- visibility / scale / theme --
	function window.setVisible(self: any, v: boolean)
		if self._dead then
			return
		end
		self._visible = v == true
		card.Visible = self._visible
		if self._visible then
			popScale.Scale = 0.97
			tween(popScale, { Scale = 1 }, tokens.tweenMed)
		end
		if onToggleCb ~= nil then
			onToggleCb(self._visible)
		end
	end

	function window.toggle(self: any)
		self:setVisible(not self._visible)
	end

	function window.isVisible(self: any): boolean
		return self._visible
	end

	function window.setMinimized(self: any, m: boolean)
		if self._dead then
			return
		end
		self._minimized = m == true
		body.Visible = not self._minimized
		minBtn.Text = self._minimized and "+" or "-"
	end

	function window.setScale(self: any, scaleValue: number)
		rootScale.Scale = Util.clamp(scaleValue, 0.5, 2)
	end

	function window.getScale(self: any): number
		return rootScale.Scale
	end

	function window.registerRefresher(self: any, fn: () -> ())
		table.insert(self._refreshers, fn)
	end

	function window.applyTheme(self: any)
		if self._dead then
			return
		end
		tokens = Theme.current()
		card.BackgroundColor3 = c3hex("bg1")
		cardStroke.Color = c3hex("borderStrong")
		logo.BackgroundColor3 = c3hex("accent")
		titleLabel.TextColor3 = c3hex("text")
		subtitleLabel.TextColor3 = c3hex("textDim")
		minBtn.TextColor3 = c3hex("textDim")
		closeBtn.TextColor3 = c3hex("textDim")
		titleDivider.BackgroundColor3 = c3hex("border")
		sideDivider.BackgroundColor3 = c3hex("border")
		versionLabel.TextColor3 = c3hex("textFaint")
		for _, fn in ipairs(self._refreshers) do
			local f: any = fn
			f()
		end
	end

	track(minBtn.MouseButton1Click:Connect(function()
		if not window._dead then
			window:setMinimized(not window._minimized)
		end
	end))
	track(closeBtn.MouseButton1Click:Connect(function()
		if not window._dead then
			window:setVisible(false)
		end
	end))
	if props.toggleKey ~= nil then
		track(s.uis.InputBegan:Connect(function(input: any, gameProcessed: boolean?)
			if window._dead or gameProcessed then
				return
			end
			if s.uis:GetFocusedTextBox() ~= nil then
				return
			end
			if input.KeyCode ~= nil and input.KeyCode.Name == props.toggleKey then
				window:toggle()
			end
		end))
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- toasts --
	local toastOrder = 0
	function window.notify(self: any, text: string)
		if self._dead then
			return
		end
		-- Cap the stack: drop the oldest toast beyond 4.
		local kids = toastBin:GetChildren()
		local count = 0
		for _, ch in ipairs(kids) do
			if ch:IsA("Frame") then
				count += 1
			end
		end
		if count >= 4 then
			local oldest: any = nil
			for _, ch in ipairs(kids) do
				if ch:IsA("Frame") and (oldest == nil or ch.LayoutOrder < oldest.LayoutOrder) then
					oldest = ch
				end
			end
			if oldest ~= nil then
				oldest:Destroy()
			end
		end
		toastOrder += 1
		local toast = el("Frame", {
			Name = "Toast",
			BackgroundColor3 = c3hex("bg2"),
			BorderSizePixel = 0,
			Size = UDim2.new(1, 0, 0, 38),
			LayoutOrder = toastOrder,
			ZIndex = 401,
		}, toastBin)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusSm) }, toast)
		el("UIStroke", { Color = c3hex("border"), Thickness = 1 }, toast)
		el("Frame", {
			Name = "Bar",
			AnchorPoint = Vector2.new(0, 0.5),
			Position = UDim2.new(0, 0, 0.5, 0),
			Size = UDim2.new(0, 3, 0, 22),
			BackgroundColor3 = c3hex("accent"),
			BorderSizePixel = 0,
			ZIndex = 402,
		}, toast)
		el("TextLabel", {
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 10, 0, 0),
			Size = UDim2.new(1, -16, 1, 0),
			Font = Enum.Font[tokens.fontRegular],
			TextSize = 12,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextColor3 = c3hex("text"),
			TextTruncate = Enum.TextTruncate.AtEnd,
			Text = text,
			ZIndex = 402,
		}, toast)
		toast.BackgroundTransparency = 1
		tween(toast, { BackgroundTransparency = 0 }, tokens.tweenFast)
		-- Auto-dismiss when a scheduler exists (Roblox always has `task`;
		-- scheduler-less embeds keep the toast until the window closes).
		local scheduler: any = task
		if scheduler ~= nil and type(scheduler.delay) == "function" then
			local delayFn: any = scheduler.delay
			delayFn(2.5, function()
				if window._dead then
					return
				end
				pcall(function()
					toast:Destroy()
				end)
			end)
		end
	end

	function window.destroy(self: any)
		if self._dead then
			return
		end
		self._dead = true
		for _, c in ipairs(self._conns) do
			pcall(function()
				local conn: any = c
				conn:Disconnect()
			end)
		end
		pcall(function()
			gui:Destroy()
		end)
	end

	return window
end

return Window
