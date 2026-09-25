--!strict
-- ============================================================================
--  PRISM-UI · Color
-- ----------------------------------------------------------------------------
--  Pure color math: HSV/RGB conversion, hex parsing, interpolation, WCAG
--  contrast, curated palettes and color-vision-deficiency simulation.
--
--  This module is ENGINE-FREE (no `game`, no `Color3`) so it runs anywhere,
--  including plain Luau. Convert to engine values at the boundary:
--
--      local c3 = Color3.fromRGB(Color.toRGB255(r, g, b))
--
--  Conventions:
--    * RGB components are floats in [0, 1].
--    * HSV hue is a float in [0, 1) (1 wraps to 0); S and V are in [0, 1].
--    * Alpha is a float in [0, 1], 1 == fully opaque.
--    * Hex strings are uppercase "#RRGGBB" (alpha variants "#RRGGBBAA").
-- ============================================================================

export type RGB = { r: number, g: number, b: number }
export type RGBA = { r: number, g: number, b: number, a: number }
export type HSV = { h: number, s: number, v: number }

local Color = {}

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

--- Clamp any number into [0, 1].
function Color.clamp01(x: number): number
	if x ~= x then -- NaN guard: NaN ~= NaN
		return 0
	elseif x < 0 then
		return 0
	elseif x > 1 then
		return 1
	end
	return x
end

--- Wrap any number onto the hue circle [0, 1).
function Color.wrapHue(h: number): number
	h = h % 1
	if h < 0 then
		h += 1
	end
	return h
end

--- Linear interpolation between two numbers.
function Color.lerpNumber(a: number, b: number, t: number): number
	return a + (b - a) * t
end

--- Interpolate two hues along the SHORTEST arc of the color wheel.
--- Naive lerp between red (0.0) and violet (0.9) would sweep through the
--- whole rainbow; this takes the short way around instead.
function Color.lerpHue(a: number, b: number, t: number): number
	a = Color.wrapHue(a)
	b = Color.wrapHue(b)
	local d = (b - a) % 1
	if d > 0.5 then
		d -= 1
	end
	return Color.wrapHue(a + d * t)
end

-- ---------------------------------------------------------------------------
-- HSV <-> RGB
-- ---------------------------------------------------------------------------

--- Convert HSV (all [0,1]) to RGB (all [0,1]). Returns r, g, b.
function Color.hsvToRgb(h: number, s: number, v: number): (number, number, number)
	h = Color.wrapHue(h)
	s = Color.clamp01(s)
	v = Color.clamp01(v)

	if s <= 0 then
		return v, v, v -- achromatic grey
	end

	local sector = h * 6
	local i = math.floor(sector)
	local f = sector - i
	local p = v * (1 - s)
	local q = v * (1 - s * f)
	local t = v * (1 - s * (1 - f))
	local m = i % 6
	if m == 0 then
		return v, t, p
	elseif m == 1 then
		return q, v, p
	elseif m == 2 then
		return p, v, t
	elseif m == 3 then
		return p, q, v
	elseif m == 4 then
		return t, p, v
	else
		return v, p, q
	end
end

--- Convert RGB (all [0,1]) to HSV. Returns h [0,1), s [0,1], v [0,1].
function Color.rgbToHsv(r: number, g: number, b: number): (number, number, number)
	r = Color.clamp01(r)
	g = Color.clamp01(g)
	b = Color.clamp01(b)

	local mx = math.max(r, g, b)
	local mn = math.min(r, g, b)
	local d = mx - mn
	local h = 0
	local s = 0
	local v = mx

	if d > 1e-9 then
		s = d / mx
		if mx == r then
			h = ((g - b) / d) % 6
		elseif mx == g then
			h = (b - r) / d + 2
		else
			h = (r - g) / d + 4
		end
		h /= 6
		if h < 0 then
			h += 1
		end
	end

	return h, s, v
end

--- Pack/unpack convenience wrappers around the tuple functions.
function Color.hsvToRgbTable(c: HSV): RGB
	local r, g, b = Color.hsvToRgb(c.h, c.s, c.v)
	return { r = r, g = g, b = b }
end

function Color.rgbToHsvTable(c: RGB): HSV
	local h, s, v = Color.rgbToHsv(c.r, c.g, c.b)
	return { h = h, s = s, v = v }
end

--- Convert 0..1 floats to 0..255 integers (for Color3.fromRGB).
function Color.toRGB255(r: number, g: number, b: number): (number, number, number)
	return math.floor(Color.clamp01(r) * 255 + 0.5),
		math.floor(Color.clamp01(g) * 255 + 0.5),
		math.floor(Color.clamp01(b) * 255 + 0.5)
end

--- Convert 0..255 integers to 0..1 floats.
function Color.fromRGB255(r: number, g: number, b: number): (number, number, number)
	return Color.clamp01(r / 255), Color.clamp01(g / 255), Color.clamp01(b / 255)
