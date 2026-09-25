--!strict
-- ============================================================================
--  PRISM-UI · Schema
-- ----------------------------------------------------------------------------
--  The single source of truth for every setting: sections, field descriptors
--  (kind, default, ranges, options), collapsible groups with per-option
--  sub-settings, validation + coercion, diffing, search and built-in
--  profiles (Default / Legit / Rage / Streamer).
--
--  The panel is GENERATED from this schema, so adding a setting is a
--  one-table change here — no widget wiring by hand.
--
--  Value shapes per kind:
--    toggle   boolean
--    slider   number (clamped + snapped to step)
--    dropdown string (single) | {string} (multi)
--    keybind  string ("None" == unbound)
--    color    { h, s, v, a } floats in [0,1]
-- ============================================================================

local Color = require("./Color")
local Util = require("./Util")

export type FieldKind = "toggle" | "slider" | "dropdown" | "keybind" | "color"

export type Field = {
	key: string,
	section: string,
	group: string?, -- group id; nil == standalone row
	label: string,
	description: string?,
	keywords: { string }?,
	kind: FieldKind,
	default: any,
	-- slider:
	min: number?,
	max: number?,
	step: number?,
	unit: string?,
	decimals: number?,
	-- dropdown:
	options: { string }?,
	multi: boolean?,
	minSelect: number?,
	maxSelect: number?,
	-- keybind:
	allowMouse: boolean?,
}

export type Group = {
	id: string,
	section: string,
	label: string,
	description: string?,
	toggle: string, -- key of the master enable field
	children: { string }, -- sub-setting keys (order == display order)
}

export type Section = {
	id: string,
	title: string,
	hint: string,
}

local Schema = {}

-- ---------------------------------------------------------------------------
-- Sections (display order)
-- ---------------------------------------------------------------------------

Schema.SECTIONS = {
	{ id = "esp", title = "ESP", hint = "Boxes, names, health & indicators" },
	{ id = "chams", title = "Chams", hint = "Through-wall materials" },
	{ id = "world", title = "Overlays", hint = "Crosshair & FOV circle" },
	{ id = "view", title = "View", hint = "Camera & environment" },
	{ id = "colors", title = "Colors", hint = "ESP & UI palette" },
	{ id = "keys", title = "Keybinds", hint = "Hotkeys" },
	{ id = "config", title = "Config", hint = "Profiles & interface" },
} :: { Section }

-- ---------------------------------------------------------------------------
-- Groups: master toggle + per-option sub-settings
-- ---------------------------------------------------------------------------

Schema.GROUPS = {
	{ id = "esp.boxes", section = "esp", label = "Boxes", toggle = "esp.boxes.enabled",
		description = "2D / 3D bounding boxes around targets.",
		children = { "esp.boxes.style", "esp.boxes.thickness", "esp.boxes.rounding", "esp.boxes.fillAlpha" } },
	{ id = "esp.names", section = "esp", label = "Names", toggle = "esp.names.enabled",
		description = "Name tags with optional distance readout.",
		children = { "esp.names.position", "esp.names.fontSize", "esp.names.showDistance", "esp.names.outline" } },
	{ id = "esp.health", section = "esp", label = "Health", toggle = "esp.health.enabled",
		description = "Health bars and numeric readouts.",
		children = { "esp.health.style", "esp.health.position", "esp.health.width", "esp.health.background" } },
	{ id = "esp.skeletons", section = "esp", label = "Skeletons", toggle = "esp.skeletons.enabled",
		description = "Bone lines drawn through the rig.",
		children = { "esp.skeletons.thickness", "esp.skeletons.joints" } },
	{ id = "esp.tracers", section = "esp", label = "Tracers", toggle = "esp.tracers.enabled",
		description = "Lines from a screen anchor to each target.",
		children = { "esp.tracers.origin", "esp.tracers.thickness" } },
	{ id = "esp.headDot", section = "esp", label = "Head dot", toggle = "esp.headDot.enabled",
		description = "A precise dot pinned to the head.",
		children = { "esp.headDot.size", "esp.headDot.filled" } },
	{ id = "esp.arrows", section = "esp", label = "Off-screen arrows", toggle = "esp.arrows.enabled",
		description = "Direction arrows for targets outside the view.",
		children = { "esp.arrows.size", "esp.arrows.distance" } },
	{ id = "world.crosshair", section = "world", label = "Crosshair", toggle = "world.crosshair.enabled",
		description = "Center-screen aiming reticle.",
		children = { "world.crosshair.size", "world.crosshair.gap", "world.crosshair.thickness", "world.crosshair.dot" } },
	{ id = "world.fov", section = "world", label = "FOV circle", toggle = "world.fov.enabled",
		description = "Aim-assist radius indicator.",
		children = { "world.fov.radius", "world.fov.thickness", "world.fov.filled" } },
	{ id = "view.lens", section = "view", label = "Camera", toggle = "view.lens.enabled",
		description = "Field of view and third-person overrides.",
		children = { "view.lens.fov", "view.lens.thirdPerson", "view.lens.distance" } },
	{ id = "view.world", section = "view", label = "Environment", toggle = "view.world.enabled",
		description = "Lighting, fog and time-of-day tweaks.",
		children = {
			"view.world.fullbright", "view.world.brightness",
			"view.world.noFog", "view.world.timeLock", "view.world.timeOfDay",
		} },
} :: { Group }

