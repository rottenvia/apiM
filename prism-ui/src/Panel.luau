--!strict
-- ============================================================================
--  PRISM-UI · Panel (the Visuals tab)
-- ----------------------------------------------------------------------------
--  Generates the entire settings interface from Schema: search, sections,
--  standalone rows, collapsible groups with per-option sub-settings (dimmed
--  while their master toggle is off), config import/export/reset, live
--  search filtering and an empty state.
--
--  STORE WIRING: every widget is controlled — user gestures write through
--  `store:set` (rejected writes push the kept value back into the widget),
--  and one global subscription pushes external changes (undo, profiles,
--  imports) down into the widgets. `config.profile` is special-cased to
--  `store:applyProfile` so one click swaps the whole state in a single
--  undo step.
-- ============================================================================

local Color = require("./Color")
local ColorPicker = require("./ColorPicker")
local Schema = require("./Schema")
local Theme = require("./Theme")
local Util = require("./Util")
local Widgets = require("./Widgets")

local Panel = {}

function Panel.new(props: any, parent: any): any
	props = props or {}
	local store = props.store
	assert(store ~= nil, "Panel requires props.store")
	local overlay = props.overlay
	assert(overlay ~= nil, "Panel requires props.overlay (popup layer)")
	local notifyOverride = props.notify
	local function notify(msg: string)
		if notifyOverride then
			local run = notifyOverride
			run(msg)
		else
			print("[PRISM] " .. msg)
		end
	end
	local tokens = Theme.current()

	local function el(class: string, elProps: { [string]: any }?, elParent: any?): any
		local o = Instance.new(class)
		if elProps ~= nil then
			for k, v in pairs(elProps) do
				(o :: any)[k] = v
			end
		end
		o.Parent = elParent
		return o
	end

	--- Theme token name -> engine Color3.
	local function c3hex(tokenName: string): any
		local parsed = Color.fromHex(Theme.get(tokenName)) or { r = 1, g = 1, b = 1, a = 1 }
		local ir, ig, ib = Color.toRGB255(parsed.r, parsed.g, parsed.b)
		return Color3.fromRGB(ir, ig, ib)
	end

	local root = el("Frame", {
		Name = "VisualsPanel",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 1, 0),
	}, parent)

	local panel: any = { root = root, store = store }
	local handles: { [string]: any } = {}
	local refreshers: { () -> () } = {}
	local descRefs: { any } = {}
	local orderCounter = 0
	local function nextOrder(): number
		orderCounter += 1
		return orderCounter
	end
	-- Search model.
	local sections: { any } = {}
	local groupToggleMap: { [string]: any } = {}

	local function trackRefresher(h: any)
		table.insert(refreshers, function()
			-- NOTE: boolean alias on purpose -- refining h._refresh in the
			-- condition directly makes luau-analyze mistype the call below.
			local hasRefresh = h._refresh ~= nil
			if hasRefresh then
				h:_refresh()
			end
		end)
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- search box --
	local searchHandle = Widgets.Searchbox({ placeholder = "Search settings..." }, root)
	searchHandle.root.LayoutOrder = nextOrder()
	trackRefresher(searchHandle)

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- scroll content --
	local scroll = el("ScrollingFrame", {
		Name = "Scroll",
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Position = UDim2.new(0, 0, 0, 38),
		Size = UDim2.new(1, 0, 1, -38),
		ScrollBarThickness = 6,
		CanvasSize = UDim2.new(0, 0, 0, 0),
	}, root)
	local content = el("Frame", {
		Name = "Content",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
	}, scroll)
	local contentLayout = el("UIListLayout", {
		FillDirection = Enum.FillDirection.Vertical,
		SortOrder = Enum.SortOrder.LayoutOrder,
		Padding = UDim.new(0, 10),
	}, content)
	contentLayout:GetPropertyChangedSignal("AbsoluteContentSize"):Connect(function()
		scroll.CanvasSize = UDim2.new(0, 0, 0, contentLayout.AbsoluteContentSize.Y + 8)
	end)

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- writers --
	local function makeWriter(field: Schema.Field, handleRef: { h: any })
		return function(v: any)
			if field.key == "config.profile" then
				store:applyProfile(v)
				notify("Profile applied: " .. tostring(v))
				return
			end
			local ok, err = store:set(field.key, v)
			if not ok then
				-- Rejected (e.g. multi-select minimum): restore the kept value.
				if handleRef.h ~= nil then
					handleRef.h:set(store:get(field.key))
				end
				notify("Couldn't apply: " .. tostring(err))
			end
		end
	end

	local function buildField(field: Schema.Field, fieldParent: any): any
		local ref: { h: any } = { h = nil }
		local writer = makeWriter(field, ref)
		local common = {
			label = field.label,
			description = field.description,
			value = store:get(field.key),
			onChanged = writer,
		}
		local h: any = nil
		if field.kind == "toggle" then
			h = Widgets.Toggle(common, fieldParent)
		elseif field.kind == "slider" then
			common.min = field.min
			common.max = field.max
			common.step = field.step
			common.unit = field.unit
			common.decimals = field.decimals
			h = Widgets.Slider(common, fieldParent)
		elseif field.kind == "dropdown" then
			common.options = field.options
			common.multi = field.multi
			common.minSelect = field.minSelect
			common.maxSelect = field.maxSelect
			common.overlay = overlay
			h = Widgets.Dropdown(common, fieldParent)
		elseif field.kind == "keybind" then
			common.allowMouse = field.allowMouse
			h = Widgets.Keybind(common, fieldParent)
		elseif field.kind == "color" then
			common.overlay = overlay
			common.picker = ColorPicker
			common.onCommit = function()
				store:flushAutosave()
			end
			h = Widgets.ColorField(common, fieldParent)
		else
			error("Panel: unknown field kind '" .. tostring(field.kind) .. "'")
		end
		ref.h = h
		h.root.LayoutOrder = nextOrder()
		h.root.Name = "Row_" .. field.key
		handles[field.key] = h
		trackRefresher(h)
		local desc = h.root:FindFirstChild("Desc")
		if desc ~= nil then
			table.insert(descRefs, desc)
		end
		return h
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- groups --
	local function buildGroup(group: Schema.Group, sectionBody: any): any
		local card = el("Frame", {
			Name = "Group_" .. group.id,
			BackgroundColor3 = c3hex("bg2"),
			BorderSizePixel = 0,
			Size = UDim2.new(1, 0, 0, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			LayoutOrder = nextOrder(),
		}, sectionBody)
		el("UICorner", { CornerRadius = UDim.new(0, tokens.radiusMd) }, card)
		local cardStroke = el("UIStroke", { Color = c3hex("border"), Thickness = 1 }, card)
		el("UIListLayout", {
			FillDirection = Enum.FillDirection.Vertical,
			SortOrder = Enum.SortOrder.LayoutOrder,
			Padding = UDim.new(0, 0),
		}, card)
		local hasDesc = group.description ~= nil and group.description ~= ""
		local header = el("TextButton", {
			Name = "Header",
			Text = "",
			AutoButtonColor = false,
			BackgroundTransparency = 1,
			Size = UDim2.new(1, 0, 0, hasDesc and 46 or 34),
			LayoutOrder = 1,
		}, card)
		local headerChev = el("TextLabel", {
			Name = "Chevron",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 10, 0, 0),
			Size = UDim2.new(0, 16, 0, hasDesc and 26 or 34),
			Font = Enum.Font[tokens.fontRegular],
			TextSize = 11,
			TextColor3 = c3hex("textDim"),
			Text = "▲",
		}, header)
		local headerLabel = el("TextLabel", {
			Name = "Title",
			BackgroundTransparency = 1,
			Position = UDim2.new(0, 28, 0, hasDesc and 5 or 0),
			Size = UDim2.new(1, -84, 0, 18),
			Font = Enum.Font[tokens.fontMedium],
			TextSize = 13,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextColor3 = c3hex("text"),
			TextTruncate = Enum.TextTruncate.AtEnd,
			Text = group.label,
		}, header)
		local headerDesc: any = nil
		if hasDesc then
			headerDesc = el("TextLabel", {
				Name = "Desc",
				BackgroundTransparency = 1,
				Position = UDim2.new(0, 28, 0, 23),
				Size = UDim2.new(1, -84, 0, 16),
				Font = Enum.Font[tokens.fontRegular],
				TextSize = 11,
				TextXAlignment = Enum.TextXAlignment.Left,
				TextColor3 = c3hex("textDim"),
				TextTruncate = Enum.TextTruncate.AtEnd,
				Text = group.description,
			}, header)
			table.insert(descRefs, headerDesc)
		end

		-- Registered after the header exists (the closure captures locals).
		table.insert(refreshers, function()
			card.BackgroundColor3 = c3hex("bg2")
			cardStroke.Color = c3hex("border")
			headerLabel.TextColor3 = c3hex("text")
			if headerDesc ~= nil then
				headerDesc.TextColor3 = c3hex("textDim")
			end
			headerChev.TextColor3 = c3hex("textDim")
		end)

		local kids = el("Frame", {
			Name = "Children",
			BackgroundTransparency = 1,
			Size = UDim2.new(1, 0, 0, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			LayoutOrder = 2,
		}, card)
		el("UIListLayout", {
			FillDirection = Enum.FillDirection.Vertical,
			SortOrder = Enum.SortOrder.LayoutOrder,
			Padding = UDim.new(0, 4),
		}, kids)
		el("UIPadding", {
			PaddingLeft = UDim.new(0, 12),
			PaddingRight = UDim.new(0, 10),
			PaddingTop = UDim.new(0, 2),
			PaddingBottom = UDim.new(0, 8),
		}, kids)

		-- Children first (the master toggle wires into them).
		local childEntries: { any } = {}
		local childHandles: { any } = {}
		for _, childKey in ipairs(group.children) do
			local field = Schema.get(childKey) :: Schema.Field
			local h = buildField(field, kids)
			table.insert(childEntries, { key = childKey, root = h.root })
			table.insert(childHandles, h)
		end

		local toggleField = Schema.get(group.toggle) :: Schema.Field
		local toggleRef: { h: any } = { h = nil }
		local baseWriter = makeWriter(toggleField, toggleRef)
		local master = Widgets.Toggle({
			label = nil,
			description = nil,
			value = store:get(group.toggle),
			onChanged = function(v: any)
				baseWriter(v)
				for _, ch in ipairs(childHandles) do
					ch:enable(v == true)
				end
			end,
		}, header)
		toggleRef.h = master
		master.root.AnchorPoint = Vector2.new(1, 0.5)
		master.root.Position = UDim2.new(1, -10, 0, hasDesc and 23 or 17)
		master.root.Size = UDim2.new(0, 48, 0, 30)
		master.root.Name = "Row_" .. group.toggle
		handles[group.toggle] = master
		trackRefresher(master)
		groupToggleMap[group.toggle] = { children = childHandles }
		if not store:get(group.toggle) then
			for _, ch in ipairs(childHandles) do
				ch:enable(false)
			end
		end

		local collapsed = false
		header.MouseButton1Click:Connect(function()
			collapsed = not collapsed
			kids.Visible = not collapsed
			headerChev.Text = collapsed and "▼" or "▲"
		end)

		return {
			id = group.id,
			label = group.label,
			card = card,
			headerRoot = master.root,
			children = childEntries,
		}
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- sections --
	for _, section in ipairs(Schema.SECTIONS) do
		local secHandle = Widgets.Section({ title = section.title, hint = section.hint }, content)
		secHandle.root.LayoutOrder = nextOrder()
		trackRefresher(secHandle)
		local body = secHandle:content()
		local secModel: any = { root = secHandle.root, rows = {}, groups = {} }
		for _, field in ipairs(Schema.standaloneFields(section.id)) do
			local h = buildField(field, body)
			table.insert(secModel.rows, { key = field.key, root = h.root })
		end
		for _, group in ipairs(Schema.groupsInSection(section.id)) do
			local g = buildGroup(group, body)
			table.insert(secModel.groups, g)
		end
		-- Config extras live at the end of the Config section.
		if section.id == "config" then
			local importBox = Widgets.Textbox({
				label = "Config JSON",
				placeholder = "Export copies here — paste to import...",
				mono = true,
				clearOnFocus = false,
			}, body)
			importBox.root.LayoutOrder = nextOrder()
			trackRefresher(importBox)
			local btnRow = el("Frame", {
				Name = "ConfigButtons",
				BackgroundTransparency = 1,
				Size = UDim2.new(1, 0, 0, 32),
				LayoutOrder = nextOrder(),
			}, body)
			local function third(i: number): any
				return el("Frame", {
					BackgroundTransparency = 1,
					Position = UDim2.new((i - 1) / 3, 0, 0, 0),
					Size = UDim2.new(1 / 3, 0, 1, 0),
				}, btnRow)
			end
			local httpService = game:GetService("HttpService")
			local copyBtn = Widgets.Button({
				text = "Copy JSON",
				variant = "ghost",
				onClick = function()
					local json = httpService:JSONEncode(store:export())
					importBox:set(json)
					local clip = setclipboard
					if clip ~= nil then
						local ok = pcall(clip, json)
						notify(ok and "Config copied to clipboard." or "Clipboard failed — JSON is in the box.")
					else
						notify("Clipboard unavailable — JSON is in the box.")
					end
				end,
			}, third(1))
			local importBtn = Widgets.Button({
				text = "Import",
				variant = "ghost",
				onClick = function()
					local text = importBox:get()
					local ok, data = pcall(function()
						return httpService:JSONDecode(text)
					end)
					if not ok or type(data) ~= "table" then
						notify("Import failed: not valid JSON.")
						return
					end
					local warnings = store:import(data)
					if #warnings == 0 then
						notify("Imported config.")
					else
						notify("Imported with " .. #warnings .. " warning(s).")
					end
					importBox:set("")
				end,
			}, third(2))
			local resetBtn = Widgets.Button({
				text = "Reset all",
				variant = "danger",
				onClick = function()
					store:reset()
					notify("Defaults restored.")
				end,
			}, third(3))
			trackRefresher(copyBtn)
			trackRefresher(importBtn)
			trackRefresher(resetBtn)
			panel._copyBtn = copyBtn
			panel._importBtn = importBtn
			panel._resetBtn = resetBtn
			panel._importBox = importBox
		end
		table.insert(sections, secModel)
	end

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- footer + empty state --
	local versionText = "PRISM-UI v" .. tostring(props.version or "1.0.0")
		.. " · " .. tostring(#Schema.FIELDS) .. " settings"
	local footer = el("TextLabel", {
		Name = "Footer",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 18),
		LayoutOrder = nextOrder(),
		Font = Enum.Font[tokens.fontRegular],
		TextSize = 10,
		TextColor3 = c3hex("textFaint"),
		Text = versionText,
	}, content)
	table.insert(refreshers, function()
		footer.TextColor3 = c3hex("textFaint")
	end)
	local emptyState = el("TextLabel", {
		Name = "EmptyState",
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 60),
		LayoutOrder = nextOrder(),
		Font = Enum.Font[tokens.fontRegular],
		TextSize = 13,
		TextColor3 = c3hex("textDim"),
		Text = "No settings match your search.",
		Visible = false,
	}, content)

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- search --
	local searchDebouncer = Util.debounce(function(q: string)
		local query = string.match(q or "", "^%s*(.-)%s*$") or ""
		if query == "" then
			for _, sec in ipairs(sections) do
				sec.root.Visible = true
				for _, row in ipairs(sec.rows) do
					row.root.Visible = true
				end
				for _, g in ipairs(sec.groups) do
					g.card.Visible = true
					g.headerRoot.Visible = true
					for _, child in ipairs(g.children) do
						child.root.Visible = true
					end
				end
			end
			emptyState.Visible = false
			return
		end
		local hitSet: { [string]: boolean } = {}
		for _, hit in ipairs(Schema.searchFields(query)) do
			hitSet[hit.field.key] = true
		end
		local gitems: { Util.SearchItem } = {}
		for _, group in ipairs(Schema.GROUPS) do
			table.insert(gitems, {
				id = group.id,
				text = group.label .. " " .. (group.description or ""),
			})
		end
		local gmatch: { [string]: boolean } = {}
		for _, ghit in ipairs(Util.rankedSearch(gitems, query)) do
			gmatch[ghit.id] = true
		end
		local anyVisible = false
		for _, sec in ipairs(sections) do
			local secVisible = false
			for _, row in ipairs(sec.rows) do
				local vis = hitSet[row.key] == true
				row.root.Visible = vis
				secVisible = secVisible or vis
			end
			for _, g in ipairs(sec.groups) do
				if gmatch[g.id] then
					g.card.Visible = true
					g.headerRoot.Visible = true
					for _, child in ipairs(g.children) do
						child.root.Visible = true
					end
					secVisible = true
				else
					local anyChild = false
					for _, child in ipairs(g.children) do
						local vis = hitSet[child.key] == true
						child.root.Visible = vis
						anyChild = anyChild or vis
					end
					-- The master toggle doubles as the group header row.
					local toggleKey = string.sub(g.headerRoot.Name, 5) -- strip "Row_"
					local headerVis = anyChild or hitSet[toggleKey] == true
					g.headerRoot.Visible = headerVis
					g.card.Visible = anyChild or headerVis
					secVisible = secVisible or g.card.Visible
				end
			end
			sec.root.Visible = secVisible
			anyVisible = anyVisible or secVisible
		end
		emptyState.Visible = not anyVisible
	end, props.searchDebounce or 0.15)
	searchHandle:onChanged(function(q: string)
		searchDebouncer.call(q)
	end)

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- store -> widgets --
	local unsubscribe = store:subscribe(nil, function(key: string, newV: any)
		local hd = handles[key]
		if hd ~= nil then
			hd:set(newV)
		end
		local g = groupToggleMap[key]
		if g ~= nil then
			for _, ch in ipairs(g.children) do
				local child: any = ch
				child:enable(newV == true)
			end
		end
	end)

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- public API --
	panel.handles = handles

	function panel.search(self: any, q: string)
		searchHandle:set(q)
		searchDebouncer.call(q)
	end

	function panel.flushSearch(self: any)
		searchDebouncer.flush()
	end

	function panel.setTooltips(self: any, on: boolean)
		for _, desc in ipairs(descRefs) do
			desc.Visible = on
		end
	end

	function panel.refreshTheme(self: any)
		tokens = Theme.current()
		for _, fn in ipairs(refreshers) do
			fn()
		end
	end

	function panel.destroy(self: any)
		if self._dead then
			return
		end
		self._dead = true
		searchDebouncer.cancel()
		unsubscribe()
		for _, hd in pairs(handles) do
			pcall(function()
				hd:destroy()
			end)
		end
		pcall(function()
			searchHandle:destroy()
		end)
		pcall(function()
			root:Destroy()
		end)
	end

	return panel
end

return Panel
