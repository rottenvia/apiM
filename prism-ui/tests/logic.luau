--!strict
-- ============================================================================
--  PRISM-UI · logic tests (engine-free: Color, Signal, Theme, Util, Schema,
--  Store + the persistence JSON shape via the mock HttpService).
--  Run:  luau-run tests/logic.luau
-- ============================================================================

local Color = require("../src/Color")
local Signal = require("../src/Signal")
local Theme = require("../src/Theme")
local Util = require("../src/Util")
local Schema = require("../src/Schema")
local Store = require("../src/Store")

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

-- ============================================================================
section("Color")
-- ============================================================================

do
	-- Known conversions.
	local r, g, b = Color.hsvToRgb(0, 1, 1)
	eq(r, 1, "pure red r"); eq(g, 0, "pure red g"); eq(b, 0, "pure red b")
	local r2, g2, b2 = Color.hsvToRgb(1 / 3, 1, 1)
	approx(r2, 0, 1e-6, "pure green r"); approx(g2, 1, 1e-6, "pure green g"); approx(b2, 0, 1e-6, "pure green b")
	local h, s, v = Color.rgbToHsv(1, 1, 1)
	eq(s, 0, "white saturation 0"); eq(v, 1, "white value 1")
	local hb, sb, vb = Color.rgbToHsv(0, 0, 0)
	eq(vb, 0, "black value 0"); eq(sb, 0, "black saturation 0"); eq(hb, 0, "black hue 0")

	-- Round-trips across a sweep (h, s, v grid).
	local worst = 0
	for hi = 0, 12 do
		for si = 0, 4 do
			for vi = 0, 4 do
				local hh, ss, vv = hi / 12, si / 4, vi / 4
				local rr, gg, bb = Color.hsvToRgb(hh, ss, vv)
				local h3, s3, v3 = Color.rgbToHsv(rr, gg, bb)
				-- Hue is meaningless when s==0 or v==0; skip those.
				if ss > 1e-6 and vv > 1e-6 then
					local dh = math.abs(Color.wrapHue(h3 - hh + 0.5) - 0.5)
					worst = math.max(worst, dh)
				end
				-- Saturation is destroyed by black (v==0); skip that too.
				if vv > 1e-6 then
					worst = math.max(worst, math.abs(s3 - ss))
				end
				worst = math.max(worst, math.abs(v3 - vv))
			end
		end
	end
	check(worst < 1e-6, "hsv round-trip sweep error " .. tostring(worst))

	-- Hex parsing: all lengths + invalid.
	local c1 = Color.fromHex("#FF0000")
	check(c1 ~= nil, "parse #RRGGBB")
	approx((c1 :: Color.RGBA).r, 1, 1e-6, "red r")
	local c2 = Color.fromHex("0f0")
	check(c2 ~= nil, "parse short RGB without #")
	approx((c2 :: Color.RGBA).g, 1, 1e-6, "short green g")
	local c3 = Color.fromHex("#00FF0080")
	check(c3 ~= nil, "parse #RRGGBBAA")
	approx((c3 :: Color.RGBA).a, 0x80 / 255, 1e-6, "alpha byte")
	local c4 = Color.fromHex("#abcd")
	check(c4 ~= nil and (c4 :: Color.RGBA).a ~= nil, "parse short RGBA")
	check(Color.fromHex("#GGGGGG") == nil, "reject non-hex")
	check(Color.fromHex("#12345") == nil, "reject bad length")
	check(Color.fromHex(123 :: any) == nil, "reject non-string")
	eq(Color.toHex(1, 0, 0), "#FF0000", "toHex red")
	eq(Color.toHexA(1, 0, 0, 0.5), "#FF000080", "toHexA half alpha")

	-- Shortest-path hue lerp: 0.9 -> 0.1 must pass through 0.0, not 0.5.
	approx(Color.lerpHue(0.9, 0.1, 0.5), 0.0, 1e-6, "lerpHue wraps the short way")
	approx(Color.lerpHue(0.1, 0.9, 0.5), 0.0, 1e-6, "lerpHue wraps the short way (reversed)")
	approx(Color.lerpHue(0.2, 0.4, 0.5), 0.3, 1e-6, "lerpHue direct mid")

	-- Gradients.
	local stops: { Color.GradientStop } = {
		{ pos = 0, r = 0, g = 0, b = 0 },
		{ pos = 1, r = 1, g = 1, b = 1 },
	}
	local gr, gg, gb = Color.sampleGradient(stops, 0.5)
	approx(gr, 0.5, 1e-6, "gradient midpoint")
	local ramp = Color.gradient(stops, 5)
	eq(#ramp, 5, "gradient sample count")
	approx(ramp[1].r, 0, 1e-9, "gradient start")
	approx(ramp[5].r, 1, 1e-9, "gradient end")

	-- Contrast.
	local bw = Color.contrastRatio(0, 0, 0, 1, 1, 1)
	approx(bw, 21, 0.01, "black/white contrast ~21")
	check(Color.isReadable(1, 1, 1, 0, 0, 0), "white on black readable")
	check(not Color.isReadable(0.9, 0.9, 0.9, 1, 1, 1), "near-white on white rejected")
	local tr, tg, tb = Color.bestTextColor(0.95, 0.95, 0.95)
	eq(tr, 0, "best text on light bg is black")

	-- Harmony.
	local ch = Color.complementary(0.1, 0.5, 0.5)
	approx(ch, 0.6, 1e-9, "complementary +0.5")
	local t1, t2 = Color.triadic(0, 1, 1)
	approx(t1.h, 1 / 3, 1e-9, "triadic +120")
	approx(t2.h, 2 / 3, 1e-9, "triadic -120")

	-- CVD: achromatopsia output must be grey; unknown kinds pass through.
	local ar, ag, ab = Color.simulateCVD(1, 0, 0, "achromatopsia")
	approx(ar, ag, 1e-9, "achroma r==g")
	approx(ag, ab, 1e-9, "achroma g==b")
	local pr, pg, pb = Color.simulateCVD(0, 1, 0, "protanopia")
	check(math.abs(pr - 0) > 0.05, "protanopia shifts green")
	local ur, ug, ub = Color.simulateCVD(0.2, 0.4, 0.6, "bogus")
	eq(ur, 0.2, "unknown CVD passes r through")

	-- Palettes all parse.
	for name, set in Color.palettes do
		for _, hex in set do
			check(Color.fromHex(hex) ~= nil, "palette " .. name .. " " .. hex .. " parses")
		end
	end
end

-- ============================================================================
section("Signal")
-- ============================================================================

do
	local sig = Signal.new()
	local order: { string } = {}
	sig:Connect(function() table.insert(order, "a") end)
	sig:Connect(function() table.insert(order, "b") end)
	sig:Fire()
	eq(table.concat(order, ","), "a,b", "handlers fire in order")
	eq(sig:Count(), 2, "count tracks handlers")

	-- Disconnect.
	local c = sig:Connect(function() table.insert(order, "c") end)
	c:Disconnect()
	check(not c.Connected, "connection flag flips")
	sig:Fire()
	eq(table.concat(order, ","), "a,b,a,b", "disconnected handler skipped")

	-- Self-disconnect during Fire is safe.
	local sig2 = Signal.new()
	local log: { string } = {}
	local selfConn: Signal.Connection? = nil
	selfConn = sig2:Connect(function()
		table.insert(log, "self");
		(selfConn :: Signal.Connection):Disconnect()
	end)
	sig2:Connect(function() table.insert(log, "next") end)
	sig2:Fire()
	eq(table.concat(log, ","), "self,next", "self-disconnect keeps pass intact")
	eq(sig2:Count(), 1, "self-disconnect removes handler")

	-- Connect during Fire does not run in the same pass.
	local sig3 = Signal.new()
	local log3: { string } = {}
	sig3:Connect(function()
		table.insert(log3, "first")
		sig3:Connect(function() table.insert(log3, "late") end)
	end)
	sig3:Fire()
	eq(table.concat(log3, ","), "first", "late connect skipped this pass")
	sig3:Fire()
	eq(table.concat(log3, ","), "first,first,late", "late connect runs next pass")

	-- Once.
	local sig4 = Signal.new()
	local n = 0
	sig4:Once(function() n += 1 end)
	sig4:Fire(); sig4:Fire()
	eq(n, 1, "Once fires exactly once")

	-- Error isolation: every handler runs, first error rethrown.
	local sig5 = Signal.new()
	local ran: { string } = {}
	sig5:Connect(function() table.insert(ran, "1"); error("boom-1") end)
	sig5:Connect(function() table.insert(ran, "2"); error("boom-2") end)
	sig5:Connect(function() table.insert(ran, "3") end)
	local ok, err = pcall(function() sig5:Fire() end)
	check(not ok, "Fire rethrows handler error")
	check(string.find(tostring(err), "boom-1", 1, true) ~= nil, "first error surfaces")
	eq(table.concat(ran, ","), "1,2,3", "all handlers ran despite errors")

	-- DisconnectAll + Destroy.
	sig5:DisconnectAll()
	eq(sig5:Count(), 0, "DisconnectAll clears")
	sig5:Destroy()
	check(sig5.Destroyed, "Destroyed flag")
	local ok2 = pcall(function() sig5:Connect(function() end) end)
	check(not ok2, "Connect after Destroy throws")
end

-- ============================================================================
section("Theme")
-- ============================================================================

do
	local names = Theme.list()
	check(#names == 3, "three presets")
	eq(Theme.presetName(), "Midnight", "default preset is Midnight")
	Theme.setPreset("Ember")
	eq(Theme.get("accent"), "#F04E23", "Ember accent")
	Theme.setPreset("Glacier")
	eq(Theme.get("bg1"), "#F4F7FA", "Glacier bg")
	local ok = pcall(function() Theme.setPreset("Nope") end)
	check(not ok, "unknown preset throws")

	Theme.setPreset("Midnight")
	Theme.setToken("accent", "#FF0000")
	eq(Theme.get("accent"), "#FF0000", "token override wins")
	eq(Theme.current().accent, "#FF0000", "current() merges overrides")
	Theme.setToken("accent", nil)
	eq(Theme.get("accent"), "#6C8CFF", "nil override restores preset")

	eq(Theme.mix("#000000", "#FFFFFF", 0), "#000000", "mix t=0")
	eq(Theme.mix("#000000", "#FFFFFF", 1), "#FFFFFF", "mix t=1")
	eq(Theme.mix("#000000", "#FFFFFF", 0.5), "#808080", "mix midpoint")

	for _, name in Theme.list() do
		local valid, problems = Theme.validatePreset(name)
		check(valid, "preset " .. name .. " valid (" .. table.concat(problems, "; ") .. ")")
	end

	local css = Theme.toCssVars()
	check(string.find(css, "--prism-accent:", 1, true) ~= nil, "css vars export accent")
	local cr, cg, cb = Theme.rgb("accent")
	check(cr >= 0 and cr <= 255 and cg >= 0 and cg <= 255 and cb >= 0 and cb <= 255, "rgb() in byte range")
end

-- ============================================================================
section("Util")
-- ============================================================================

do
	eq(Util.clamp(5, 0, 10), 5, "clamp inside")
	eq(Util.clamp(-3, 0, 10), 0, "clamp low")
	eq(Util.clamp(99, 0, 10), 10, "clamp high")
	eq(Util.round(2.5), 3, "round halves up")
	eq(Util.snap(137, 0, 50), 150, "snap to step")
	eq(Util.snap(112, 0, 50), 100, "snap down")

	eq(Util.formatInt(1500), "1,500", "formatInt thousands")
	eq(Util.formatInt(-42), "-42", "formatInt negative")
	eq(Util.formatCompact(1500), "1.5k", "compact k")
	eq(Util.formatCompact(2000000), "2M", "compact M")
	eq(Util.formatCompact(999), "999", "compact small")

	eq(Util.parseScalar("1.5k"), 1500, "parse k suffix")
	eq(Util.parseScalar("2M"), 2000000, "parse M suffix")
	eq(Util.parseScalar("1,500"), 1500, "parse commas")
	eq(Util.parseScalar("  12.5 "), 12.5, "parse whitespace")
	check(Util.parseScalar("abc") == nil, "parse rejects junk")
	check(Util.parseScalar("") == nil, "parse rejects empty")
	eq(Util.truncate("hello", 10), "hello", "truncate no-op")
	eq(Util.truncate("hello world", 6), "hello…", "truncate cuts")

	local src = { a = 1, nested = { b = 2 } }
	local cp = Util.deepCopy(src)
	cp.nested.b = 99
	eq(src.nested.b, 2, "deepCopy independent")
	local cyc: { [string]: any } = {}
	cyc.self = cyc
	local cycCopy = Util.deepCopy(cyc)
	check(cycCopy.self == cycCopy, "deepCopy preserves cycles")
	check(Util.deepEqual({ 1, 2, { 3 } }, { 1, 2, { 3 } }), "deepEqual nested true")
	check(not Util.deepEqual({ 1 }, { 1, 2 }), "deepEqual length mismatch")
	check(Util.deepEqual(cyc, Util.deepCopy(cyc)), "deepEqual cycles")

	eq(table.concat(Util.keys({ b = 1, a = 2 }), ","), "a,b", "keys sorted")
	local u1, u2 = Util.uuid(), Util.uuid()
	check(u1 ~= u2 and string.sub(u1, 1, 1) == "w", "uuid unique + prefixed")

	-- Debounce with a fake scheduler.
	do
		local realTask = task
		local scheduled: { () -> () } = {}
		task = {
			delay = function(_n: number, fn: () -> ())
				table.insert(scheduled, fn)
			end,
		} :: any
		local calls: { string } = {}
		local d = Util.debounce(function(v: string) table.insert(calls, v) end, 0.2)
		d.call("a"); d.call("b"); d.call("c")
		check(d.pending(), "debounce pending after calls")
		eq(#scheduled, 3, "three timers scheduled")
		for _, fn in scheduled do fn() end -- fire all timers
		eq(#calls, 1, "only last call runs")
		eq(calls[1], "c", "last args win")
		check(not d.pending(), "not pending after fire")
		d.call("x")
		d.cancel()
		check(not d.pending(), "cancel clears")
		for _, fn in scheduled do fn() end
		eq(#calls, 1, "cancelled call never runs")
		d.call("y")
		d.flush()
		eq(calls[2], "y", "flush runs immediately")
		task = realTask
	end

	-- Ranked search.
	local items: { Util.SearchItem } = {
		{ id = "boxes", text = "Boxes ESP", keywords = { "rectangle", "outline" } },
		{ id = "boxstyle", text = "Box style", keywords = {} },
		{ id = "fov", text = "FOV circle", keywords = { "aim" } },
	}
	local hits = Util.rankedSearch(items, "box")
	eq(hits[1].id, "boxes", "prefix beats substring...")
	-- ...but make substring-vs-prefix explicit:
	local items2: { Util.SearchItem } = {
		{ id = "sub", text = "xxbox", keywords = {} },
		{ id = "pre", text = "boxyy", keywords = {} },
	}
	local hits2 = Util.rankedSearch(items2, "box")
	eq(hits2[1].id, "pre", "prefix outranks substring")
	local hits3 = Util.rankedSearch(items, "aim")
	eq(hits3[1].id, "fov", "keyword match")
	local hits4 = Util.rankedSearch(items, "bxe") -- fuzzy: b..x..e in "boxes esp"
	check(#hits4 >= 1 and hits4[1].id == "boxes", "fuzzy subsequence matches")
	local hits5 = Util.rankedSearch(items, "boxes circle")
	eq(#hits5, 0, "AND terms exclude partial matches")
	local hits6 = Util.rankedSearch(items, "   ")
	eq(#hits6, 3, "empty query returns all")
	local hits7 = Util.rankedSearch(items, "o", 1)
	eq(#hits7, 1, "limit trims hits")
end

-- ============================================================================
section("Schema")
-- ============================================================================

do
	check(#Schema.FIELDS > 70, "field count > 70 (" .. #Schema.FIELDS .. ")")
	check(Schema.get("nope") == nil, "get unknown -> nil")
	local espStandalone = Schema.standaloneFields("esp")
	check(#espStandalone == 6, "esp standalone count (" .. #espStandalone .. ")")
	check(#Schema.groupsInSection("esp") == 7, "esp group count")
	check(#Schema.groupsInSection("view") == 2, "view group count")

	local d = Schema.defaults()
	eq(d["esp.enabled"], false, "default toggle")
	eq(d["esp.maxDistance"], 1500, "default slider")
	eq(d["esp.targets"][1], "Players", "default multi")
	local d2 = Schema.defaults()
	d2["esp.targets"][1] = "MUT"
	eq(Schema.defaults()["esp.targets"][1], "Players", "defaults are fresh copies")

	-- Toggle coercions.
	local ok1, v1 = Schema.validate("esp.enabled", "true")
	check(ok1 and v1 == true, "toggle coerces 'true'")
	local ok1b, v1b = Schema.validate("esp.enabled", 0)
	check(ok1b and v1b == false, "toggle coerces 0")
	check(not Schema.validate("esp.enabled", "maybe"), "toggle rejects junk")

	-- Slider clamp + snap + decimals + scalar strings.
	local _, sv = Schema.validate("esp.maxDistance", 99999)
	eq(sv, 5000, "slider clamps high")
	local _, sv2 = Schema.validate("esp.maxDistance", 137)
	eq(sv2, 150, "slider snaps to step")
	local _, sv3 = Schema.validate("esp.maxDistance", "1.5k")
	eq(sv3, 1500, "slider parses scalar suffix")
	local _, bv = Schema.validate("view.world.brightness", 1.06)
	eq(bv, 1.1, "slider snaps THEN rounds decimals")
	check(not Schema.validate("esp.maxDistance", "abc"), "slider rejects junk")
	check(not Schema.validate("view.world.brightness", 0 / 0), "slider rejects NaN")

	-- Dropdown single.
	local _, dv = Schema.validate("esp.boxes.style", "filled3d")
	eq(dv, "Filled3D", "dropdown case-insensitive canonical")
	check(not Schema.validate("esp.boxes.style", "Circle"), "dropdown rejects unknown")

	-- Dropdown multi.
	local _, mv = Schema.validate("esp.targets", "NPCs")
	eq(#mv, 1, "multi coerces lone string")
	eq(mv[1], "NPCs", "multi coerced value")
	local _, mv2 = Schema.validate("esp.targets", { "Players", "players", "NPCs" })
	eq(#mv2, 2, "multi dedupes")
	check(not Schema.validate("esp.targets", {}), "multi enforces minSelect")
	check(not Schema.validate("esp.targets", { "Players", "Aliens" }), "multi rejects unknown")

	-- Keybind.
	local _, kv = Schema.validate("keys.toggleUI", "  space ")
	eq(kv, "space", "keybind trims (case preserved for display)")
	local _, kv2 = Schema.validate("keys.toggleUI", "")
	eq(kv2, "None", "empty keybind -> None")
	local _, kv3 = Schema.validate("keys.toggleUI", { Name = "F5", Value = 1 })
	eq(kv3, "F5", "keybind coerces Enum-like table")
	check(not Schema.validate("keys.toggleUI", 42), "keybind rejects numbers")

	-- Color.
	local _, cv = Schema.validate("colors.enemy", "#00FF00")
	approx(cv.h, 1 / 3, 1e-3, "color from hex hue")
	eq(cv.a, 1, "color from hex alpha 1")
	local _, cv2 = Schema.validate("colors.enemy", { h = 9.5, s = 2, v = -1 })
	check(cv2.h >= 0 and cv2.h < 1 and cv2.s == 1 and cv2.v == 0, "color clamps+wraps HSV")
	local _, cv3 = Schema.validate("colors.enemy", { R = 0, G = 0, B = 1 })
	approx(cv3.h, 2 / 3, 1e-3, "color from Color3-like")
	local _, cv4 = Schema.validate("colors.enemy", { 255, 0, 0 })
	approx(cv4.h, 0, 1e-6, "color from 0-255 triple")
	check(not Schema.validate("colors.enemy", "notacolor"), "color rejects junk")

	-- Diff.
	local da = Schema.defaults()
	local db = Schema.defaults()
	db["esp.enabled"] = true
	db["esp.maxDistance"] = 100
	local entries = Schema.diff(da, db)
	eq(#entries, 2, "diff finds two changes")
	eq(entries[1].key, "esp.enabled", "diff schema order")

	-- Search.
	local hits = Schema.searchFields("box")
	check(#hits > 0, "search finds box fields")
	local topKeys = {}
	for i = 1, math.min(3, #hits) do table.insert(topKeys, hits[i].field.key) end
	check(
		table.find(topKeys, "esp.boxes.enabled") ~= nil
			or table.find(topKeys, "esp.boxes.style") ~= nil,
		"search 'box' top-3 contains a boxes field"
	)
	local hitsEmpty = Schema.searchFields("zzz-no-such-setting")
	eq(#hitsEmpty, 0, "search no-match empty")

	-- Migrate.
	local mig, warns = Schema.migrate({
		["esp.enabled"] = "yes please",
		["esp.maxDistance"] = 200,
		["bogus.key"] = 1,
	})
	eq(mig["esp.enabled"], false, "migrate restores default on invalid")
	eq(mig["esp.maxDistance"], 200, "migrate keeps valid")
	eq(mig["chams.enabled"], false, "migrate fills missing")
	check(#warns == 2, "migrate warns twice (" .. table.concat(warns, " | ") .. ")")
	local mig2, warns2 = Schema.migrate("nope" :: any)
	check(mig2["esp.enabled"] == false and #warns2 == 1, "migrate non-table -> defaults")

	-- Profiles.
	local profiles = Schema.listProfiles()
	eq(#profiles, 4, "four profiles")
	local rage = Schema.profileState("Rage")
	check(rage["esp.enabled"] == true, "rage enables esp")
	eq(rage["esp.boxes.style"], "Filled3D", "rage boxes style")
	eq(rage["config.profile"], "Rage", "profileState stamps name")
	local legit = Schema.profileState("Legit")
	check(legit["chams.enabled"] == false, "legit keeps chams off")
	local def = Schema.profileState("Nope")
	check(def["esp.enabled"] == false, "unknown profile -> defaults")
end

-- ============================================================================
section("Store")
-- ============================================================================

do
	local store = Store.new()
	eq(store:get("esp.enabled"), false, "store default")
	eq(#store.initWarnings, 0, "clean init")

	-- Valid + invalid writes.
	local ok, _ = store:set("esp.enabled", true)
	check(ok and store:get("esp.enabled") == true, "set applies")
	local okBad, errBad = store:set("esp.enabled", "maybe")
	check(not okBad and store:get("esp.enabled") == true, "invalid set rejected, old kept")
	check(errBad ~= nil, "invalid set explains")
	local okUnknown = store:set("bogus", 1)
	check(not okUnknown, "unknown key rejected")
	local getOk = pcall(function() store:get("bogus") end)
	check(not getOk, "get unknown asserts")

	-- Defensive copies.
	store:set("colors.enemy", { h = 0, s = 1, v = 1, a = 1 })
	local got = store:get("colors.enemy")
	got.h = 0.5
	approx(store:get("colors.enemy").h, 0, 1e-9, "get returns a copy")

	-- No-op writes stay silent.
	local notes = 0
	local off = store:subscribe("esp.enabled", function() notes += 1 end)
	store:set("esp.enabled", true)
	eq(notes, 0, "same-value set does not notify")
	store:set("esp.enabled", false)
	eq(notes, 1, "changed value notifies")
	off()
	store:set("esp.enabled", true)
	eq(notes, 1, "unsubscribed listener silent")

	-- Global subscription payload.
	local last: { any }? = nil
	local offAll = store:subscribe(nil, function(k: string, newV: any, oldV: any)
		last = { k, newV, oldV }
	end)
	store:set("esp.maxDistance", 200)
	check(last ~= nil, "global listener fired")
	eq((last :: { any })[1], "esp.maxDistance", "global listener key")
	eq((last :: { any })[2], 200, "global listener new value")
	eq((last :: { any })[3], 1500, "global listener old value")
	offAll()

	-- setMany is all-or-nothing + single undo.
	local mOk, _ = store:setMany({ ["esp.enabled"] = false, ["esp.maxDistance"] = 300 })
	check(mOk, "setMany applies")
	local mBad = store:setMany({ ["esp.enabled"] = true, ["bogus"] = 1 })
	check(not mBad and store:get("esp.enabled") == false, "setMany rejects atomically")
	store:undo()
	eq(store:get("esp.maxDistance"), 200, "setMany undoes as one entry")

	-- Transactions: coalesce + nest + rollback.
	store:transaction(function(s: Store.Store)
		s:set("esp.enabled", true)
		s:set("esp.enabled", false)
		s:set("esp.maxDistance", 400)
	end)
	store:undo()
	eq(store:get("esp.maxDistance"), 200, "transaction undoes as one")
	store:set("esp.enabled", false) -- ensure the outer write is a real change
	store:transaction(function(s: Store.Store)
		s:set("esp.enabled", true)
		s:transaction(function(s2: Store.Store)
			s2:set("esp.maxDistance", 500)
		end)
	end)
	store:undo()
	check(store:get("esp.enabled") == false and store:get("esp.maxDistance") == 200, "nested tx single undo")
	local txOk = pcall(function()
		store:transaction(function(s: Store.Store)
			s:set("esp.enabled", true)
			error("mid-tx boom")
		end)
	end)
	check(not txOk and store:get("esp.enabled") == false, "tx error rolls back + rethrows")

	-- Undo/redo stacks.
	check(store:canUndo(), "canUndo true")
	store:undo() -- undo the tx... exercised below deterministically instead
	local s2 = Store.new()
	s2:set("esp.enabled", true)
	s2:set("esp.maxDistance", 250)
	s2:undo()
	eq(s2:get("esp.maxDistance"), 1500, "undo restores")
	check(s2:canRedo(), "canRedo after undo")
	s2:redo()
	eq(s2:get("esp.maxDistance"), 250, "redo reapplies")
	s2:set("esp.teamCheck", false) -- new write clears redo
	check(not s2:canRedo(), "new write clears redo")
	check(not Store.new():undo(), "undo on empty history false")

	-- Reset (single undo step back to the pre-reset state).
	s2:set("esp.enabled", true)
	s2:reset()
	eq(s2:get("esp.enabled"), false, "reset restores defaults")
	s2:undo()
	check(s2:get("esp.enabled") == true, "reset undoes as one")
	s2:resetKey("esp.enabled")
	eq(s2:get("esp.enabled"), false, "resetKey restores one")

	-- Export / import round-trip.
	local snap = s2:export()
	snap["esp.enabled"] = true
	snap["bogus"] = 1
	local warns = s2:import(snap)
	check(s2:get("esp.enabled") == true, "import applies")
	check(#warns == 1, "import warns on dropped key")
	s2:undo()
	check(s2:get("esp.enabled") == false, "import undoes as one")

	-- Profiles.
	s2:applyProfile("Rage")
	check(s2:get("esp.enabled") == true and s2:get("config.profile") == "Rage", "applyProfile Rage")

	-- Autosave is debounced, flush forces it.
	local saved: { any } = {}
	local s3 = Store.new(nil, { autosave = function(st) table.insert(saved, st["esp.enabled"]) end })
	s3:set("esp.enabled", true)
	s3:set("esp.enabled", false)
	s3:set("esp.enabled", true)
	s3:flushAutosave()
	eq(#saved, 1, "autosave debounced to one write")
	eq(saved[1], true, "autosave captures latest")
	s3:destroy()
end

-- ============================================================================
section("Persistence shape (mock HttpService JSON)")
-- ============================================================================

do
	local Mock = require("mock")
	local http = Mock.HttpService
	local store = Store.new()
	store:set("esp.enabled", true)
	store:set("esp.targets", { "Players", "NPCs" })
	store:set("colors.enemy", { h = 0.1, s = 0.2, v = 0.3, a = 0.4 })
	store:set("view.world.brightness", 1.5)

	local json = http:JSONEncode(store:export())
	check(type(json) == "string" and #json > 100, "export encodes to JSON")
	local back = http:JSONDecode(json)
	local store2 = Store.new()
	local warns = store2:import(back)
	check(#warns == 0, "JSON round-trip imports cleanly")
	check(Util.deepEqual(store:export(), store2:export()), "JSON round-trip preserves state")
end

-- ============================================================================
print(string.format("\n==== logic: %d passed, %d failed ====", passCount, failCount))
if failCount > 0 then
	print("Failures:")
	for _, f in failures do
		print("  " .. f)
	end
	error(failCount .. " logic test(s) failed", 0)
end