end

-- ---------------------------------------------------------------------------
-- Hex
-- ---------------------------------------------------------------------------

--- Parse "#RGB", "#RGBA", "#RRGGBB" or "#RRGGBBAA" (leading "#" optional).
--- Returns an RGBA table, or nil when the string is not valid hex.
function Color.fromHex(hex: string): RGBA?
	if type(hex) ~= "string" then
		return nil
	end
	local s = hex
	if string.sub(s, 1, 1) == "#" then
		s = string.sub(s, 2)
	end
	-- Expand short forms: RGB -> RRGGBB, RGBA -> RRGGBBAA.
	if #s == 3 or #s == 4 then
		local out = {}
		for i = 1, #s do
			local ch = string.sub(s, i, i)
			out[i] = ch .. ch
		end
		s = table.concat(out)
	end
	if #s ~= 6 and #s ~= 8 then
		return nil
	end
	if string.find(s, "[^0-9a-fA-F]") ~= nil then
		return nil
	end
	local r = tonumber(string.sub(s, 1, 2), 16) :: number
	local g = tonumber(string.sub(s, 3, 4), 16) :: number
	local b = tonumber(string.sub(s, 5, 6), 16) :: number
	local a = 255
	if #s == 8 then
		a = tonumber(string.sub(s, 7, 8), 16) :: number
	end
	local fr, fg, fb = Color.fromRGB255(r, g, b)
	return { r = fr, g = fg, b = fb, a = a / 255 }
end

--- Format RGB floats as "#RRGGBB".
function Color.toHex(r: number, g: number, b: number): string
	local ir, ig, ib = Color.toRGB255(r, g, b)
	return string.format("#%02X%02X%02X", ir, ig, ib)
end

--- Format RGBA floats as "#RRGGBBAA".
function Color.toHexA(r: number, g: number, b: number, a: number): string
	local ir, ig, ib = Color.toRGB255(r, g, b)
	local ia = math.floor(Color.clamp01(a) * 255 + 0.5)
	return string.format("#%02X%02X%02X%02X", ir, ig, ib, ia)
end

-- ---------------------------------------------------------------------------
-- Interpolation & gradients
-- ---------------------------------------------------------------------------

--- Lerp two RGB colors in RGB space. Returns r, g, b.
function Color.lerpRgb(
	r1: number, g1: number, b1: number,
	r2: number, g2: number, b2: number,
	t: number
): (number, number, number)
	return Color.lerpNumber(r1, r2, t),
		Color.lerpNumber(g1, g2, t),
		Color.lerpNumber(b1, b2, t)
end

--- Lerp two colors in HSV space (uses shortest-path hue). Takes/returns HSV.
function Color.lerpHsv(h1: number, s1: number, v1: number,
		h2: number, s2: number, v2: number, t: number): (number, number, number)
	return Color.lerpHue(h1, h2, t),
		Color.lerpNumber(s1, s2, t),
		Color.lerpNumber(v1, v2, t)
end

export type GradientStop = { pos: number, r: number, g: number, b: number }