-- ---------------------------------------------------------------------------
-- Fields (display order within each section)
-- ---------------------------------------------------------------------------

local F: { Field } = {
	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- ESP --
	{ key = "esp.enabled", section = "esp", label = "Enable ESP", kind = "toggle", default = false,
		description = "Master switch for every ESP feature below.",
		keywords = { "master", "all", "global" } },
	{ key = "esp.teamCheck", section = "esp", label = "Team check", kind = "toggle", default = true,
		description = "Filter targets by team before drawing anything.",
		keywords = { "team", "teammates", "allies", "filter" } },
	{ key = "esp.teamCheckMode", section = "esp", label = "Team check mode", kind = "dropdown",
		options = { "Inclusive", "Exclusive" }, default = "Inclusive",
		description = "Inclusive hides your team; Exclusive shows ONLY your team.",
		keywords = { "team", "mode", "include", "exclude" } },
	{ key = "esp.maxDistance", section = "esp", label = "Max distance", kind = "slider",
		min = 0, max = 5000, step = 50, unit = "studs", decimals = 0, default = 1500,
		description = "Targets beyond this range are skipped entirely.",
		keywords = { "range", "distance", "render", "draw distance" } },
	{ key = "esp.visibilityCheck", section = "esp", label = "Visibility check", kind = "toggle", default = false,
		description = "Dim ESP for targets with no line of sight.",
		keywords = { "visible", "wall", "occlusion", "raycast", "los" } },
	{ key = "esp.targets", section = "esp", label = "Target filter", kind = "dropdown", multi = true,
		options = { "Players", "NPCs", "Items", "Vehicles" }, default = { "Players" }, minSelect = 1,
		description = "Which entity types ESP (and chams) may draw.",
		keywords = { "entities", "filter", "players", "npcs", "items", "vehicles" } },

	-- Boxes.
	{ key = "esp.boxes.enabled", section = "esp", group = "esp.boxes", label = "Boxes", kind = "toggle", default = false,
		description = "Bounding boxes around targets.", keywords = { "box", "rectangle", "outline" } },
	{ key = "esp.boxes.style", section = "esp", group = "esp.boxes", label = "Style", kind = "dropdown",
		options = { "Corner", "Outline", "Filled3D" }, default = "Corner",
		description = "Corner draws edge brackets; Filled3D draws a shaded cuboid.",
		keywords = { "style", "corner", "3d", "cuboid" } },
	{ key = "esp.boxes.thickness", section = "esp", group = "esp.boxes", label = "Thickness", kind = "slider",
		min = 1, max = 5, step = 1, unit = "px", decimals = 0, default = 2,
		description = "Edge line thickness.", keywords = { "thick", "width", "line" } },
	{ key = "esp.boxes.rounding", section = "esp", group = "esp.boxes", label = "Rounding", kind = "slider",
		min = 0, max = 8, step = 1, unit = "px", decimals = 0, default = 2,
		description = "Corner radius for Corner and Outline styles.", keywords = { "radius", "round", "corner" } },
	{ key = "esp.boxes.fillAlpha", section = "esp", group = "esp.boxes", label = "Fill opacity", kind = "slider",
		min = 0, max = 1, step = 0.05, decimals = 2, default = 0.25,
		description = "Face opacity for the Filled3D style.", keywords = { "fill", "alpha", "opacity", "3d" } },

	-- Names.
	{ key = "esp.names.enabled", section = "esp", group = "esp.names", label = "Names", kind = "toggle", default = false,
		description = "Name tags above or below targets.", keywords = { "name", "nametag", "tag" } },
	{ key = "esp.names.position", section = "esp", group = "esp.names", label = "Position", kind = "dropdown",
		options = { "Top", "Bottom" }, default = "Top",
		description = "Tag anchor relative to the target.", keywords = { "top", "bottom", "anchor" } },
	{ key = "esp.names.fontSize", section = "esp", group = "esp.names", label = "Font size", kind = "slider",
		min = 8, max = 24, step = 1, unit = "px", decimals = 0, default = 13,
		description = "Tag text height.", keywords = { "font", "size", "text" } },
	{ key = "esp.names.showDistance", section = "esp", group = "esp.names", label = "Show distance", kind = "toggle", default = true,
		description = "Append the stud distance to the tag.", keywords = { "distance", "range", "meters" } },
	{ key = "esp.names.outline", section = "esp", group = "esp.names", label = "Text outline", kind = "toggle", default = true,
		description = "Dark outline so tags read on bright backgrounds.", keywords = { "outline", "stroke", "shadow" } },

	-- Health.
	{ key = "esp.health.enabled", section = "esp", group = "esp.health", label = "Health", kind = "toggle", default = false,
		description = "Health bars and numeric readouts.", keywords = { "health", "hp", "bar" } },
	{ key = "esp.health.style", section = "esp", group = "esp.health", label = "Style", kind = "dropdown",
		options = { "Bar", "Text", "Both" }, default = "Bar",
		description = "Bar, numeric text, or both side by side.", keywords = { "bar", "text", "number" } },
	{ key = "esp.health.position", section = "esp", group = "esp.health", label = "Position", kind = "dropdown",
		options = { "Left", "Right" }, default = "Left",
		description = "Which side of the box the bar hugs.", keywords = { "left", "right", "side" } },
	{ key = "esp.health.width", section = "esp", group = "esp.health", label = "Bar width", kind = "slider",
		min = 2, max = 8, step = 1, unit = "px", decimals = 0, default = 4,
		description = "Bar thickness.", keywords = { "width", "thick", "bar" } },
	{ key = "esp.health.background", section = "esp", group = "esp.health", label = "Track background", kind = "toggle", default = true,
		description = "Dim track behind the bar for contrast.", keywords = { "track", "background", "contrast" } },

	-- Skeletons.
	{ key = "esp.skeletons.enabled", section = "esp", group = "esp.skeletons", label = "Skeletons", kind = "toggle", default = false,
		description = "Bone lines drawn through the rig.", keywords = { "skeleton", "bones", "rig" } },
	{ key = "esp.skeletons.thickness", section = "esp", group = "esp.skeletons", label = "Thickness", kind = "slider",
		min = 1, max = 5, step = 1, unit = "px", decimals = 0, default = 1,
		description = "Bone line thickness.", keywords = { "thick", "line", "bone" } },
	{ key = "esp.skeletons.joints", section = "esp", group = "esp.skeletons", label = "Joint dots", kind = "toggle", default = false,
		description = "Draw a dot at every joint.", keywords = { "joints", "dots", "nodes" } },

	-- Tracers.
	{ key = "esp.tracers.enabled", section = "esp", group = "esp.tracers", label = "Tracers", kind = "toggle", default = false,
		description = "Lines from a screen anchor to each target.", keywords = { "tracer", "line", "snapline" } },
	{ key = "esp.tracers.origin", section = "esp", group = "esp.tracers", label = "Origin", kind = "dropdown",
		options = { "Bottom", "Center", "Top", "Mouse" }, default = "Bottom",
		description = "Screen anchor the lines start from.", keywords = { "origin", "anchor", "start", "mouse" } },
	{ key = "esp.tracers.thickness", section = "esp", group = "esp.tracers", label = "Thickness", kind = "slider",
		min = 1, max = 5, step = 1, unit = "px", decimals = 0, default = 1,
		description = "Tracer line thickness.", keywords = { "thick", "line" } },

	-- Head dot.
	{ key = "esp.headDot.enabled", section = "esp", group = "esp.headDot", label = "Head dot", kind = "toggle", default = false,
		description = "A precise dot pinned to the head.", keywords = { "head", "dot", "circle" } },
	{ key = "esp.headDot.size", section = "esp", group = "esp.headDot", label = "Size", kind = "slider",
		min = 2, max = 12, step = 1, unit = "px", decimals = 0, default = 4,
		description = "Dot diameter.", keywords = { "size", "diameter", "radius" } },
	{ key = "esp.headDot.filled", section = "esp", group = "esp.headDot", label = "Filled", kind = "toggle", default = true,
		description = "Filled disc vs ring outline.", keywords = { "fill", "ring", "solid" } },

	-- Arrows.
	{ key = "esp.arrows.enabled", section = "esp", group = "esp.arrows", label = "Off-screen arrows", kind = "toggle", default = false,
		description = "Direction arrows for targets outside the view.", keywords = { "arrow", "offscreen", "oov", "radar" } },
	{ key = "esp.arrows.size", section = "esp", group = "esp.arrows", label = "Size", kind = "slider",
		min = 8, max = 32, step = 1, unit = "px", decimals = 0, default = 16,
		description = "Arrow head size.", keywords = { "size", "arrow" } },
	{ key = "esp.arrows.distance", section = "esp", group = "esp.arrows", label = "Orbit radius", kind = "slider",
		min = 40, max = 200, step = 5, unit = "px", decimals = 0, default = 90,
		description = "How far from screen center arrows orbit.", keywords = { "radius", "orbit", "distance" } },

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- CHAMS --
	{ key = "chams.enabled", section = "chams", label = "Enable chams", kind = "toggle", default = false,
		description = "Highlight models through walls.", keywords = { "chams", "wallhack", "highlight" } },
	{ key = "chams.mode", section = "chams", label = "Mode", kind = "dropdown",
		options = { "Flat", "Shaded", "Glow" }, default = "Flat",
		description = "Flat ignores lighting; Glow adds a bloom halo.", keywords = { "mode", "flat", "shaded", "glow" } },
	{ key = "chams.fillAlpha", section = "chams", label = "Fill opacity", kind = "slider",
		min = 0, max = 1, step = 0.05, decimals = 2, default = 0.5,
		description = "Body fill opacity.", keywords = { "fill", "alpha", "opacity" } },
	{ key = "chams.outline", section = "chams", label = "Outline", kind = "toggle", default = true,
		description = "Crisp edge around the highlight.", keywords = { "outline", "edge" } },
	{ key = "chams.outlineAlpha", section = "chams", label = "Outline opacity", kind = "slider",
		min = 0, max = 1, step = 0.05, decimals = 2, default = 1,
		description = "Edge opacity.", keywords = { "outline", "alpha" } },
	{ key = "chams.visibleOnly", section = "chams", label = "Visible only", kind = "toggle", default = true,
		description = "Only cham targets ESP would draw (respects filters).", keywords = { "visible", "filter" } },
	{ key = "chams.rainbow", section = "chams", label = "Rainbow", kind = "toggle", default = false,
		description = "Cycle the fill hue over time.", keywords = { "rainbow", "rgb", "cycle" } },
	{ key = "chams.rainbowSpeed", section = "chams", label = "Rainbow speed", kind = "slider",
		min = 0.1, max = 5, step = 0.1, decimals = 1, unit = "x", default = 1,
		description = "Hue cycles per second.", keywords = { "rainbow", "speed" } },

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- OVERLAYS --
	{ key = "world.crosshair.enabled", section = "world", group = "world.crosshair", label = "Crosshair", kind = "toggle", default = false,
		description = "Center-screen aiming reticle.", keywords = { "crosshair", "reticle", "aim", "cross" } },
	{ key = "world.crosshair.size", section = "world", group = "world.crosshair", label = "Size", kind = "slider",
		min = 2, max = 30, step = 1, unit = "px", decimals = 0, default = 8,
		description = "Arm length.", keywords = { "size", "length" } },
	{ key = "world.crosshair.gap", section = "world", group = "world.crosshair", label = "Gap", kind = "slider",
		min = 0, max = 20, step = 1, unit = "px", decimals = 0, default = 4,
		description = "Dead zone at the center.", keywords = { "gap", "center", "spread" } },
	{ key = "world.crosshair.thickness", section = "world", group = "world.crosshair", label = "Thickness", kind = "slider",
		min = 1, max = 4, step = 1, unit = "px", decimals = 0, default = 2,
		description = "Arm thickness.", keywords = { "thick", "width" } },
	{ key = "world.crosshair.dot", section = "world", group = "world.crosshair", label = "Center dot", kind = "toggle", default = false,
		description = "Pixel dot at the exact center.", keywords = { "dot", "center", "pixel" } },

	{ key = "world.fov.enabled", section = "world", group = "world.fov", label = "FOV circle", kind = "toggle", default = false,
		description = "Aim-assist radius indicator.", keywords = { "fov", "circle", "aim", "radius" } },
	{ key = "world.fov.radius", section = "world", group = "world.fov", label = "Radius", kind = "slider",
		min = 20, max = 600, step = 5, unit = "px", decimals = 0, default = 120,
		description = "Circle radius.", keywords = { "radius", "size" } },
	{ key = "world.fov.thickness", section = "world", group = "world.fov", label = "Thickness", kind = "slider",
		min = 1, max = 6, step = 1, unit = "px", decimals = 0, default = 2,
		description = "Ring thickness.", keywords = { "thick", "ring" } },
	{ key = "world.fov.filled", section = "world", group = "world.fov", label = "Filled", kind = "toggle", default = false,
		description = "Translucent disc instead of a ring.", keywords = { "fill", "disc", "solid" } },

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- VIEW --
	{ key = "view.lens.enabled", section = "view", group = "view.lens", label = "Camera", kind = "toggle", default = false,
		description = "Field of view and third-person overrides.", keywords = { "camera", "fov", "lens" } },
	{ key = "view.lens.fov", section = "view", group = "view.lens", label = "Field of view", kind = "slider",
		min = 30, max = 120, step = 1, unit = "°", decimals = 0, default = 70,
		description = "Forced camera FOV while enabled.", keywords = { "fov", "zoom", "camera" } },
	{ key = "view.lens.thirdPerson", section = "view", group = "view.lens", label = "Third person", kind = "toggle", default = false,
		description = "Pull the camera behind the character.", keywords = { "third", "person", "tps", "shoulder" } },
	{ key = "view.lens.distance", section = "view", group = "view.lens", label = "Camera distance", kind = "slider",
		min = 4, max = 32, step = 0.5, unit = "studs", decimals = 1, default = 12,
		description = "Third-person boom length.", keywords = { "distance", "zoom", "boom" } },

	{ key = "view.world.enabled", section = "view", group = "view.world", label = "Environment", kind = "toggle", default = false,
		description = "Lighting, fog and time-of-day tweaks.", keywords = { "environment", "lighting", "world" } },
	{ key = "view.world.fullbright", section = "view", group = "view.world", label = "Fullbright", kind = "toggle", default = false,
		description = "Maximum ambient light, everywhere.", keywords = { "bright", "fullbright", "gamma", "night" } },
	{ key = "view.world.brightness", section = "view", group = "view.world", label = "Brightness", kind = "slider",
		min = 0, max = 3, step = 0.1, decimals = 1, unit = "x", default = 1,
		description = "Exposure multiplier.", keywords = { "brightness", "exposure", "gamma" } },
	{ key = "view.world.noFog", section = "view", group = "view.world", label = "No fog", kind = "toggle", default = false,
		description = "Remove atmosphere and fog.", keywords = { "fog", "atmosphere", "clear" } },
	{ key = "view.world.timeLock", section = "view", group = "view.world", label = "Lock time", kind = "toggle", default = false,
		description = "Pin the clock to the hour below.", keywords = { "time", "clock", "day", "night", "lock" } },
	{ key = "view.world.timeOfDay", section = "view", group = "view.world", label = "Time of day", kind = "slider",
		min = 0, max = 24, step = 0.5, unit = "h", decimals = 1, default = 12,
		description = "Locked hour (0 == midnight).", keywords = { "time", "hour", "day" } },

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- COLORS --
	{ key = "colors.ally", section = "colors", label = "Ally", kind = "color",
		default = { h = 0.33, s = 0.8, v = 1, a = 1 },
		description = "Teammate ESP tint.", keywords = { "ally", "team", "teammate", "green" } },
	{ key = "colors.enemy", section = "colors", label = "Enemy", kind = "color",
		default = { h = 0, s = 0.85, v = 1, a = 1 },
		description = "Opponent ESP tint.", keywords = { "enemy", "opponent", "red" } },
	{ key = "colors.visible", section = "colors", label = "Visible", kind = "color",
		default = { h = 0.5, s = 0.6, v = 1, a = 1 },
		description = "Targets with line of sight.", keywords = { "visible", "los", "seen" } },
	{ key = "colors.hidden", section = "colors", label = "Hidden", kind = "color",
		default = { h = 0.08, s = 0.7, v = 1, a = 1 },
		description = "Occluded targets.", keywords = { "hidden", "occluded", "wall" } },
	{ key = "colors.accent", section = "colors", label = "UI accent", kind = "color",
		default = { h = 0.63, s = 0.58, v = 1, a = 1 },
		description = "Live UI accent color (re-themes instantly).", keywords = { "accent", "ui", "theme" } },
	{ key = "colors.chams", section = "colors", label = "Chams fill", kind = "color",
		default = { h = 0.83, s = 0.8, v = 1, a = 1 },
		description = "Chams body color.", keywords = { "chams", "fill", "body" } },
	{ key = "colors.chamsOutline", section = "colors", label = "Chams edge", kind = "color",
		default = { h = 0.83, s = 0.9, v = 1, a = 1 },
		description = "Chams outline color.", keywords = { "chams", "outline", "edge" } },
	{ key = "colors.fov", section = "colors", label = "FOV circle", kind = "color",
		default = { h = 0, s = 0, v = 1, a = 1 },
		description = "FOV ring tint.", keywords = { "fov", "circle", "ring" } },
	{ key = "colors.crosshair", section = "colors", label = "Crosshair", kind = "color",
		default = { h = 0.33, s = 1, v = 1, a = 1 },
		description = "Reticle tint.", keywords = { "crosshair", "reticle" } },

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- KEYBINDS --
	{ key = "keys.toggleUI", section = "keys", label = "Toggle interface", kind = "keybind",
		allowMouse = true, default = "RightShift",
		description = "Show / hide the whole window.", keywords = { "ui", "menu", "hide", "show" } },
	{ key = "keys.toggleESP", section = "keys", label = "Toggle ESP", kind = "keybind",
		allowMouse = true, default = "None",
		description = "Flip the ESP master switch.", keywords = { "esp", "toggle" } },
	{ key = "keys.toggleChams", section = "keys", label = "Toggle chams", kind = "keybind",
		allowMouse = true, default = "None",
		description = "Flip the chams master switch.", keywords = { "chams", "toggle" } },
	{ key = "keys.panic", section = "keys", label = "Panic key", kind = "keybind",
		allowMouse = false, default = "None",
		description = "Instantly hides the UI and disables ESP + chams.",
		keywords = { "panic", "hide", "stealth", "stream" } },

	-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- CONFIG --
	{ key = "config.profile", section = "config", label = "Profile", kind = "dropdown",
		options = { "Default", "Legit", "Rage", "Streamer" }, default = "Default",
		description = "One-click curated preset. Applying overwrites current values.",
		keywords = { "profile", "preset", "legit", "rage", "config" } },
	{ key = "config.autoSave", section = "config", label = "Auto-save", kind = "toggle", default = true,
		description = "Persist every change to disk (executors with file IO).",
		keywords = { "save", "autosave", "persist", "disk" } },
	{ key = "config.streamerMode", section = "config", label = "Streamer mode", kind = "toggle", default = false,
		description = "Censor names in ESP output.", keywords = { "streamer", "censor", "privacy", "hide" } },
	{ key = "config.tooltips", section = "config", label = "Tooltips", kind = "toggle", default = true,
		description = "Hover any row for its full description.", keywords = { "tooltip", "help", "hint", "hover" } },
	{ key = "config.uiScale", section = "config", label = "UI scale", kind = "slider",
		min = 0.8, max = 1.4, step = 0.05, decimals = 2, unit = "x", default = 1,
		description = "Interface zoom factor.", keywords = { "scale", "zoom", "size", "dpi" } },
}

