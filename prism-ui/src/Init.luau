--!strict
-- ============================================================================
--  PRISM-UI · Init (public entry point)
-- ----------------------------------------------------------------------------
--  Usage (executor):
--
--      local PRISM = loadstring(readfile("PRISM.luau"))()  -- or paste the file
--      local app = PRISM.new({ profile = "Legit" })
--      app:toggle()          -- show / hide
--      app:setProfile("Rage")
--      app.store:get("esp.enabled")
--      app:destroy()
--
--  Re-executing destroys the previous app first (no duplicate windows).
--  Persistence uses executor file IO when present (writefile/readfile/
--  isfile/makefolder); otherwise the app runs session-only and the Config
--  tab's Copy/Import covers saving through the clipboard.
-- ============================================================================

local Color = require("./Color")
local ColorPicker = require("./ColorPicker")
local Panel = require("./Panel")
local Schema = require("./Schema")
local Signal = require("./Signal")
local Store = require("./Store")
local Theme = require("./Theme")
local Util = require("./Util")
local Widgets = require("./Widgets")
local Window = require("./Window")

local PRISM = {
	_VERSION = "1.0.0",
	Color = Color,
	ColorPicker = ColorPicker,
	Panel = Panel,
	Schema = Schema,
	Signal = Signal,
	Store = Store,
	Theme = Theme,
	Util = Util,
	Widgets = Widgets,
	Window = Window,
}

--- Resolve the best available Gui container.
local function resolveParent(explicit: any): any
	if explicit ~= nil then
		return explicit
	end
	local g = game
	-- 1. Executor hui (survives PlayerGui clears, hidden from screenshots
	--    in some environments).
	local gethuiFn = gethui
	if gethuiFn ~= nil then
		local ok, h = pcall(gethuiFn)
		if ok and h ~= nil then
			return h
		end
	end
	-- 2. CoreGui (plugins / Studio / some executors).
	local okCore, core = pcall(function()
		return g:GetService("CoreGui")
	end)
	if okCore and core ~= nil then
		return core
	end
	-- 3. PlayerGui (last resort; cleared on respawn unless ResetOnSpawn=false).
	local players = g:GetService("Players")
	local plr = players.LocalPlayer
	if plr ~= nil then
		local pg = plr:FindFirstChild("PlayerGui")
		if pg ~= nil then
			return pg
		end
	end
	error("PRISM: no Gui container available (need gethui, CoreGui or PlayerGui)")
end

