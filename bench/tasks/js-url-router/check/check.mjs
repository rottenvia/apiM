// Hidden grader for js-url-router. cwd = copy of the agent's workspace.
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

let cases = 0;
let passed = 0;
async function test(label, fn) {
  cases++;
  try {
    await fn();
    passed++;
  } catch (e) {
    console.log(`FAIL ${label}: ${String(e?.message ?? e).split("\n").slice(0, 3).join(" ")}`);
  }
}
function finish() {
  console.log(`SCORE ${passed}/${cases}`);
  process.exit(passed === cases ? 0 : 1);
}

let createRouter;
try {
  ({ createRouter } = await import(pathToFileURL(path.resolve("router.js")).href));
  if (typeof createRouter !== "function") throw new Error("router.js does not export createRouter");
} catch (e) {
  console.log(`FAIL import router.js: ${e.message}`);
  cases = 1;
  finish();
}

const plain = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o)) : o);

/** Build a router from [method, pattern] pairs; each handler is a tagged function. */
function build(routes) {
  const r = createRouter();
  const handlers = {};
  for (const [m, p] of routes) {
    const h = () => `${m} ${p}`;
    handlers[`${m} ${p}`] = h;
    r.add(m, p, h);
  }
  return { r, handlers };
}

function expect200(r, method, url, route, params) {
  const m = r.match(method, url);
  assert.ok(m && m.status === 200, `${method} ${url}: expected 200, got ${JSON.stringify(m && { ...m, handler: undefined })}`);
  assert.equal(m.route, route, `${method} ${url}: expected route ${route}, got ${m.route}`);
  if (params !== undefined) assert.deepEqual(plain(m.params), params, `${method} ${url}: params ${JSON.stringify(m.params)}`);
  return m;
}
function expectStatus(r, method, url, status) {
  const m = r.match(method, url);
  assert.equal(m?.status, status, `${method} ${url}: expected ${status}, got ${m?.status}`);
  return m;
}

await test("add is chainable and returns the handler on match", () => {
  const r = createRouter();
  const h = () => "h";
  assert.equal(r.add("GET", "/", h), r);
  const m = r.match("GET", "/");
  assert.equal(m.status, 200);
  assert.equal(m.handler, h);
  assert.equal(m.route, "/");
  assert.deepEqual(plain(m.params), {});
  assert.deepEqual(plain(m.query), {});
});

await test("params, trailing slash, case-sensitive statics", () => {
  const { r } = build([["GET", "/users/:id"], ["GET", "/users"]]);
  expect200(r, "GET", "/users/42", "/users/:id", { id: "42" });
  expect200(r, "GET", "/users/42/", "/users/:id", { id: "42" });
  expect200(r, "GET", "/users/", "/users", {});
  expectStatus(r, "GET", "/users/42/posts", 404);
  expectStatus(r, "GET", "/Users/42", 404);
});

await test("multiple params", () => {
  const { r } = build([["GET", "/orgs/:org/repos/:repo"]]);
  expect200(r, "GET", "/orgs/acme/repos/web", "/orgs/:org/repos/:repo", { org: "acme", repo: "web" });
  expectStatus(r, "GET", "/orgs/acme/repos", 404);
});

await test("params are percent-decoded after splitting", () => {
  const { r } = build([["GET", "/files/:name"], ["GET", "/users/:id"]]);
  expect200(r, "GET", "/users/j%C3%B6rg", "/users/:id", { id: "jörg" });
  expect200(r, "GET", "/files/a%2Fb", "/files/:name", { name: "a/b" });
  expect200(r, "GET", "/files/two%20words", "/files/:name", { name: "two words" });
});

await test("malformed percent-encoding in the path is a 400", () => {
  const { r } = build([["GET", "/users/:id"]]);
  expectStatus(r, "GET", "/users/%E0%A4%A", 400);
  expectStatus(r, "GET", "/users/100%", 400);
});

await test("optional trailing param", () => {
  const { r } = build([["GET", "/posts/:id/:format?"]]);
  const m = expect200(r, "GET", "/posts/7", "/posts/:id/:format?", { id: "7" });
  assert.ok(!Object.keys(m.params).includes("format"), "absent optional param must not be a key of params");
  expect200(r, "GET", "/posts/7/json", "/posts/:id/:format?", { id: "7", format: "json" });
  expectStatus(r, "GET", "/posts/7/json/extra", 404);
  expectStatus(r, "GET", "/posts", 404);
});

await test("several optional params", () => {
  const { r } = build([["GET", "/archive/:year?/:month?"]]);
  expect200(r, "GET", "/archive", "/archive/:year?/:month?", {});
  expect200(r, "GET", "/archive/2024", "/archive/:year?/:month?", { year: "2024" });
  expect200(r, "GET", "/archive/2024/05/", "/archive/:year?/:month?", { year: "2024", month: "05" });
  expectStatus(r, "GET", "/archive/2024/05/01", 404);
});

await test("wildcard matches the rest, including nothing", () => {
  const { r } = build([["GET", "/static/*"]]);
  expect200(r, "GET", "/static/css/app.css", "/static/*", { "*": "css/app.css" });
  expect200(r, "GET", "/static/a%20b/c", "/static/*", { "*": "a b/c" });
  expect200(r, "GET", "/static", "/static/*", { "*": "" });
  expectStatus(r, "GET", "/assets/x", 404);
});

await test("static beats param regardless of registration order", () => {
  const { r } = build([["GET", "/users/:id"], ["GET", "/users/me"]]);
  expect200(r, "GET", "/users/me", "/users/me", {});
  expect200(r, "GET", "/users/7", "/users/:id", { id: "7" });
});