Schema.FIELDS = F

-- Key -> descriptor index + group membership validation at load.
local BY_KEY: { [string]: Field } = {}
for _, field in F do
	assert(BY_KEY[field.key] == nil, "Schema: duplicate key '" .. field.key .. "'")
	BY_KEY[field.key] = field
end
for _, group in Schema.GROUPS do
	assert(BY_KEY[group.toggle] ~= nil, "Schema: group '" .. group.id .. "' toggle missing")
	for _, childKey in group.children do
		local child = BY_KEY[childKey]
		assert(child ~= nil, "Schema: group '" .. group.id .. "' child '" .. childKey .. "' missing")
	end
end

--- Fetch a field descriptor (nil for unknown keys).
function Schema.get(key: string): Field?
	return BY_KEY[key]
end

--- All fields of a section that are NOT in a group (grouped rows render
--- inside their group card instead). Display order is preserved.
function Schema.standaloneFields(sectionId: string): { Field }
	local out: { Field } = {}
	for _, field in F do
		if field.section == sectionId and field.group == nil then
			table.insert(out, field)
		end
	end
	return out
end

--- Groups of a section, in declared order.
function Schema.groupsInSection(sectionId: string): { Group }
	local out: { Group } = {}
	for _, group in Schema.GROUPS do
		if group.section == sectionId then
			table.insert(out, group)
		end
	end
	return out
