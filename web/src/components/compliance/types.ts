/**
 * Compliance / inspection engine — shared step & result shapes.
 * Mirrors the jsonb contracts on inspection_templates.steps and
 * inspections.results (see src/db/schema.ts).
 */

export type StepKind = "check" | "measurement" | "photo" | "note";

export type InspectionStep = {
  key: string;
  label: string;
  kind: StepKind;
  required: boolean;
  unit?: string;
};

export type StepResult = {
  value?: string | number;
  pass?: boolean;
  note?: string;
};

export type InspectionResults = Record<string, StepResult>;

export const STEP_KINDS: StepKind[] = ["check", "measurement", "photo", "note"];

export const STEP_KIND_META: Record<StepKind, { emoji: string; label: string }> = {
  check: { emoji: "✅", label: "Check" },
  measurement: { emoji: "📐", label: "Measurement" },
  photo: { emoji: "📷", label: "Photo" },
  note: { emoji: "📝", label: "Note" },
};

/** Has this step been answered at all (any signal recorded)? */
export function isAnswered(step: InspectionStep, result: StepResult | undefined): boolean {
  if (!result) return false;
  if (result.pass !== undefined) return true;
  if (result.value !== undefined && String(result.value).trim() !== "") return true;
  if (result.note !== undefined && String(result.note).trim() !== "") return true;
  return false;
}

/**
 * Required steps that block a PASSED completion: unanswered, or explicitly
 * failed (pass === false).
 */
export function requiredBlockers(
  steps: InspectionStep[],
  results: InspectionResults
): { unanswered: InspectionStep[]; failed: InspectionStep[] } {
  const unanswered: InspectionStep[] = [];
  const failed: InspectionStep[] = [];
  for (const step of steps) {
    if (!step.required) continue;
    const r = results[step.key];
    if (!isAnswered(step, r)) unanswered.push(step);
    else if (r?.pass === false) failed.push(step);
  }
  return { unanswered, failed };
}
