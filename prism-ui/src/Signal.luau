--!strict
-- ============================================================================
--  PRISM-UI · Signal
-- ----------------------------------------------------------------------------
--  A tiny multi-subscriber event bus used for store subscriptions, widget
--  callbacks and picker notifications.
--
--  Guarantees (all covered by tests):
--    * Handlers fire in subscription order.
--    * Connect/Disconnect DURING a Fire is safe: the firing pass iterates a
--      snapshot, so a handler that disconnects itself (or others) does not
--      corrupt the iteration.
--    * One failing handler never starves the rest: every handler runs, and
--      the FIRST error is rethrown after the pass completes.
--    * No yielding: there is no :Wait(). Async flows use callbacks.
-- ============================================================================

export type Connection = {
	Connected: boolean,
	Disconnect: (self: Connection) -> (),
}

export type Signal<T...> = {
	Connect: (self: Signal<T...>, fn: (T...) -> ()) -> Connection,
	Once: (self: Signal<T...>, fn: (T...) -> ()) -> Connection,
	Fire: (self: Signal<T...>, T...) -> (),
	DisconnectAll: (self: Signal<T...>) -> (),
	Count: (self: Signal<T...>) -> number,
	Destroy: (self: Signal<T...>) -> (),
	Destroyed: boolean,
}

local Signal = {}

--- Create a new signal.
function Signal.new<T...>(): Signal<T...>
	local handlers: { (T...) -> () } = {}
	local alive: { [any]: boolean } = {}
	local destroyed = false

	local sig: Signal<T...>

	local function disconnectFn(fn: (T...) -> ())
		if alive[fn] then
			alive[fn] = nil
			for i = #handlers, 1, -1 do
				if handlers[i] == fn then
					table.remove(handlers, i)
					break
				end
			end
		end
	end

	sig = {
		Destroyed = false,

		Connect = function(_self: Signal<T...>, fn: (T...) -> ()): Connection
			assert(not destroyed, "Signal: Connect on a destroyed signal")
			assert(type(fn) == "function", "Signal: Connect expects a function")
			table.insert(handlers, fn)
			alive[fn] = true
			local conn: Connection
			conn = {
				Connected = true,
				Disconnect = function(_c: Connection)
					if conn.Connected then
						conn.Connected = false
						disconnectFn(fn)
					end
				end,
			}
			return conn
		end,

		Once = function(_self: Signal<T...>, fn: (T...) -> ()): Connection
			assert(not destroyed, "Signal: Once on a destroyed signal")
			local conn: Connection? = nil
			conn = sig:Connect(function(...: T...)
				local c = conn :: Connection
				if c.Connected then
					c:Disconnect()
				end
				fn(...)
			end)
			return conn :: Connection
		end,

		Fire = function(_self: Signal<T...>, ...: T...)
			if destroyed or #handlers == 0 then
				return
			end
			-- Snapshot: handlers may (dis)connect during the pass.
			local snapshot: { (T...) -> () } = {}
			for i = 1, #handlers do
				snapshot[i] = handlers[i]
			end
			local firstErr: any = nil
			local failed = false
			for i = 1, #snapshot do
				local fn = snapshot[i]
				if alive[fn] then -- skip handlers disconnected mid-pass
					local ok, err = pcall(fn, ...)
					if not ok and not failed then
						failed = true
						firstErr = err
					end
				end
			end
			if failed then
				error(firstErr, 0)
			end
		end,

		DisconnectAll = function(_self: Signal<T...>)
			table.clear(handlers)
			table.clear(alive)
		end,

		Count = function(_self: Signal<T...>): number
			return #handlers
		end,

		Destroy = function(_self: Signal<T...>)
			destroyed = true
			sig.Destroyed = true
			table.clear(handlers)
			table.clear(alive)
		end,
	}

	return sig
end

return Signal