end

--- Fresh deep copy of every default value.
function Schema.defaults(): { [string]: any }
	local out: { [string]: any } = {}
	for _, field in F do
		out[field.key] = Util.deepCopy(field.default)
	end
	return out
end

-- ---------------------------------------------------------------------------
-- Validation + coercion
-- ---------------------------------------------------------------------------

local function matchOption(options: { string }, value: string): string?
	for _, opt in options do
		if opt == value then
			return opt
		end
	end
	local folded = string.lower(value)
	for _, opt in options do
		if string.lower(opt) == folded then
			return opt -- case-insensitive fallback to the canonical label
		end
	end
	return nil
end

local function normalizeColor(value: any): { [string]: number }?
	-- Hex string.
	if type(value) == "string" then
		local c = Color.fromHex(value)
		if c == nil then
			return nil
		end
		local h, s, v = Color.rgbToHsv(c.r, c.g, c.b)
		return { h = h, s = s, v = v, a = Color.clamp01(c.a) }
	end
	if type(value) ~= "table" then
		return nil
	end
	local t = value :: { [any]: any }
	-- HSV shape (canonical store shape).
	if type(t.h) == "number" and type(t.s) == "number" and type(t.v) == "number" then
		local a = t.a
		if type(a) ~= "number" then
			a = 1
		end
		return {
			h = Color.wrapHue(t.h),
			s = Color.clamp01(t.s),
			v = Color.clamp01(t.v),
			a = Color.clamp01(a),
		}
	end
	-- RGB floats {r,g,b} or Color3-like {R,G,B}.
	local r = t.r
	local g = t.g
	local b = t.b
	if r == nil and t.R ~= nil then
		r, g, b = t.R, t.G, t.B
	end
	if type(r) == "number" and type(g) == "number" and type(b) == "number" then
		local h, s, v = Color.rgbToHsv(r, g, b)
		local a = t.a
		if type(a) ~= "number" then
			a = 1
		end
		return { h = h, s = s, v = v, a = Color.clamp01(a) }
	end
	-- Positional {r, g, b[, a]}: 0..1 floats, or 0..255 ints when max > 1.
	if type(t[1]) == "number" and type(t[2]) == "number" and type(t[3]) == "number" then
		local mx = math.max(t[1], t[2], t[3])
		local rr, gg, bb = t[1], t[2], t[3]
		if mx > 1 then
			rr, gg, bb = Color.fromRGB255(rr, gg, bb)
		end
		local h, s, v = Color.rgbToHsv(rr, gg, bb)
		local a = t[4]
		if type(a) ~= "number" then
			a = 1
		elseif a > 1 then
			a /= 255
		end
		return { h = h, s = s, v = v, a = Color.clamp01(a) }
	end
	return nil
