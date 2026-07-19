/* Mock Google Maps (Geocoding + Routes v2) for e2e. */
import http from "node:http";
const PORT = Number(process.env.PORT || 8906);
const KEY = "gmaps-e2e-key";
let geocodes = 0, routes = 0;
const server = http.createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = ""; for await (const c of req) body += c;

  if (url.pathname === "/__stats") return send(200, { geocodes, routes });

  if (req.method === "GET" && url.pathname === "/maps/api/geocode/json") {
    if (url.searchParams.get("key") !== KEY) return send(200, { status: "REQUEST_DENIED", error_message: "bad key" });
    geocodes++;
    return send(200, { status: "OK", results: [{ geometry: { location: { lat: 47.6042, lng: -117.3925 } } }] });
  }
  if (req.method === "POST" && url.pathname === "/directions/v2:computeRoutes") {
    if (req.headers["x-goog-api-key"] !== KEY) return send(403, { error: { message: "API key not valid" } });
    routes++;
    return send(200, { routes: [{ duration: "720s" }] }); // 12 minutes for every hop
  }
  send(404, { error: { message: "no route" } });
});
server.listen(PORT, () => console.log(`mock-gmaps on http://localhost:${PORT}`));
