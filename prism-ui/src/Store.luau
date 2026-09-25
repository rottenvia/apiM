--!strict
-- ============================================================================
--  PRISM-UI · Store
-- ----------------------------------------------------------------------------
--  The single state container for all settings. Features:
--    * Schema-validated writes (invalid values are REJECTED, never stored).
--    * Defensive copies on the way in and out (callers can't mutate state
--      through a leaked table reference).
--    * Per-key + global subscriptions.
--    * Transactions (coalesced history + deferred notify, nestable, with
--      rollback when the body errors).
--    * Undo / redo with a bounded history.
--    * Debounced autosave hook (the host decides where bytes go).
--
--  Concurrency model: single-threaded with re-entrant notifications. A
--  subscriber that calls :set() re-enters cleanly (history stays ordered,
--  no iterator is held across the Fire).
-- ============================================================================

local Schema = require("./Schema")
local Signal = require("./Signal")
local Util = require("./Util")

export type HistoryEntry = {
	many: boolean,
	key: string?, -- set for single-key entries
	from: any,
	to: any,
	changes: { [string]: { from: any, to: any } }?, -- set for multi entries
}

export type Store = {
	get: (self: Store, key: string) -> any,
	set: (self: Store, key: string, value: any, opts: { silent: boolean? }?) -> (boolean, string?),
	setMany: (self: Store, values: { [string]: any }) -> (boolean, string?),
	transaction: (self: Store, fn: (Store) -> ()) -> (),
	reset: (self: Store) -> (),
	resetKey: (self: Store, key: string) -> (),
	subscribe: (self: Store, key: string?, fn: (string, any, any) -> ()) -> (() -> ()),
	undo: (self: Store) -> boolean,
	redo: (self: Store) -> boolean,
	canUndo: (self: Store) -> boolean,
	canRedo: (self: Store) -> boolean,
	export: (self: Store) -> { [string]: any },
	import: (self: Store, data: { [string]: any }) -> { string },
	applyProfile: (self: Store, name: string) -> (),
	flushAutosave: (self: Store) -> (),
	setAutosave: (self: Store, cb: ((state: { [string]: any }) -> ())?) -> (),
	destroy: (self: Store) -> (),
	changed: Signal.Signal<string, any, any>,
	initWarnings: { string },
}

local Store = {}

export type StoreOpts = {
	historyLimit: number?,
	autosave: ((state: { [string]: any }) -> ())?,
	autosaveDelay: number?,
}