end

--- Validate (and normalize) a candidate value for `key`.
--- Returns (ok, normalizedValue, errorMessage?).
function Schema.validate(key: string, value: any): (boolean, any, string?)
	local field = BY_KEY[key]
	if field == nil then
		return false, nil, "unknown setting '" .. tostring(key) .. "'"
	end

	if field.kind == "toggle" then
		if type(value) == "boolean" then
			return true, value
		elseif type(value) == "string" then
			local folded = string.lower(value)
			if folded == "true" then
				return true, true
			elseif folded == "false" then
				return true, false
			end
		elseif value == 1 then
			return true, true
		elseif value == 0 then
			return true, false
		end
		return false, nil, key .. ": expected a boolean"

	elseif field.kind == "slider" then
		local n: number? = nil
		if type(value) == "number" then
			n = value
		elseif type(value) == "string" then
			n = Util.parseScalar(value)
		end
		if n == nil or n ~= n then -- reject nil and NaN
			return false, nil, key .. ": expected a number"
		end
		local min = field.min :: number
		local max = field.max :: number
		local num = n :: number
		num = Util.clamp(num, min, max)
		num = Util.snap(num, min, field.step :: number)
		num = Util.clamp(num, min, max)
		local mult = 10 ^ (field.decimals or 0)
		num = math.floor(num * mult + 0.5) / mult
		return true, num

	elseif field.kind == "dropdown" then
		local options = field.options :: { string }
		if field.multi then
			local list: { any } = {}
			if type(value) == "string" then
				list = { value } -- coerce a lone selection into a set
			elseif type(value) == "table" then
				list = value
			else
				return false, nil, key .. ": expected a list of options"
			end
			local out: { string } = {}
			local seen: { [string]: boolean } = {}
			for _, item in list do
				if type(item) ~= "string" then
					return false, nil, key .. ": option names must be strings"
				end
				local canonical = matchOption(options, item)
				if canonical == nil then
					return false, nil, key .. ": unknown option '" .. item .. "'"
				end
				if not seen[canonical] then
					seen[canonical] = true
					table.insert(out, canonical)
				end
			end
			if field.minSelect ~= nil and #out < (field.minSelect :: number) then
				return false, nil, key .. ": pick at least " .. tostring(field.minSelect)
			end
			if field.maxSelect ~= nil and #out > (field.maxSelect :: number) then
				return false, nil, key .. ": pick at most " .. tostring(field.maxSelect)
			end
			return true, out
		else
			if type(value) ~= "string" then
				return false, nil, key .. ": expected an option name"
			end
			local canonical = matchOption(options, value)
			if canonical == nil then
				return false, nil, key .. ": unknown option '" .. value .. "'"
			end
			return true, canonical
		end

	elseif field.kind == "keybind" then
		local name: string? = nil
		if type(value) == "string" then
			name = value
		elseif type(value) == "table" and type((value :: any).Name) == "string" then
			name = (value :: any).Name -- Enum.KeyCode / Enum.UserInputType
		end
		if name == nil then
			return false, nil, key .. ": expected a key name"
		end
		local trimmed = string.match(name, "^%s*(.-)%s*$") or ""
		if trimmed == "" or string.lower(trimmed) == "none" then
			return true, "None"
		end
		if #trimmed > 32 then
			return false, nil, key .. ": key name too long"
		end
		return true, trimmed

	elseif field.kind == "color" then
		local norm = normalizeColor(value)
		if norm == nil then
			return false, nil, key .. ": expected a color (hex, HSV, RGB or Color3)"
		end
		return true, norm
	end

	return false, nil, key .. ": unknown field kind"
