--!strict
-- ============================================================================
--  PRISM-UI · Util
-- ----------------------------------------------------------------------------
--  Small pure helpers: math, formatting, scalar parsing ("1.5k" -> 1500),
--  deep copy/compare, deterministic ids, a testable debouncer and ranked
--  fuzzy search shared by the settings search and dropdown filters.
--
--  NOTE: `task` is always resolved as a GLOBAL at call time (never captured
--  into a module-local) so tests can inject a fake scheduler.
-- ============================================================================

local Util = {}

-- ---------------------------------------------------------------------------
-- Math
-- ---------------------------------------------------------------------------

function Util.clamp(x: number, lo: number, hi: number): number
	if x < lo then
		return lo
	elseif x > hi then
		return hi
	end
	return x
end

function Util.lerp(a: number, b: number, t: number): number
	return a + (b - a) * t
end

function Util.round(x: number): number
	return math.floor(x + 0.5)
end

--- Snap `x` to the nearest multiple of `step` above `base`.
function Util.snap(x: number, base: number, step: number): number
	if step <= 0 then
		return x
	end
	return base + math.floor((x - base) / step + 0.5) * step
end

-- ---------------------------------------------------------------------------
-- Formatting
-- ---------------------------------------------------------------------------

--- 1500 -> "1,500", -42 -> "-42". Rounds to an integer first.
function Util.formatInt(n: number): string
	local v = Util.round(n)
	local sign = ""
	if v < 0 then
		sign = "-"
		v = -v
	end
	local s = tostring(v)
	local rev = string.reverse(s)
	rev = string.gsub(rev, "(%d%d%d)", "%1,")
	rev = string.reverse(rev)
	rev = string.gsub(rev, "^,", "")
	return sign .. rev
end

local function trimFloat(s: string): string
	if string.find(s, ".", 1, true) ~= nil then
		s = string.gsub(s, "0+$", "")
		s = string.gsub(s, "%.$", "")
	end
	return s
end

--- 1500 -> "1.5k", 2000000 -> "2M", 999 -> "999".
function Util.formatCompact(n: number): string
	local a = math.abs(n)
	if a >= 1e6 then
		return trimFloat(string.format("%.1f", n / 1e6)) .. "M"
	elseif a >= 1e3 then
		return trimFloat(string.format("%.1f", n / 1e3)) .. "k"
	end
	return Util.formatInt(n)
end

--- Parse user-typed scalars: "12", "1,500", "1.5k", "2M" (case-insensitive
--- suffix, surrounding whitespace ok). Returns nil when invalid.
function Util.parseScalar(s: string): number?
	if type(s) ~= "string" then
		return nil
	end
	local num, suffix = string.match(s, "^%s*([%+%-]?[%d,]*%.?%d+)%s*([kKmM]?)%s*$")
	if num == nil or num == "" then
		return nil
	end
	local clean = string.gsub(num, ",", "")
	if clean == "" or clean == "+" or clean == "-" or clean == "." then
		return nil
	end
	local v = tonumber(clean)
	if v == nil then
		return nil
	end
	if suffix == "k" or suffix == "K" then
		v *= 1000
	elseif suffix == "M" or suffix == "m" then
		v *= 1e6
	end
	return v
end

--- Truncate `s` to `max` chars, appending "…" when cut.
function Util.truncate(s: string, max: number): string
	if #s <= max then
		return s
	end
	if max <= 1 then
		return "…"
	end
	return string.sub(s, 1, max - 1) .. "…"
end

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

--- Deep copy (cycle-safe; preserves metatables by reference, not by copy).
function Util.deepCopy<T>(value: T, seen: { [any]: any }?): T
	if type(value) ~= "table" then
		return value :: any
	end
	local seenMap: { [any]: any } = seen or {}
	local known = seenMap[value]
	if known ~= nil then
		return known
	end
	local out: { [any]: any } = {}
	seenMap[value] = out
	for k, v in value :: any do
		out[Util.deepCopy(k, seenMap)] = Util.deepCopy(v, seenMap)
	end
	return out :: any
end

local function deepEqualInner(a: any, b: any, seen: { [any]: any }): boolean
	if a == b then
		return true
	end
	if type(a) ~= "table" or type(b) ~= "table" then
		return false
	end
	if seen[a] == b then
		return true -- already compared this pair (cycle)
	end
	seen[a] = b
	for k, va in a do
		local vb = b[k]
		if vb == nil then
			return false
		end
		if not deepEqualInner(va, vb, seen) then
			return false
		end
	end
	for k, _ in b do
		if a[k] == nil then
			return false
		end
	end
	return true
end

--- Structural equality for plain data (numbers, strings, bools, tables).
function Util.deepEqual(a: any, b: any): boolean
	return deepEqualInner(a, b, {})
end

--- Shallow copy of an array or dictionary.
function Util.shallowCopy<T>(t: T): T
	local out: { [any]: any } = {}
	for k, v in t :: any do
		out[k] = v
	end
	return out :: any
end

