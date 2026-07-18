import "server-only";
import { eq, inArray } from "drizzle-orm";
import { t, withTenant } from "@/db";
import { getConnector } from "@/lib/connectors/providers";
import { decryptConfig } from "@/lib/connectors/secret-config";
import type { BusyWindow, ConnectorConfig } from "@/lib/connectors/types";

/**
 * Calendar event push + busy-window read (dispatch D2).
 *
 * The org connects ONE calendar (Google or Outlook — first CONNECTED wins).
 * Every scheduled job is mirrored as an event; the provider's event id is
 * stored on the job so reschedules PATCH the same event instead of
 * duplicating. Calendar failures NEVER block dispatch — they log loudly and
 * the schedule stays authoritative in the app.
 */

const CALENDAR_PROVIDERS = ["GOOGLE_CALENDAR", "OUTLOOK_CALENDAR"];
const DEFAULT_DURATION_MIN = 120;

async function connectedCalendar(organizationId: string) {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(t.integrationConnections)
      .where(inArray(t.integrationConnections.provider, CALENDAR_PROVIDERS))
  );
  const row = rows.find((r) => r.status === "CONNECTED");
  if (!row) return null;
  const connector = getConnector(row.provider);
  if (!connector?.calendar) return null;
  const config = decryptConfig(connector.descriptor, (row.config ?? {}) as ConnectorConfig);
  return { ops: connector.calendar(config), provider: row.provider };
}

/** Mirror one job to the org calendar (create or PATCH). Loud, never throws. */
export async function pushJobToCalendar(organizationId: string, jobId: string): Promise<void> {
  try {
    const cal = await connectedCalendar(organizationId);
    if (!cal) return; // no calendar connected — nothing to do (standalone-first)

    const job = await withTenant(organizationId, (tx) =>
      tx.query.jobs.findFirst({
        where: eq(t.jobs.id, jobId),
        with: { customer: true, property: true, assignedTo: true },
      })
    );
    if (!job || !job.scheduledAt) return;

    const end = job.scheduledEnd ?? new Date(job.scheduledAt.getTime() + DEFAULT_DURATION_MIN * 60_000);
    const result = await cal.ops.upsertEvent({
      externalId: job.calendarEventId ?? undefined,
      title: `${job.number} · ${job.jobType} — ${job.customer.name}${job.assignedTo ? ` (${job.assignedTo.name})` : ""}`,
      start: job.scheduledAt,
      end,
      location: `${job.property.address}, ${job.property.city}, ${job.property.state} ${job.property.zip}`,
      description: `Status: ${job.status}${job.description ? `\n${job.description}` : ""}`,
    });

    if (result.ok && result.externalId && result.externalId !== job.calendarEventId) {
      await withTenant(organizationId, (tx) =>
        tx.update(t.jobs).set({ calendarEventId: result.externalId }).where(eq(t.jobs.id, jobId))
      );
    }
    if (!result.ok) {
      console.error(`[calendar push] job ${job.number}: ${result.message}`);
    }
  } catch (e) {
    // Never let a calendar hiccup break dispatch.
    console.error(`[calendar push] ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The org calendar's busy windows for a day (for soft-conflict display). */
export async function busyWindowsForDay(
  organizationId: string,
  day: Date
): Promise<{ provider: string; windows: BusyWindow[] } | null> {
  try {
    const cal = await connectedCalendar(organizationId);
    if (!cal) return null;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const pull = await cal.ops.listBusy(start, end);
    if (!pull.ok) {
      console.error(`[calendar busy] ${pull.message}`);
      return { provider: cal.provider, windows: [] };
    }
    return { provider: cal.provider, windows: pull.records };
  } catch (e) {
    console.error(`[calendar busy] ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** True when a job's scheduled window overlaps any busy window. */
export function overlapsBusy(
  scheduledAt: Date | null,
  scheduledEnd: Date | null,
  windows: BusyWindow[]
): boolean {
  if (!scheduledAt) return false;
  const jobStart = scheduledAt.getTime();
  const jobEnd = (scheduledEnd ?? new Date(jobStart + DEFAULT_DURATION_MIN * 60_000)).getTime();
  return windows.some((w) => w.start.getTime() < jobEnd && w.end.getTime() > jobStart);
}
