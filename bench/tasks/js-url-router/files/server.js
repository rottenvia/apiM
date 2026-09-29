import http from "node:http";

// TODO: switch to router.js once it exists.
const users = new Map([["1", { id: "1", name: "Ada" }], ["2", { id: "2", name: "Linus" }]]);

const server = http.createServer((req, res) => {
  const [path] = req.url.split("?");
  if (req.method === "GET" && path === "/users") {
    return send(res, 200, [...users.values()]);
  }
  if (req.method === "GET" && path.startsWith("/users/")) {
    const user = users.get(path.slice("/users/".length));
    return user ? send(res, 200, user) : send(res, 404, { error: "not found" });
  }
  send(res, 404, { error: "not found" });
});

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  server.listen(process.env.PORT ?? 3000, () => console.log("listening"));
}

export default server;
