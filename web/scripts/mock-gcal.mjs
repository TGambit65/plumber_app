/* Mock Google Calendar API for e2e (token + calendars + events + freeBusy). */
import http from "node:http";
const PORT = Number(process.env.PORT || 8905);
const REFRESH = "gcal-e2e-refresh";
const events = [];
const server = http.createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = ""; for await (const c of req) body += c;

  if (req.method === "GET" && url.pathname === "/__events") return send(200, events);

  if (req.method === "POST" && url.pathname === "/token") {
    const p = new URLSearchParams(body);
    if (p.get("refresh_token") !== REFRESH) return send(400, { error: "invalid_grant" });
    return send(200, { access_token: "gcal-e2e-access", expires_in: 3600 });
  }
  if ((req.headers.authorization ?? "") !== "Bearer gcal-e2e-access") return send(401, { error: { message: "Invalid Credentials" } });

  if (req.method === "GET" && url.pathname.startsWith("/calendar/v3/calendars/") && !url.pathname.includes("/events")) {
    return send(200, { id: "dispatch@plumbzebra.demo", summary: "PZ Dispatch (mock)" });
  }
  if (req.method === "POST" && url.pathname.endsWith("/events")) {
    const e = JSON.parse(body);
    const id = `gev-${events.length + 1}`;
    events.push({ id, ...e });
    return send(200, { id, ...e });
  }
  if (req.method === "PATCH" && url.pathname.includes("/events/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    events.push({ id, patched: true, ...JSON.parse(body) });
    return send(200, { id });
  }
  if (req.method === "POST" && url.pathname === "/calendar/v3/freeBusy") {
    const q = JSON.parse(body);
    // Whole requested window is "busy" → every scheduled job that day conflicts.
    return send(200, { calendars: { "dispatch@plumbzebra.demo": { busy: [{ start: q.timeMin, end: q.timeMax }] } } });
  }
  send(404, { error: { message: `no route ${req.method} ${url.pathname}` } });
});
server.listen(PORT, () => console.log(`mock-gcal on http://localhost:${PORT}`));