end

-- ---------------------------------------------------------------------------
-- Diff, search, migrate
-- ---------------------------------------------------------------------------

export type DiffEntry = { key: string, from: any, to: any }

--- Compare two states; returns changed keys in schema order.
function Schema.diff(a: { [string]: any }, b: { [string]: any }): { DiffEntry }
	local out: { DiffEntry } = {}
	for _, field in F do
		local k = field.key
		if not Util.deepEqual(a[k], b[k]) then
			table.insert(out, { key = k, from = Util.deepCopy(a[k]), to = Util.deepCopy(b[k]) })
		end
	end
	return out
end

export type FieldHit = { field: Field, score: number }

--- Ranked search across labels, sections, descriptions and keywords.
function Schema.searchFields(query: string, limit: number?): { FieldHit }
	local items: { Util.SearchItem } = {}
	local sectionTitle: { [string]: string } = {}
	for _, s in Schema.SECTIONS do
		sectionTitle[s.id] = s.title
	end
	for _, field in F do
		local kws: { string } = {}
		if field.keywords ~= nil then
			for _, kw in field.keywords do
				table.insert(kws, kw)
			end
		end
		table.insert(items, {
			id = field.key,
			text = field.label .. " " .. (sectionTitle[field.section] or field.section),
			keywords = kws,
		})
	end
	local hits = Util.rankedSearch(items, query, limit)
	local out: { FieldHit } = {}
	for _, hit in hits do
		table.insert(out, { field = BY_KEY[hit.id], score = hit.score })
	end
	return out