--- Sample a multi-stop RGB gradient at position t in [0, 1].
--- Stops must be sorted by `pos`; out-of-range t clamps to the end stops.
function Color.sampleGradient(stops: { GradientStop }, t: number): (number, number, number)
	assert(#stops >= 1, "sampleGradient needs at least one stop")
	if #stops == 1 or t <= stops[1].pos then
		local s = stops[1]
		return s.r, s.g, s.b
	end
	local last = stops[#stops]
	if t >= last.pos then
		return last.r, last.g, last.b
	end
	for i = 1, #stops - 1 do
		local a = stops[i]
		local b = stops[i + 1]
		if t >= a.pos and t <= b.pos then
			local span = b.pos - a.pos
			local f = 0
			if span > 1e-9 then
				f = (t - a.pos) / span
			end
			return Color.lerpRgb(a.r, a.g, a.b, b.r, b.g, b.b, f)
		end
	end
	return last.r, last.g, last.b
end

--- Build an N-sample RGB ramp through `stops` (useful for preview bars and
--- canvas-free gradient rendering). N includes both endpoints.
function Color.gradient(stops: { GradientStop }, total: number): { RGB }
	assert(total >= 2, "gradient needs at least 2 samples")
	local out: { RGB } = {}
	for i = 1, total do
		local t = (i - 1) / (total - 1)
		local r, g, b = Color.sampleGradient(stops, t)
		out[i] = { r = r, g = g, b = b }
	end
	return out
end

-- ---------------------------------------------------------------------------
-- Contrast (WCAG 2.x relative luminance)
-- ---------------------------------------------------------------------------

local function linearChannel(c: number): number
	c = Color.clamp01(c)
	if c <= 0.03928 then
		return c / 12.92
	end
	return ((c + 0.055) / 1.055) ^ 2.4
end

--- Relative luminance of an RGB color, per WCAG 2.x.
function Color.luminance(r: number, g: number, b: number): number
	return 0.2126 * linearChannel(r)
		+ 0.7152 * linearChannel(g)
		+ 0.0722 * linearChannel(b)
end

--- WCAG contrast ratio between two RGB colors, in [1, 21].
function Color.contrastRatio(
	r1: number, g1: number, b1: number,
	r2: number, g2: number, b2: number
): number
	local l1 = Color.luminance(r1, g1, b1)
	local l2 = Color.luminance(r2, g2, b2)
	if l1 < l2 then
		l1, l2 = l2, l1
	end
	return (l1 + 0.05) / (l2 + 0.05)
end

--- True when `fg` on `bg` passes WCAG AA for normal text (ratio >= 4.5).
function Color.isReadable(
	fr: number, fg: number, fb: number,
	br: number, bg: number, bb: number
): boolean
	return Color.contrastRatio(fr, fg, fb, br, bg, bb) >= 4.5
end

--- Pick black or white text, whichever reads better on `bg`.
function Color.bestTextColor(r: number, g: number, b: number): (number, number, number)
	local onBlack = Color.contrastRatio(0, 0, 0, r, g, b)
	local onWhite = Color.contrastRatio(1, 1, 1, r, g, b)
	if onWhite >= onBlack then
		return 1, 1, 1
	end
	return 0, 0, 0
end

-- ---------------------------------------------------------------------------
-- Harmony
-- ---------------------------------------------------------------------------

--- Complementary hue (opposite side of the wheel).
function Color.complementary(h: number, s: number, v: number): (number, number, number)
	return Color.wrapHue(h + 0.5), s, v
end

--- The two triadic partners of a hue (±120°).
function Color.triadic(h: number, s: number, v: number): (HSV, HSV)
	return { h = Color.wrapHue(h + 1 / 3), s = s, v = v },
		{ h = Color.wrapHue(h - 1 / 3), s = s, v = v }
end

--- The two analogous neighbours of a hue (±`spread`, default ±30°).
function Color.analogous(h: number, s: number, v: number, spread: number?): (HSV, HSV)
	local d = spread or (1 / 12)
	return { h = Color.wrapHue(h + d), s = s, v = v },
		{ h = Color.wrapHue(h - d), s = s, v = v }
end

-- ---------------------------------------------------------------------------
-- Color-vision-deficiency simulation (Machado et al. 2009, full severity)
-- ---------------------------------------------------------------------------

local CVD_MATRICES: { [string]: { { number } } } = {
	protanopia = {
		{ 0.567, 0.433, 0.000 },
		{ 0.558, 0.442, 0.000 },
		{ 0.000, 0.242, 0.758 },
	},
	deuteranopia = {
		{ 0.625, 0.375, 0.000 },
		{ 0.700, 0.300, 0.000 },
		{ 0.000, 0.300, 0.700 },
	},
	tritanopia = {
		{ 0.950, 0.050, 0.000 },
		{ 0.000, 0.433, 0.567 },
		{ 0.000, 0.475, 0.525 },
	},
	achromatopsia = {
		{ 0.299, 0.587, 0.114 },
		{ 0.299, 0.587, 0.114 },
		{ 0.299, 0.587, 0.114 },
	},
}

--- Simulate how an RGB color appears under a color-vision deficiency.
--- `kind` is one of "protanopia" | "deuteranopia" | "tritanopia" |
--- "achromatopsia". Unknown kinds return the input unchanged.
function Color.simulateCVD(r: number, g: number, b: number, kind: string): (number, number, number)
	local m = CVD_MATRICES[kind]
	if m == nil then
		return r, g, b
	end
	return Color.clamp01(m[1][1] * r + m[1][2] * g + m[1][3] * b),
		Color.clamp01(m[2][1] * r + m[2][2] * g + m[2][3] * b),
		Color.clamp01(m[3][1] * r + m[3][2] * g + m[3][3] * b)
end

-- ---------------------------------------------------------------------------
-- Curated palettes (swatch rows for the color picker)
-- ---------------------------------------------------------------------------

local palettes: { [string]: { string } } = {
	Neon = { "#FF2E63", "#FF9F1C", "#F9ED69", "#00FF87", "#08D9D6", "#B980F0" },
	Ember = { "#FF4D00", "#C9184A", "#800F2F", "#FFBA08", "#FAEDCD", "#D4A373" },
	Glacier = { "#03045E", "#0077B6", "#00B4D8", "#90E0EF", "#CAF0F8", "#FFFFFF" },
	Mono = { "#000000", "#333333", "#666666", "#999999", "#CCCCCC", "#FFFFFF" },
}

Color.palettes = palettes

return Color