function PRISM.new(opts: any): any
	opts = opts or {}
	local g = game
	local uis = g:GetService("UserInputService")

	-- Tear down a previous incarnation (safe re-execution).
	local G: any = _G
	if G.__PRISM_APP ~= nil then
		pcall(function()
			(G.__PRISM_APP :: any):destroy()
		end)
		G.__PRISM_APP = nil
	end

	-- -- Store (profile seeds the defaults; disk wins when present) --
	local store = Store.new(Schema.profileState(opts.profile or "Default"))

	-- -- Persistence adapter (executor file IO when present) --
	local canPersist = writefile ~= nil and readfile ~= nil and isfile ~= nil
	local saveFolder = opts.saveFolder or "prism"
	local saveFile = opts.saveFile or "config.json"
	local savePath = saveFolder .. "/" .. saveFile
	local httpService: any = nil
	pcall(function()
		httpService = g:GetService("HttpService")
	end)

	local function writeDisk(state: { [string]: any }): boolean
		if not canPersist or httpService == nil then
			return false
		end
		local ok = pcall(function()
			if makefolder ~= nil then
				pcall(makefolder, saveFolder)
			end
			writefile(savePath, httpService:JSONEncode(state))
		end)
		return ok
	end

	local function readDisk(): ({ [string]: any }?, string?)
		if not canPersist or httpService == nil then
			return nil, "no file IO"
		end
		local okExists, exists = pcall(isfile, savePath)
		if not okExists or not exists then
			return nil, "no save file"
		end
		local okRead, text = pcall(readfile, savePath)
		if not okRead or type(text) ~= "string" then
			return nil, "unreadable save file"
		end
		local okJson, data = pcall(function()
			return httpService:JSONDecode(text)
		end)
		if not okJson or type(data) ~= "table" then
			return nil, "corrupt save file"
		end
		return data, nil
	end

	if opts.autoSave ~= false then
		store:setAutosave(function(state: { [string]: any })
			if store:get("config.autoSave") then
				writeDisk(state)
			end
		end)
	end
	-- Disk wins over the profile seed (migrated, so old saves stay valid).
	local diskState, _diskErr = readDisk()
	if diskState ~= nil then
		store:import(diskState)
	end

	-- -- Window + panel --
	local parent = resolveParent(opts.parent)
	local window = Window.new({
		parent = parent,
		title = opts.title or "PRISM",
		subtitle = opts.subtitle or "Visuals",
		version = PRISM._VERSION,
		width = opts.width,
		height = opts.height,
	})
	local page = window:addTab("Visuals")
	local panel = Panel.new({
		store = store,
		overlay = window.overlay,
		version = PRISM._VERSION,
		notify = function(msg: string)
			window:notify(msg)
		end,
	}, page)
	window:registerRefresher(function()
		panel:refreshTheme()
	end)

	-- -- Live accent: colors.accent re-themes the whole app --
	local function applyAccent()
		local c = store:get("colors.accent")
		local r, gg, b = Color.hsvToRgb(c.h, c.s, c.v)
		local hex = Color.toHex(r, gg, b)
		Theme.setToken("accent", hex)
		Theme.setToken("accentSoft", Theme.mix(hex, Theme.get("bg1"), 0.8))
		window:applyTheme()
	end
	local unsubAccent = store:subscribe("colors.accent", applyAccent)
	if opts.accentSync ~= false then
		applyAccent()
	else
		window:applyTheme()
	end

	-- -- UI scale + tooltips follow the store --
	local function applyScale()
		window:setScale(store:get("config.uiScale"))
	end
	local unsubScale = store:subscribe("config.uiScale", applyScale)
	applyScale()
	local function applyTooltips()
		panel:setTooltips(store:get("config.tooltips") == true)
	end
	local unsubTips = store:subscribe("config.tooltips", applyTooltips)
	applyTooltips()

	-- -- Global hotkeys --
	local function keyNameOf(input: any): string?
		local kc = input.KeyCode
		if kc ~= nil and kc ~= Enum.KeyCode.Unknown then
			return kc.Name
		end
		local t = input.UserInputType
		if t == Enum.UserInputType.MouseButton1
			or t == Enum.UserInputType.MouseButton2
			or t == Enum.UserInputType.MouseButton3
		then
			return t.Name
		end
		return nil
	end
	local hotkeyConn = uis.InputBegan:Connect(function(input: any, gameProcessed: boolean?)
		if gameProcessed then
			return
		end
		if uis:GetFocusedTextBox() ~= nil then
			return -- don't hijack typing
		end
		local name = keyNameOf(input)
		if name == nil or name == "None" then
			return
		end
		if name == store:get("keys.toggleUI") then
			window:toggle()
		elseif name == store:get("keys.toggleESP") then
			store:set("esp.enabled", not store:get("esp.enabled"))
		elseif name == store:get("keys.toggleChams") then
			store:set("chams.enabled", not store:get("chams.enabled"))
		elseif name == store:get("keys.panic") then
			store:transaction(function(s: any)
				s:set("esp.enabled", false)
				s:set("chams.enabled", false)
			end)
			window:setVisible(false)
			window:notify("Panic: visuals off, UI hidden.")
		end
	end)

	-- -- App handle --
	local app: any = {
		store = store,
		window = window,
		panel = panel,
		version = PRISM._VERSION,
		_dead = false,
	}
	function app.toggle(self: any)
		window:toggle()
	end
	function app.setVisible(self: any, v: boolean)
		window:setVisible(v)
	end
	function app.setProfile(self: any, name: string)
		store:applyProfile(name)
		window:notify("Profile applied: " .. tostring(name))
	end
	function app.save(self: any): boolean
		store:flushAutosave()
		return writeDisk(store:export())
	end
	function app.destroy(self: any)
		if self._dead then
			return
		end
		self._dead = true
		pcall(function()
			hotkeyConn:Disconnect()
		end)
		unsubAccent()
		unsubScale()
		unsubTips()
		pcall(function()
			panel:destroy()
		end)
		pcall(function()
			window:destroy()
		end)
		pcall(function()
			store:destroy()
		end)
		if G.__PRISM_APP == self then
			G.__PRISM_APP = nil
		end
	end

	G.__PRISM_APP = app
	return app
end

return PRISM