end

--- Normalize an untrusted table (disk / clipboard) into a FULL state:
--- unknown keys are dropped, invalid values fall back to defaults.
--- Returns (state, warnings[]).
function Schema.migrate(data: { [string]: any }): ({ [string]: any }, { string })
	local warnings: { string } = {}
	local out: { [string]: any } = {}
	if type(data) ~= "table" then
		return Schema.defaults(), { "config is not a table; defaults loaded" }
	end
	for k, v in data do
		if BY_KEY[k] == nil then
			table.insert(warnings, "dropped unknown key '" .. tostring(k) .. "'")
		else
			local ok, norm, err = Schema.validate(k, v)
			if ok then
				out[k] = norm
			else
				out[k] = Util.deepCopy(BY_KEY[k].default)
				table.insert(warnings, tostring(err) .. "; default restored")
			end
		end
	end
	for _, field in F do
		if out[field.key] == nil then
			out[field.key] = Util.deepCopy(field.default)
		end
	end
	return out, warnings
end

-- ---------------------------------------------------------------------------
-- Built-in profiles (partial overrides over the defaults)
-- ---------------------------------------------------------------------------

Schema.PROFILES = {
	Default = {},
	Legit = {
		["esp.enabled"] = true,
		["esp.maxDistance"] = 800,
		["esp.visibilityCheck"] = true,
		["esp.boxes.enabled"] = true,
		["esp.boxes.style"] = "Corner",
		["esp.boxes.thickness"] = 1,
		["esp.names.enabled"] = true,
		["esp.names.fontSize"] = 12,
		["esp.health.enabled"] = true,
		["esp.health.style"] = "Bar",
		["world.crosshair.enabled"] = true,
		["world.crosshair.size"] = 6,
		["world.crosshair.thickness"] = 1,
	},
	Rage = {
		["esp.enabled"] = true,
		["esp.teamCheck"] = false,
		["esp.maxDistance"] = 5000,
		["esp.targets"] = { "Players", "NPCs", "Items", "Vehicles" },
		["esp.boxes.enabled"] = true,
		["esp.boxes.style"] = "Filled3D",
		["esp.boxes.thickness"] = 2,
		["esp.names.enabled"] = true,
		["esp.names.showDistance"] = true,
		["esp.health.enabled"] = true,
		["esp.health.style"] = "Both",
		["esp.skeletons.enabled"] = true,
		["esp.tracers.enabled"] = true,
		["esp.tracers.origin"] = "Bottom",
		["esp.headDot.enabled"] = true,
		["esp.arrows.enabled"] = true,
		["chams.enabled"] = true,
		["chams.mode"] = "Glow",
		["chams.rainbow"] = true,
		["world.fov.enabled"] = true,
		["world.fov.radius"] = 150,
	},
	Streamer = {
		["esp.enabled"] = true,
		["esp.maxDistance"] = 1200,
		["esp.boxes.enabled"] = true,
		["esp.boxes.style"] = "Corner",
		["esp.names.enabled"] = false,
		["esp.health.enabled"] = true,
		["esp.health.style"] = "Bar",
		["config.streamerMode"] = true,
	},
} :: { [string]: { [string]: any } }

function Schema.listProfiles(): { string }
	local names: { string } = {}
	for name, _ in Schema.PROFILES do
		table.insert(names, name)
	end
	table.sort(names)
	return names
end

--- Full validated state for a profile name (unknown names -> defaults).
function Schema.profileState(name: string): { [string]: any }
	local state = Schema.defaults()
	local overrides = Schema.PROFILES[name]
	if overrides ~= nil then
		for k, v in overrides do
			local ok, norm, _ = Schema.validate(k, v)
			if ok then
				state[k] = norm
			end
		end
	end
	state["config.profile"] = name
	return state
end

return Schema
