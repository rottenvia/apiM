--!strict
-- ============================================================================
--  PRISM-UI · Theme
-- ----------------------------------------------------------------------------
--  Design tokens (colors, type, spacing, radii, motion) plus three curated
--  presets. Widgets read tokens through Theme.current() so an accent change
--  or preset swap propagates on the next render pass; live re-theming is
--  done by re-applying tokens to the built tree (see Window:applyTheme).
--
--  Token colors are stored as HEX STRINGS (serializable, diffable, easy to
--  persist). Convert at the Roblox boundary with Color3.fromHex (executor /
--  modern client) or Color3.fromRGB(Color.toRGB255(...)) for max compat —
--  see Theme.toColor3().
-- ============================================================================

local Color = require("./Color")

export type ThemeTokens = {
	name: string,
	-- Surfaces (dark glass stack, bottom -> top).
	bg0: string, -- app backdrop / deepest layer
	bg1: string, -- window body
	bg2: string, -- cards, rows, wells
	bg3: string, -- hovered / raised
	overlay: string, -- dropdown + picker popups
	-- Lines & text.
	border: string,
	borderStrong: string,
	text: string,
	textDim: string,
	textFaint: string,
	-- Accent ramp.
	accent: string,
	accentSoft: string, -- translucent fills (alpha handled by widgets)
	accentText: string, -- text drawn ON the accent
	success: string,
	warning: string,
	danger: string,
	-- Type (Roblox enum names, resolved by widgets).
	fontRegular: string,
	fontMedium: string,
	fontBold: string,
	fontMono: string,
	-- Metrics.
	radiusSm: number,
	radiusMd: number,
	radiusLg: number,
	rowH: number,
	pad: number,
	gap: number,
	-- Motion (seconds).
	tweenFast: number,
	tweenMed: number,
	tweenSlow: number,
}

local Theme = {}

-- ---------------------------------------------------------------------------
-- Presets
-- ---------------------------------------------------------------------------

local PRESETS: { [string]: ThemeTokens } = {
	Midnight = {
		name = "Midnight",
		bg0 = "#0B0E14",
		bg1 = "#11151D",
		bg2 = "#1A2029",
		bg3 = "#232B38",
		overlay = "#161C26",
		border = "#2A3342",
		borderStrong = "#3B475C",
		text = "#E8EDF4",
		textDim = "#9AA6B8",
		textFaint = "#5C6578",
		accent = "#6C8CFF",
		accentSoft = "#2A3565",
		accentText = "#FFFFFF",
		success = "#3DDC84",
		warning = "#FFB020",
		danger = "#FF5C5C",
		fontRegular = "Gotham",
		fontMedium = "GothamMedium",
		fontBold = "GothamBold",
		fontMono = "Code",
		radiusSm = 4,
		radiusMd = 6,
		radiusLg = 10,
		rowH = 32,
		pad = 12,
		gap = 8,
		tweenFast = 0.12,
		tweenMed = 0.2,
		tweenSlow = 0.32,
	},
	Ember = {
		name = "Ember",
		bg0 = "#120B0B",
		bg1 = "#1A1113",
		bg2 = "#251A1C",
		bg3 = "#332326",
		overlay = "#1E1416",
		border = "#3D2A2E",
		borderStrong = "#5A3B40",
		text = "#F5E9E7",
		textDim = "#B89B98",
		textFaint = "#6E5553",
		accent = "#F04E23",
		accentSoft = "#4A2A22",
		accentText = "#FFFFFF",
		success = "#3DDC84",
		warning = "#FFB020",
		danger = "#FF5C5C",
		fontRegular = "Gotham",
		fontMedium = "GothamMedium",
		fontBold = "GothamBold",
		fontMono = "Code",
		radiusSm = 4,
		radiusMd = 6,
		radiusLg = 10,
		rowH = 32,
		pad = 12,
		gap = 8,
		tweenFast = 0.12,
		tweenMed = 0.2,
		tweenSlow = 0.32,
	},
	Glacier = {
		name = "Glacier",
		bg0 = "#E9EEF3",
		bg1 = "#F4F7FA",
		bg2 = "#FFFFFF",
		bg3 = "#E2E9F1",
		overlay = "#FFFFFF",
		border = "#C9D3DE",
		borderStrong = "#9FB0C2",
		text = "#17222E",
		textDim = "#4A5A6D",
		textFaint = "#8595A8",
		accent = "#2563EB",
		accentSoft = "#D6E4FF",
		accentText = "#FFFFFF",
		success = "#16A34A",
		warning = "#D97706",
		danger = "#DC2626",
		fontRegular = "Gotham",
		fontMedium = "GothamMedium",
		fontBold = "GothamBold",
		fontMono = "Code",
		radiusSm = 4,
		radiusMd = 6,
		radiusLg = 10,
		rowH = 32,
		pad = 12,
		gap = 8,
		tweenFast = 0.12,
		tweenMed = 0.2,
		tweenSlow = 0.32,
	},
}

