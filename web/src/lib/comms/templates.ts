/**
 * Transactional SMS templates + send policy (dispatch phase D1).
 *
 * PURE module (unit-testable). Policy, per the dispatch plan:
 *   - TEMPLATED TRANSACTIONAL kinds (on-my-way, booking confirmation,
 *     reminder) AUTO-SEND — they carry no free text, so they are safe to send
 *     without a human approval step. Every send is still RECORDED in
 *     outbound_messages with its delivery result (loud, auditable).
 *   - FREE-TEXT customer messages keep flowing through the approval-gated
 *     egress queue (constraint 8) — nothing here changes that.
 */

export type TransactionalKind = "ON_MY_WAY" | "BOOKING_CONFIRMATION" | "REMINDER";

export interface TemplateParams {
  companyName: string;
  customerFirstName: string;
  techName?: string;
  jobType?: string;
  /** Preformatted local date/time strings — formatting happens at the caller. */
  when?: string;
  address?: string;
  etaMinutes?: number;
}

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Render the message body for a transactional kind. Deterministic, no free text. */
export function renderTemplate(kind: TransactionalKind, p: TemplateParams): string {
  const hi = `Hi ${first(p.customerFirstName)}, this is ${p.companyName}.`;
  switch (kind) {
    case "ON_MY_WAY": {
      const eta = p.etaMinutes ? ` and should arrive in about ${p.etaMinutes} minutes` : "";
      return `${hi} ${p.techName ?? "Your technician"} is on the way${eta} for your ${p.jobType ?? "service"} appointment. Reply STOP to opt out.`;
    }
    case "BOOKING_CONFIRMATION":
      return `${hi} You're booked: ${p.jobType ?? "service"} on ${p.when ?? "the scheduled time"}${p.address ? ` at ${p.address}` : ""}. Reply STOP to opt out.`;
    case "REMINDER":
      return `${hi} Reminder: your ${p.jobType ?? "service"} appointment is ${p.when ?? "tomorrow"}${p.address ? ` at ${p.address}` : ""}. Reply STOP to opt out.`;
  }
}

export const TRANSACTIONAL_KINDS: TransactionalKind[] = ["ON_MY_WAY", "BOOKING_CONFIRMATION", "REMINDER"];

/** True when a kind may auto-send without a human approval (templated only). */
export function isAutoSendKind(kind: string): kind is TransactionalKind {
  return (TRANSACTIONAL_KINDS as string[]).includes(kind);
}

/** Loose E.164-ish normalization for US-style numbers; returns null if hopeless. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits.length >= 11 ? digits : null;
  const bare = digits.replace(/\D/g, "");
  if (bare.length === 10) return `+1${bare}`;
  if (bare.length === 11 && bare.startsWith("1")) return `+${bare}`;
  // Demo data uses short fake numbers (555-0100) — treat as unroutable.
  return null;
}