--- Create a store. `initial` (optional) is migrated like an import; any
--- problems land in `store.initWarnings` instead of throwing.
function Store.new(initial: { [string]: any }?, opts: StoreOpts?): Store
	local options: StoreOpts = opts or {}
	local historyLimit = options.historyLimit or 100

	local state: { [string]: any }
	local initWarnings: { string } = {}
	if initial ~= nil then
		state, initWarnings = Schema.migrate(initial)
	else
		state = Schema.defaults()
	end

	local changed = Signal.new() :: Signal.Signal<string, any, any>
	local history: { HistoryEntry } = {}
	local future: { HistoryEntry } = {} -- redo stack

	-- Transaction batching.
	local txDepth = 0
	local txFirst: { [string]: any } = {} -- key -> value at tx entry
	local txTouched: { [string]: boolean } = {}
	local txSnapshot: { [string]: any }? = nil

	local autosaveCb = options.autosave
	local autosaver = Util.debounce(function()
		if autosaveCb ~= nil then
			autosaveCb(Util.deepCopy(state))
		end
	end, options.autosaveDelay or 0.5)

	local store: Store

	local function pushHistory(entry: HistoryEntry)
		table.insert(history, entry)
		if #history > historyLimit then
			table.remove(history, 1)
		end
		table.clear(future) -- any new write discards the redo branch
	end

	local function scheduleAutosave()
		if autosaveCb ~= nil then
			autosaver.call()
		end
	end

	-- Notify helper. (Luau forbids a leading ";" at the start of a block,
	-- so calls are routed through here instead of starting a statement
	-- with a parenthesized cast.)
	local function fireChanged(key: string, newV: any, oldV: any)
		local sig = changed :: any
		sig:Fire(key, newV, oldV)
	end

	-- The single write path. Records history + notifies unless told not to.
	local function write(key: string, value: any, silent: boolean)
		local old = state[key]
		state[key] = value
		if txDepth > 0 then
			if txTouched[key] == nil then
				txTouched[key] = true
				txFirst[key] = Util.deepCopy(old)
			end
		else
			pushHistory({ many = false, key = key, from = Util.deepCopy(old), to = Util.deepCopy(value) })
		end
		if not silent then
			fireChanged(key, Util.deepCopy(value), Util.deepCopy(old))
			scheduleAutosave()
		end
	end

	store = {
		changed = changed,
		initWarnings = initWarnings,

		get = function(_self: Store, key: string): any
			assert(Schema.get(key) ~= nil, "Store:get unknown key '" .. tostring(key) .. "'")
			return Util.deepCopy(state[key])
		end,

		set = function(_self: Store, key: string, value: any, setOpts: { silent: boolean? }?): (boolean, string?)
			local field = Schema.get(key)
			if field == nil then
				return false, "unknown setting '" .. tostring(key) .. "'"
			end
			local ok, norm, err = Schema.validate(key, value)
			if not ok then
				return false, err
			end
			if Util.deepEqual(state[key], norm) then
				return true, nil -- no-op: no history, no notify, no autosave
			end
			local silent = setOpts ~= nil and setOpts.silent == true
			write(key, Util.deepCopy(norm), silent)
			return true, nil
		end,

		setMany = function(_self: Store, values: { [string]: any }): (boolean, string?)
			-- Validate everything BEFORE touching state (all-or-nothing).
			local normed: { [string]: any } = {}
			for k, v in values do
				local field = Schema.get(k)
				if field == nil then
					return false, "unknown setting '" .. tostring(k) .. "'"
				end
				local ok, norm, err = Schema.validate(k, v)
				if not ok then
					return false, err
				end
				normed[k] = norm
			end
			store:transaction(function(s: Store)
				for k, v in normed do
					s:set(k, v)
				end
			end)
			return true, nil
		end,

		transaction = function(_self: Store, fn: (Store) -> ())
			assert(type(fn) == "function", "Store:transaction expects a function")
			txDepth += 1
			if txDepth == 1 then
				txSnapshot = Util.deepCopy(state)
				table.clear(txFirst)
				table.clear(txTouched)
			end
			local ok, err = pcall(fn, store)
			txDepth -= 1
			if not ok then
				if txDepth == 0 then
					-- Roll back to the entry snapshot, silently.
					state = txSnapshot :: { [string]: any }
					table.clear(txFirst)
					table.clear(txTouched)
					txSnapshot = nil
				end
				error(err, 0)
			end
			if txDepth == 0 then
				-- Commit: one history entry + deferred notifications.
				local changes: { [string]: { from: any, to: any } } = {}
				local count = 0
				for k, _ in txTouched do
					local from = txFirst[k]
					local to = state[k]
					if not Util.deepEqual(from, to) then
						changes[k] = { from = Util.deepCopy(from), to = Util.deepCopy(to) }
						count += 1
					end
				end
				table.clear(txFirst)
				table.clear(txTouched)
				txSnapshot = nil
				if count == 1 then
					local onlyKey = next(changes) :: string
					local c = changes[onlyKey]
					pushHistory({ many = false, key = onlyKey, from = c.from, to = c.to })
				elseif count > 1 then
					pushHistory({ many = true, changes = changes })
				end
				if count > 0 then
					for _, k in ipairs(Util.keys(changes)) do
						local c = changes[k]
						fireChanged(k, Util.deepCopy(c.to), Util.deepCopy(c.from))
					end
					scheduleAutosave()
				end
			end
		end,

		reset = function(_self: Store)
			store:transaction(function(s: Store)
				local defaults = Schema.defaults()
				for _, field in Schema.FIELDS do
					s:set(field.key, defaults[field.key])
				end
			end)
		end,

		resetKey = function(_self: Store, key: string)
			local field = Schema.get(key)
			assert(field ~= nil, "Store:resetKey unknown key '" .. tostring(key) .. "'")
			store:set(key, (field :: Schema.Field).default)
		end,

		subscribe = function(_self: Store, key: string?, fn: (string, any, any) -> ()): (() -> ())
			assert(type(fn) == "function", "Store:subscribe expects a function")
			local conn
			if key == nil then
				conn = (changed :: any):Connect(fn)
			else
				assert(Schema.get(key :: string) ~= nil, "Store:subscribe unknown key")
				local want = key :: string
				conn = (changed :: any):Connect(function(k: string, newV: any, oldV: any)
					if k == want then
						fn(k, newV, oldV)
					end
				end)
			end
			return function()
				conn:Disconnect()
			end
		end,

		undo = function(_self: Store): boolean
			local entry = history[#history]
			if entry == nil then
				return false
			end
			table.remove(history)
			table.insert(future, entry)
			if entry.many then
				local changes = entry.changes :: { [string]: { from: any, to: any } }
				for _, k in ipairs(Util.keys(changes)) do
					state[k] = Util.deepCopy(changes[k].from)
				end
				for _, k in ipairs(Util.keys(changes)) do
					local c = changes[k]
					fireChanged(k, Util.deepCopy(c.from), Util.deepCopy(c.to))
				end
			else
				local k = entry.key :: string
				state[k] = Util.deepCopy(entry.from)
				fireChanged(k, Util.deepCopy(entry.from), Util.deepCopy(entry.to))
			end
			scheduleAutosave()
			return true
		end,

		redo = function(_self: Store): boolean
			local entry = future[#future]
			if entry == nil then
				return false
			end
			table.remove(future)
			table.insert(history, entry)
			if entry.many then
				local changes = entry.changes :: { [string]: { from: any, to: any } }
				for _, k in ipairs(Util.keys(changes)) do
					state[k] = Util.deepCopy(changes[k].to)
				end
				for _, k in ipairs(Util.keys(changes)) do
					local c = changes[k]
					fireChanged(k, Util.deepCopy(c.to), Util.deepCopy(c.from))
				end
			else
				local k = entry.key :: string
				state[k] = Util.deepCopy(entry.to)
				fireChanged(k, Util.deepCopy(entry.to), Util.deepCopy(entry.from))
			end
			scheduleAutosave()
			return true
		end,

		canUndo = function(_self: Store): boolean
			return #history > 0
		end,

		canRedo = function(_self: Store): boolean
			return #future > 0
		end,

		export = function(_self: Store): { [string]: any }
			return Util.deepCopy(state)
		end,

		import = function(_self: Store, data: { [string]: any }): { string }
			local migrated, warnings = Schema.migrate(data)
			store:transaction(function(s: Store)
				for _, field in Schema.FIELDS do
					s:set(field.key, migrated[field.key])
				end
			end)
			return warnings
		end,

		applyProfile = function(_self: Store, name: string)
			local profileState = Schema.profileState(name)
			store:transaction(function(s: Store)
				for _, field in Schema.FIELDS do
					s:set(field.key, profileState[field.key])
				end
			end)
		end,

		flushAutosave = function(_self: Store)
			autosaver.flush()
		end,

		setAutosave = function(_self: Store, cb: ((state: { [string]: any }) -> ())?)
			autosaveCb = cb
		end,

		destroy = function(_self: Store)
			autosaver.cancel()
			changed:Destroy();
			(store :: any).changed = nil
		end,
	}

	return store
end

return Store