--- Sorted key list (deterministic iteration for exports / diffs).
function Util.keys(t: { [string]: any }): { string }
	local out: { string } = {}
	for k, _ in t do
		table.insert(out, k)
	end
	table.sort(out, function(a: any, b: any): boolean
		return tostring(a) < tostring(b)
	end)
	return out
end

-- ---------------------------------------------------------------------------
-- Ids
-- ---------------------------------------------------------------------------

local idCounter = 0

--- Deterministic per-session unique id: "w0001", "w0002", … Reset only by
--- reloading the module, which is exactly the granularity widgets need.
function Util.uuid(prefix: string?): string
	idCounter += 1
	return string.format("%s%04d", prefix or "w", idCounter)
end

-- ---------------------------------------------------------------------------
-- Debounce (testable)
-- ---------------------------------------------------------------------------

export type Debouncer = {
	call: (...any) -> (),
	flush: () -> (),
	cancel: () -> (),
	pending: () -> boolean,
}

--- Coalesce rapid calls: `fn` runs once, `waitSeconds` after the LAST call.
--- `flush()` runs the pending call immediately; `cancel()` drops it.
--- Uses the global `task.delay` when available; without a scheduler the call
--- simply stays pending until `flush()`.
function Util.debounce(fn: (...any) -> (), waitSeconds: number): Debouncer
	assert(type(fn) == "function", "debounce expects a function")
	local token = 0
	local args: { any }? = nil

	local function fire(myToken: number)
		if myToken == token and args ~= nil then
			local a = args
			args = nil
			fn(table.unpack(a))
		end
	end

	local h: Debouncer
	h = {
		call = function(...: any)
			token += 1
			local myToken = token
			args = { ... }
			local scheduler: any = task -- global on purpose (see header note)
			if scheduler ~= nil and type(scheduler.delay) == "function" then
				local delayFn: any = scheduler.delay
				delayFn(waitSeconds, function()
					fire(myToken)
				end)
			end
		end,
		flush = function()
			token += 1 -- invalidate any scheduled fire
			if args ~= nil then
				local a = args
				args = nil
				fn(table.unpack(a))
			end
		end,
		cancel = function()
			token += 1
			args = nil
		end,
		pending = function(): boolean
			return args ~= nil
		end,
	}
	return h
end

-- ---------------------------------------------------------------------------
-- Ranked search
-- ---------------------------------------------------------------------------

export type SearchItem = {
	id: any,
	text: string,
	keywords: { string }?,
}

export type SearchHit = {
	id: any,
	score: number,
	index: number,
}

local function fuzzySubsequence(term: string, text: string): boolean
	-- Every char of `term` appears in `text` in order (case already folded).
	local ti = 1
	for i = 1, #text do
		if string.sub(text, i, i) == string.sub(term, ti, ti) then
			ti += 1
			if ti > #term then
				return true
			end
		end
	end
	return ti > #term
end

--- Rank `items` against a free-text query. ALL whitespace-separated terms
--- must match (AND); hits sort by score (desc), ties keep input order.
--- Empty query returns every item with score 0.
function Util.rankedSearch(items: { SearchItem }, query: string, limit: number?): { SearchHit }
	local q = string.lower(query or "")
	local terms: { string } = {}
	for term in string.gmatch(q, "%S+") do
		table.insert(terms, term)
	end
	if #terms == 0 then
		local all: { SearchHit } = {}
		for i, item in items do
			table.insert(all, { id = item.id, score = 0, index = i })
		end
		return all
	end

	local hits: { SearchHit } = {}
	for i, item in items do
		local text = string.lower(item.text or "")
		local kws: { string } = {}
		if item.keywords ~= nil then
			for _, kw in item.keywords do
				table.insert(kws, string.lower(kw))
			end
		end
		local score = 0
		local matched = true
		for _, term in terms do
			local termScore = 0
			if text == term then
				termScore = 100
			elseif string.sub(text, 1, #term) == term then
				termScore = 50
			elseif string.find(text, term, 1, true) ~= nil then
				termScore = 25
			else
				for _, kw in kws do
					if kw == term then
						termScore = math.max(termScore, 40)
					elseif string.sub(kw, 1, #term) == term then
						termScore = math.max(termScore, 20)
					elseif string.find(kw, term, 1, true) ~= nil then
						termScore = math.max(termScore, 10)
					end
				end
				if termScore == 0 and fuzzySubsequence(term, text) then
					termScore = 5
				end
			end
			if termScore == 0 then
				matched = false
				break
			end
			score += termScore
		end
		if matched then
			table.insert(hits, { id = item.id, score = score, index = i })
		end
	end
	table.sort(hits, function(a: SearchHit, b: SearchHit): boolean
		if a.score ~= b.score then
			return a.score > b.score
		end
		return a.index < b.index
	end)
	local n = limit or #hits
	if n < #hits then
		local trimmed: { SearchHit } = {}
		for i = 1, n do
			trimmed[i] = hits[i]
		end
		return trimmed
	end
	return hits
end

return Util