await test("earliest differing segment decides", () => {
  const { r } = build([["GET", "/a/:y/c"], ["GET", "/a/b/:x"]]);
  expect200(r, "GET", "/a/b/c", "/a/b/:x", { x: "c" });
  expect200(r, "GET", "/a/z/c", "/a/:y/c", { y: "z" });
  const r2 = build([["GET", "/:p/b/c"], ["GET", "/a/:q/:r"]]).r;
  expect200(r2, "GET", "/a/b/c", "/a/:q/:r", { q: "b", r: "c" });
});

await test("param beats wildcard", () => {
  const { r } = build([["GET", "/files/*"], ["GET", "/files/:name"], ["GET", "/files/:name/raw"]]);
  expect200(r, "GET", "/files/x", "/files/:name", { name: "x" });
  expect200(r, "GET", "/files/x/raw", "/files/:name/raw", { name: "x" });
  expect200(r, "GET", "/files/x/y", "/files/*", { "*": "x/y" });
});

await test("a longer static prefix beats an earlier wildcard", () => {
  const { r } = build([["GET", "/*"], ["GET", "/api/*"], ["GET", "/api/v1/users"]]);
  expect200(r, "GET", "/api/v1/users", "/api/v1/users", {});
  expect200(r, "GET", "/api/v2/users", "/api/*", { "*": "v2/users" });
  expect200(r, "GET", "/about", "/*", { "*": "about" });
});

await test("ties go to the route added first", () => {
  const a = build([["GET", "/posts/:id"], ["GET", "/posts/:id/:format?"]]).r;
  expect200(a, "GET", "/posts/1", "/posts/:id");
  const b = build([["GET", "/posts/:id/:format?"], ["GET", "/posts/:id"]]).r;
  expect200(b, "GET", "/posts/1", "/posts/:id/:format?");
  const c = build([["GET", "/x/:a"], ["GET", "/x/:b"]]).r;
  expect200(c, "GET", "/x/1", "/x/:a", { a: "1" });
});

await test("methods are case-insensitive", () => {
  const { r } = build([["get", "/ping"]]);
  expect200(r, "GET", "/ping", "/ping");
  expect200(r, "Get", "/ping", "/ping");
});

await test("405 with sorted allow list and HEAD for GET", () => {
  const { r } = build([["POST", "/items"], ["PUT", "/items/:id"], ["GET", "/items/:id"], ["DELETE", "/items/:id"], ["get", "/items/:id/:x?"]]);
  const m = expectStatus(r, "PATCH", "/items/5", 405);
  assert.deepEqual(m.allow, ["DELETE", "GET", "HEAD", "PUT"]);
  const m2 = expectStatus(r, "GET", "/items", 405);
  assert.deepEqual(m2.allow, ["POST"]);
});

await test("404 when no route matches the path for any method", () => {
  const { r } = build([["POST", "/items"], ["GET", "/items/:id"]]);
  expectStatus(r, "GET", "/nothing", 404);
  expectStatus(r, "DELETE", "/items/1/2", 404);
});

await test("routes for other methods do not win: method filter before specificity", () => {
  const { r } = build([["GET", "/users/:id"], ["POST", "/users/me"]]);
  expect200(r, "GET", "/users/me", "/users/:id", { id: "me" });
  expect200(r, "POST", "/users/me", "/users/me", {});
  const m = expectStatus(r, "POST", "/users/7", 405);
  assert.deepEqual(m.allow, ["GET", "HEAD"]);
});

await test("HEAD falls back to GET, but a HEAD route is used when present", () => {
  const { r, handlers } = build([["GET", "/users/:id"]]);
  const m = expect200(r, "HEAD", "/users/1", "/users/:id", { id: "1" });
  assert.equal(m.handler, handlers["GET /users/:id"]);
  const b = build([["GET", "/users/:id"], ["HEAD", "/users/:id"]]);
  const m2 = expect200(b.r, "HEAD", "/users/1", "/users/:id");
  assert.equal(m2.handler, b.handlers["HEAD /users/:id"]);
  expectStatus(b.r, "POST", "/users/1", 405);
});

await test("'*' method routes match every method", () => {
  const { r } = build([["*", "/health"], ["GET", "/only-get"]]);
  expect200(r, "DELETE", "/health", "/health");
  expect200(r, "GET", "/health", "/health");
  expectStatus(r, "OPTIONS", "/only-get", 405);
});

await test("query string parsing", () => {
  const { r } = build([["GET", "/search"]]);
  const m = expect200(r, "GET", "/search?q=two%20words&page=2&tag=a&tag=b&tag=c&flag&sp=x+y", "/search");
  assert.deepEqual(plain(m.query), { q: "two words", page: "2", tag: ["a", "b", "c"], flag: "", sp: "x y" });
  const m2 = expect200(r, "GET", "/search?na%20me=v%26w", "/search");
  assert.deepEqual(plain(m2.query), { "na me": "v&w" });
  const m3 = expect200(r, "GET", "/search?", "/search");
  assert.deepEqual(plain(m3.query), {});
});

await test("fragment is ignored; query on a trailing-slash path", () => {
  const { r } = build([["GET", "/users/:id"]]);
  const m = expect200(r, "GET", "/users/1/?tab=posts#top", "/users/:id", { id: "1" });
  assert.deepEqual(plain(m.query), { tab: "posts" });
  const m2 = expect200(r, "GET", "/users/1#section", "/users/:id", { id: "1" });
  assert.deepEqual(plain(m2.query), {});
});

await test("malformed %-encoding in the query keeps the raw text", () => {
  const { r } = build([["GET", "/search"]]);
  const m = r.match("GET", "/search?q=%E0%A4%A&ok=1");
  assert.equal(m.status, 200, `expected 200, got ${m.status}`);
  assert.deepEqual(plain(m.query), { q: "%E0%A4%A", ok: "1" });
});

finish();
