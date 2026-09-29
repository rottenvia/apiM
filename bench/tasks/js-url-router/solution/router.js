/**
 * Path router. (Reference solution — see the spec in the task's router.js.)
 */

const RANK = { static: 2, param: 1, wildcard: 0 };

function parsePattern(pattern) {
  const parts = pattern.split("/").filter(Boolean);
  return parts.map((p, i) => {
    if (p === "*") {
      if (i !== parts.length - 1) throw new Error(`wildcard must be last in ${pattern}`);
      return { kind: "wildcard" };
    }
    if (p.startsWith(":")) {
      const optional = p.endsWith("?");
      return { kind: "param", name: optional ? p.slice(1, -1) : p.slice(1), optional };
    }
    return { kind: "static", text: p };
  });
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseQuery(qs) {
  const query = {};
  if (!qs) return query;
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawK = eq < 0 ? pair : pair.slice(0, eq);
    const rawV = eq < 0 ? "" : pair.slice(eq + 1);
    const k = safeDecode(rawK.replace(/\+/g, " "));
    const v = safeDecode(rawV.replace(/\+/g, " "));
    if (Object.prototype.hasOwnProperty.call(query, k)) {
      const prev = query[k];
      query[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else {
      Object.defineProperty(query, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
  }
  return query;
}

/** Returns { params, ranks } or null. */
function matchParts(parts, segs) {
  const params = {};
  const ranks = [];
  let i = 0;
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    if (part.kind === "wildcard") {
      params["*"] = segs.slice(i).join("/");
      for (; i < segs.length; i++) ranks.push(RANK.wildcard);
      return { params, ranks };
    }
    if (i >= segs.length) {
      if (part.kind === "param" && part.optional) continue;
      return null;
    }
    if (part.kind === "static") {
      if (segs[i] !== part.text) return null;
      ranks.push(RANK.static);
    } else {
      Object.defineProperty(params, part.name, { value: segs[i], enumerable: true, writable: true, configurable: true });
      ranks.push(RANK.param);
    }
    i++;
  }
  return i === segs.length ? { params, ranks } : null;
}

function better(a, b) {
  for (let i = 0; i < a.ranks.length; i++) {
    if (a.ranks[i] !== b.ranks[i]) return a.ranks[i] > b.ranks[i];
  }
  return a.order < b.order;
}

export function createRouter() {
  const routes = [];

  const router = {
    add(method, pattern, handler) {
      routes.push({ method: method.toUpperCase(), pattern, parts: parsePattern(pattern), handler, order: routes.length });
      return router;
    },

    match(method, url) {
      method = method.toUpperCase();
      let target = url;
      const hash = target.indexOf("#");
      if (hash >= 0) target = target.slice(0, hash);
      const q = target.indexOf("?");
      const pathPart = q >= 0 ? target.slice(0, q) : target;
      const queryPart = q >= 0 ? target.slice(q + 1) : "";

      let segs;
      try {
        segs = pathPart.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
      } catch {
        return { status: 400 };
      }

      const matching = [];
      for (const r of routes) {
        const m = matchParts(r.parts, segs);
        if (m) matching.push({ route: r, ...m, order: r.order });
      }
      if (!matching.length) return { status: 404 };

      const pick = (want) => {
        let best = null;
        for (const m of matching) {
          if (m.route.method !== want && m.route.method !== "*") continue;
          if (!best || better(m, best)) best = m;
        }
        return best;
      };
      let best = pick(method);
      if (!best && method === "HEAD") best = pick("GET");
      if (!best) {
        const allow = new Set(matching.map((m) => m.route.method));
        if (allow.has("GET")) allow.add("HEAD");
        return { status: 405, allow: [...allow].sort() };
      }
      return { status: 200, handler: best.route.handler, params: best.params, query: parseQuery(queryPart), route: best.route.pattern };
    },
  };
  return router;
}
