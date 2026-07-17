/* Shared server-safe presentation helpers for the INSURANCE/CLAIMS module. */
import type { BadgeTone } from "@/components/ui";

export const CLAIM_STATUSES = [
  "OPEN",
  "DOCUMENTING",
  "SUBMITTED",
  "SUPPLEMENT",
  "APPROVED",
  "PAID",
  "DENIED",
  "CLOSED",
] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const claimStatusTone: Record<string, BadgeTone> = {
  OPEN: "blue",
  DOCUMENTING: "amber",
  SUBMITTED: "violet",
  SUPPLEMENT: "amber",
  APPROVED: "green",
  PAID: "green",
  DENIED: "red",
  CLOSED: "slate",
};

export const supplementStatusTone: Record<string, BadgeTone> = {
  DRAFT: "slate",
  SUBMITTED: "blue",
  APPROVED: "green",
  DENIED: "red",
};

/** Allowed status transitions for the claim lifecycle. */
export const CLAIM_NEXT: Record<ClaimStatus, ClaimStatus[]> = {
  OPEN: ["DOCUMENTING"],
  DOCUMENTING: ["SUBMITTED"],
  SUBMITTED: ["SUPPLEMENT", "APPROVED", "DENIED"],
  SUPPLEMENT: ["APPROVED", "DENIED"],
  APPROVED: ["PAID"],
  PAID: ["CLOSED"],
  DENIED: ["CLOSED"],
  CLOSED: [],
};

/** Allowed supplement transitions. */
export const SUPPLEMENT_NEXT: Record<string, string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "DENIED"],
  APPROVED: [],
  DENIED: [],
};

/** Statuses considered "open" (still working with the carrier). */
export const OPEN_CLAIM_STATUSES: ClaimStatus[] = ["OPEN", "DOCUMENTING", "SUBMITTED", "SUPPLEMENT"];

/** Mask a policy number for logs/audit — never write the full value. */
export function maskPolicyNumber(policyNumber: string | null | undefined): string | null {
  if (!policyNumber) return null;
  const tail = policyNumber.slice(-4);
  return `••••${tail}`;
}
