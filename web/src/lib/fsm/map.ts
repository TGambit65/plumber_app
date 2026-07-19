/**
 * FSM import mapping (dispatch D5) — PURE module, unit-testable.
 *
 * Translates external field-service records (Jobber, ServiceTitan, …) into
 * local shapes: provider status strings → the job status enum, single-line
 * addresses → structured parts, and provider-prefixed job numbers that stay
 * stable and collision-free next to the local J-… sequence.
 */

export type LocalJobStatus =
  | "UNSCHEDULED"
  | "SCHEDULED"
  | "DISPATCHED"
  | "EN_ROUTE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

/** Best-effort provider status → local enum. Unknown → schedule-derived. */
export function mapExternalStatus(raw: string | undefined, hasSchedule: boolean): LocalJobStatus {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (/cancel/.test(s)) return "CANCELLED";
  if (/complete|archiv|done|closed/.test(s)) return "COMPLETED";
  if (/progress|active|working|onsite/.test(s)) return "IN_PROGRESS";
  if (/enroute|driving/.test(s)) return "EN_ROUTE";
  if (/dispatch/.test(s)) return "DISPATCHED";
  if (/schedul|booked|upcoming|hold/.test(s)) return "SCHEDULED";
  return hasSchedule ? "SCHEDULED" : "UNSCHEDULED";
}

export interface AddressParts {
  address: string;
  city: string;
  state: string;
  zip: string;
}

/**
 * Split a single-line address into parts. Handles "street, city, ST 12345",
 * "street, city" and bare streets; missing parts become "—" so NOT NULL
 * columns stay honest about what the provider actually gave us.
 */
export function splitAddress(input: {
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
}): AddressParts {
  // Structured fields win outright.
  if (input.city || input.state || input.zip) {
    return {
      address: input.address?.trim() || "—",
      city: input.city?.trim() || "—",
      state: input.state?.trim() || "—",
      zip: input.zip?.trim() || "—",
    };
  }
  const raw = (input.address ?? "").trim();
  if (!raw) return { address: "—", city: "—", state: "—", zip: "—" };
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) return { address: parts[0], city: "—", state: "—", zip: "—" };
  const last = parts[parts.length - 1];
  const m = last.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m && parts.length >= 3) {
    return { address: parts.slice(0, -2).join(", "), city: parts[parts.length - 2], state: m[1].toUpperCase(), zip: m[2] };
  }
  return { address: parts.slice(0, -1).join(", "), city: last, state: "—", zip: "—" };
}

const PROVIDER_PREFIX: Record<string, string> = {
  JOBBER: "JB",
  SERVICETITAN: "ST",
  HOUSECALL_PRO: "HC",
};

/** Stable provider-prefixed local job number, e.g. "JB-5501". */
export function externalJobNumber(provider: string, externalId: string): string {
  const prefix = PROVIDER_PREFIX[provider] ?? provider.slice(0, 2).toUpperCase();
  return `${prefix}-${externalId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`;
}

/** Provenance key stored in external_ref columns, e.g. "JOBBER:5501". */
export function externalRef(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}
