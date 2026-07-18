/**
 * iCalendar (RFC 5545) feed generation — dispatch phase D2.
 *
 * PURE module (unit-testable). Generates the VCALENDAR/VEVENT stream that
 * Apple Calendar, Google Calendar, Outlook, and every other calendar client
 * consume via a subscribed URL. Apple has no public REST API, so the ICS feed
 * is the universal zero-auth calendar surface (the feed token is the
 * capability; see /api/calendar/[token]).
 */

export interface IcsEvent {
  /** Stable unique id — same job must keep the same UID across refreshes. */
  uid: string;
  title: string;
  start: Date;
  /** Defaults to start + defaultDurationMinutes when absent. */
  end?: Date | null;
  location?: string | null;
  description?: string | null;
  /** Maps to STATUS:CANCELLED so clients strike the event. */
  cancelled?: boolean;
}

const DEFAULT_DURATION_MIN = 120;

/** RFC 5545 3.3.5 UTC date-time: 20260718T140000Z */
export function icsDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** RFC 5545 3.3.11 TEXT escaping: backslash, semicolon, comma, newline. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/**
 * RFC 5545 3.1 line folding: content lines longer than 75 octets fold onto a
 * continuation line starting with a single space. We fold by UTF-16 length
 * (conservative for the ASCII-dominant content we emit).
 */
export function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 74) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest.length > 0) parts.push(" " + rest);
  return parts.join("\r\n");
}

function vevent(e: IcsEvent, stampIso: string): string[] {
  const end = e.end ?? new Date(e.start.getTime() + DEFAULT_DURATION_MIN * 60_000);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeText(e.uid)}`,
    `DTSTAMP:${stampIso}`,
    `DTSTART:${icsDate(e.start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${escapeText(e.title)}`,
  ];
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  lines.push(`STATUS:${e.cancelled ? "CANCELLED" : "CONFIRMED"}`);
  lines.push("END:VEVENT");
  return lines;
}

/** Build a complete VCALENDAR document (CRLF line endings, folded lines). */
export function buildCalendar(opts: { name: string; events: IcsEvent[]; now?: Date }): string {
  const stamp = icsDate(opts.now ?? new Date(0)); // deterministic default for tests
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Trade-Ops//Dispatch Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.name)}`,
    "X-PUBLISHED-TTL:PT15M", // hint clients to refresh every 15 minutes
  ];
  for (const e of opts.events) lines.push(...vevent(e, stamp));
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