-- ---------------------------------------------------------------------------
-- Active theme state
-- ---------------------------------------------------------------------------

local currentName = "Midnight"
-- User overrides layered on top of the preset (e.g. a custom accent).
local overrides: { [string]: any } = {}

--- List available preset names, sorted.
function Theme.list(): { string }
	local names: { string } = {}
	for name, _ in PRESETS do
		table.insert(names, name)
	end
	table.sort(names)
	return names
end

--- Switch the active preset. Clears per-token overrides.
function Theme.setPreset(name: string)
	assert(PRESETS[name] ~= nil, "Theme: unknown preset '" .. tostring(name) .. "'")
	currentName = name
	table.clear(overrides)
end

--- Name of the active preset.
function Theme.presetName(): string
	return currentName
end

--- Override a single token on top of the active preset (nil clears it).
function Theme.setToken(key: string, value: any)
	overrides[key] = value
end

--- Resolve the full token table: preset + overrides merged.
function Theme.current(): ThemeTokens
	local base = PRESETS[currentName]
	local out: { [string]: any } = {}
	local baseAny: any = base
	for k, v in baseAny do
		out[k] = v
	end
	for k, v in overrides do
		if v == nil then
			out[k] = (base :: { [string]: any })[k]
		else
			out[k] = v
		end
	end
	return out :: ThemeTokens
end

--- Read a single token by key.
function Theme.get(key: string): any
	if overrides[key] ~= nil then
		return overrides[key]
	end
	return (PRESETS[currentName] :: { [string]: any })[key]
end

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

--- Convert a hex token to 0..255 ints for Color3.fromRGB.
function Theme.rgb(key: string): (number, number, number)
	local hex = Theme.get(key) :: string
	local c = Color.fromHex(hex)
	assert(c ~= nil, "Theme: token '" .. key .. "' is not valid hex")
	local cc = c :: Color.RGBA
	return Color.toRGB255(cc.r, cc.g, cc.b)
end

--- Interpolate between two hex colors. Returns "#RRGGBB".
function Theme.mix(hexA: string, hexB: string, t: number): string
	local a = Color.fromHex(hexA)
	local b = Color.fromHex(hexB)
	assert(a ~= nil and b ~= nil, "Theme.mix expects valid hex")
	local aa = a :: Color.RGBA
	local bb = b :: Color.RGBA
	local r, g, bl = Color.lerpRgb(aa.r, aa.g, aa.b, bb.r, bb.g, bb.b, t)
	return Color.toHex(r, g, bl)
end

--- Validate a preset: every color token parses, and body text reads on the
--- window background (WCAG AA). Returns (ok, problems[]).
function Theme.validatePreset(name: string): (boolean, { string })
	local problems: { string } = {}
	local preset = PRESETS[name]
	if preset == nil then
		return false, { "unknown preset '" .. tostring(name) .. "'" }
	end
	local colorKeys = {
		"bg0", "bg1", "bg2", "bg3", "overlay",
		"border", "borderStrong", "text", "textDim", "textFaint",
		"accent", "accentSoft", "accentText",
		"success", "warning", "danger",
	}
	local parsed: { [string]: Color.RGBA? } = {}
	for _, key in colorKeys do
		local hex = (preset :: { [string]: any })[key]
		local c = Color.fromHex(hex)
		if c == nil then
			table.insert(problems, key .. " is not valid hex: " .. tostring(hex))
		else
			parsed[key] = c
		end
	end
	-- Readability gates (only when the tokens parsed).
	local textC, bg1C = parsed.text, parsed.bg1
	if textC ~= nil and bg1C ~= nil then
		if not Color.isReadable(textC.r, textC.g, textC.b, bg1C.r, bg1C.g, bg1C.b) then
			table.insert(problems, "text on bg1 fails WCAG AA")
		end
	end
	local accentTextC, accentC = parsed.accentText, parsed.accent
	if accentTextC ~= nil and accentC ~= nil then
		if Color.contrastRatio(accentTextC.r, accentTextC.g, accentTextC.b, accentC.r, accentC.g, accentC.b) < 3.0 then
			table.insert(problems, "accentText on accent below 3.0 (large-text floor)")
		end
	end
	return #problems == 0, problems
end

--- Export the active tokens as CSS custom properties (for docs / web preview).
function Theme.toCssVars(): string
	local t = Theme.current()
	local lines = { ":root {" }
	local keys = {
		"bg0", "bg1", "bg2", "bg3", "overlay",
		"border", "borderStrong", "text", "textDim", "textFaint",
		"accent", "accentSoft", "accentText",
		"success", "warning", "danger",
	}
	for _, key in keys do
		table.insert(lines, string.format("  --prism-%s: %s;", key, tostring((t :: { [string]: any })[key])))
	end
	table.insert(lines, "}")
	return table.concat(lines, "\n")
end

return Theme
