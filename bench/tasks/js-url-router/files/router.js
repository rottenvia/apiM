/**
 * Path router.
 *
 *   const router = createRouter();
 *   router.add("GET", "/users/:id", handler);
 *   router.match("GET", "/users/42?tab=posts");
 *
 * router.add(method, pattern, handler)
 *   method   an HTTP method, case-insensitive ("get" == "GET"), or "*" for
 *            any method. Returns the router so calls can be chained.
 *   pattern  a path made of "/"-separated segments:
 *              static    "users"      matches exactly that text (case-sensitive)
 *              param     ":id"        matches any one non-empty segment
 *              optional  ":format?"   like a param, but the segment may be
 *                                     absent. Optional params only appear at
 *                                     the end of a pattern (possibly several).
 *              wildcard  "*"          only as the last segment; matches the
 *                                     rest of the path: zero or more segments
 *            "/" is the root pattern.
 *
 * router.match(method, url) -> one of
 *   { status: 200, handler, params, query, route }
 *   { status: 404 }                     no route matches the path at all
 *   { status: 405, allow }              some route matches the path, but
 *                                       none for this method
 *   { status: 400 }                     the path has malformed %-encoding
 *
 *   url      a request target: path, optional "?query", optional "#fragment"
 *            (the fragment is ignored). A trailing slash is ignored, so
 *            "/users/42/" is the same as "/users/42". Split the path into
 *            segments first, then percent-decode each segment, so "%2F"
 *            inside a segment does not create a new segment.
 *   params   an object of decoded param values by name. An optional param
 *            that is absent is not a key of params. The wildcard's value is
 *            params["*"]: the matched remaining segments, decoded, joined
 *            with "/" ("" when it matched nothing).
 *   query    an object parsed from the query string: "+" means space, keys
 *            and values are percent-decoded, a key without "=" has value "",
 *            a key that appears more than once gets an array of its values
 *            in order; {} when there is no query. Malformed %-encoding in
 *            the query leaves that key/value as the raw text.
 *   route    the pattern string of the route that matched.
 *
 * Method matching:
 *   - Routes whose method does not match the request are ignored when
 *     choosing a winner: if GET /users/:id and POST /users/me exist,
 *     GET /users/me is a 200 for /users/:id.
 *   - A HEAD request that matches no HEAD route is served by the matching
 *     GET route (as if it were a GET).
 *   - "*" routes match every method.
 *
 * Which route wins when several match (for the request's method):
 *   Compare the candidate routes path segment by path segment, left to
 *   right. For each segment of the request path, the kind of pattern part
 *   that matched it ranks: static > param (incl. optional) > wildcard.
 *   The first segment where two candidates differ decides. If they never
 *   differ, the route added first wins.
 *   e.g. for /a/b/c: "/a/b/:x" beats "/a/:y/c" (segment 2: static beats
 *   param), and "/files/:name" beats "/files/*" for /files/x.
 *
 * 405: `allow` is the list of methods (upper-case, no duplicates, sorted
 * alphabetically) of the routes whose pattern matches the path; if it
 * contains GET it also contains HEAD.
 */

export function createRouter() {
  throw new Error("not implemented");
}
