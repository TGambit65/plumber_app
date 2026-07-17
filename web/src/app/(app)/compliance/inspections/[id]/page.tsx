import Link from "next/link";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { eq } from "drizzle-orm";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Input,
  PageHeader,
  Textarea,
  type BadgeTone,
} from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { clsx } from "@/lib/clsx";
import { completeInspection, saveInspectionStep } from "@/lib/actions/compliance";
import {
  isAnswered,
  requiredBlockers,
  STEP_KIND_META,
  type InspectionResults,
  type InspectionStep,
} from "@/components/compliance/types";

export const dynamic = "force-dynamic";

const statusTone: Record<string, BadgeTone> = {
  SCHEDULED: "blue",
  IN_PROGRESS: "amber",
  PASSED: "green",
  FAILED: "red",
  CANCELLED: "slate",
};

function statusLabel(s: string) {
  return s.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function RunInspectionPage({ params }: { params: { id: string } }) {
  const session = await requireSession();
  // Techs run inspections — this flow only needs inspections.run.
  if (!can(session.role, "inspections.run")) {
    return <EmptyState title="403 — You can't run inspections" hint="Ask an admin if you believe this is a mistake." />;
  }

  const data = await withTenant(session.organizationId, async (tx) => {
    const inspection = await tx.query.inspections.findFirst({
      where: eq(t.inspections.id, params.id),
      with: {
        template: true,
        job: { with: { customer: true } },
        property: true,
        equipmentRef: { with: { property: true } },
        inspector: true,
      },
    });
    const issuedCert = inspection
      ? await tx.query.certifications.findFirst({
          where: eq(t.certifications.sourceInspectionId, params.id),
        })
      : null;
    return { inspection, issuedCert };
  });

  const { inspection, issuedCert } = data;
  if (!inspection) {
    return <EmptyState title="Inspection not found" hint="It may belong to another organization or was removed." />;
  }

  const steps = (inspection.template.steps as InspectionStep[]) ?? [];
  const results = ((inspection.results as InspectionResults) ?? {}) as InspectionResults;
  const editable = inspection.status === "SCHEDULED" || inspection.status === "IN_PROGRESS";
  const { unanswered, failed } = requiredBlockers(steps, results);
  const readyToPass = unanswered.length === 0 && failed.length === 0;

  const target = inspection.job
    ? `Job ${inspection.job.number} · ${inspection.job.jobType} (${inspection.job.customer.name})`
    : inspection.property
      ? `${inspection.property.address}, ${inspection.property.city}`
      : inspection.equipmentRef
        ? `${inspection.equipmentRef.kind}${inspection.equipmentRef.brand ? ` · ${inspection.equipmentRef.brand}` : ""} @ ${inspection.equipmentRef.property.address}`
        : "No target linked";

  const answeredCount = steps.filter((s) => isAnswered(s, results[s.key])).length;

  return (
    <div className="mx-auto max-w-2xl pb-28">
      <PageHeader
        title={`🔍 ${inspection.template.name}`}
        subtitle={
          <>
            {target}
            {inspection.job ? (
              <>
                {" · "}
                <Link href={`/jobs/${inspection.job.id}`} className="text-blue-700 hover:underline">
                  open job
                </Link>
              </>
            ) : null}
          </>
        }
        action={<Badge tone={statusTone[inspection.status] ?? "slate"}>{statusLabel(inspection.status)}</Badge>}
      />

      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>👷 Inspector: {inspection.inspector?.name ?? "—"}</span>
        <span>📅 Scheduled: {fmtDateTime(inspection.scheduledAt)}</span>
        {inspection.completedAt ? <span>🏁 Completed: {fmtDateTime(inspection.completedAt)}</span> : null}
        <span>
          {answeredCount}/{steps.length} steps answered
        </span>
      </div>

      {inspection.notes ? (
        <div className="mb-4 whitespace-pre-line rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
          {inspection.notes}
        </div>
      ) : null}

      {issuedCert ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          🎓 Certification issued: <span className="font-semibold">{issuedCert.name}</span>
          {issuedCert.expiresAt ? ` — valid until ${fmtDate(issuedCert.expiresAt)}` : ""} ·{" "}
          <Link href="/compliance" className="underline">
            view in Compliance
          </Link>
        </div>
      ) : null}

      {/* ── Checklist ── */}
      {steps.length === 0 ? (
        <EmptyState title="This template has no steps" hint="Edit the template on the Compliance page." />
      ) : (
        <ol className="space-y-3">
          {steps.map((step, i) => {
            const r = results[step.key];
            const answered = isAnswered(step, r);
            const meta = STEP_KIND_META[step.kind];
            return (
              <li key={step.key}>
                <Card
                  className={clsx(
                    r?.pass === false
                      ? "border-red-200"
                      : answered
                        ? "border-emerald-200"
                        : undefined
                  )}
                >
                  <CardBody className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                          Step {i + 1} · {meta.emoji} {meta.label}
                          {step.required ? <span className="ml-1 text-red-500">· required</span> : " · optional"}
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-slate-900">{step.label}</div>
                      </div>
                      {r?.pass === true ? (
                        <Badge tone="green">✓ {step.kind === "photo" ? "Captured" : "Pass"}</Badge>
                      ) : r?.pass === false ? (
                        <Badge tone="red">✗ Fail</Badge>
                      ) : answered ? (
                        <Badge tone="blue">Saved</Badge>
                      ) : (
                        <Badge tone="slate">Pending</Badge>
                      )}
                    </div>

                    {/* Saved values (read-only echo) */}
                    {step.kind === "measurement" && r?.value !== undefined ? (
                      <div className="text-sm text-slate-700">
                        Recorded: <span className="font-semibold tabular-nums">{String(r.value)}</span>
                        {step.unit ? ` ${step.unit}` : ""}
                      </div>
                    ) : null}
                    {step.kind === "note" && r?.value ? (
                      <div className="whitespace-pre-line rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                        {String(r.value)}
                      </div>
                    ) : null}

                    {editable ? (
                      step.kind === "check" ? (
                        <div className="grid grid-cols-2 gap-2">
                          <form action={saveInspectionStep}>
                            <input type="hidden" name="inspectionId" value={inspection.id} />
                            <input type="hidden" name="stepKey" value={step.key} />
                            <input type="hidden" name="pass" value="true" />
                            <Button type="submit" variant="success" size="lg" className="w-full">
                              ✓ Pass
                            </Button>
                          </form>
                          <form action={saveInspectionStep}>
                            <input type="hidden" name="inspectionId" value={inspection.id} />
                            <input type="hidden" name="stepKey" value={step.key} />
                            <input type="hidden" name="pass" value="false" />
                            <Button type="submit" variant="danger" size="lg" className="w-full">
                              ✗ Fail
                            </Button>
                          </form>
                        </div>
                      ) : step.kind === "measurement" ? (
                        <form action={saveInspectionStep} className="flex items-center gap-2">
                          <input type="hidden" name="inspectionId" value={inspection.id} />
                          <input type="hidden" name="stepKey" value={step.key} />
                          <Input
                            type="number"
                            step="any"
                            inputMode="decimal"
                            name="value"
                            required
                            defaultValue={r?.value !== undefined ? String(r.value) : ""}
                            placeholder="0.0"
                            className="h-12 flex-1 text-base"
                          />
                          {step.unit ? (
                            <span className="shrink-0 text-sm font-medium text-slate-500">{step.unit}</span>
                          ) : null}
                          <Button type="submit" size="lg" className="shrink-0">
                            Save
                          </Button>
                        </form>
                      ) : step.kind === "photo" ? (
                        <div>
                          <form action={saveInspectionStep}>
                            <input type="hidden" name="inspectionId" value={inspection.id} />
                            <input type="hidden" name="stepKey" value={step.key} />
                            <input type="hidden" name="pass" value="true" />
                            <Button type="submit" variant={r?.pass ? "secondary" : "success"} size="lg" className="w-full">
                              📷 {r?.pass ? "Captured — mark again" : "Mark photo captured"}
                            </Button>
                          </form>
                          <p className="mt-1 text-[11px] text-slate-400">
                            Photo upload pipeline lands later — this records that the photo was taken.
                          </p>
                        </div>
                      ) : (
                        <form action={saveInspectionStep} className="space-y-2">
                          <input type="hidden" name="inspectionId" value={inspection.id} />
                          <input type="hidden" name="stepKey" value={step.key} />
                          <Textarea
                            name="value"
                            rows={3}
                            defaultValue={r?.value !== undefined ? String(r.value) : ""}
                            placeholder="Conditions, repairs, observations…"
                            className="text-base"
                          />
                          <Button type="submit" size="lg" className="w-full">
                            Save note
                          </Button>
                        </form>
                      )
                    ) : null}
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ol>
      )}

      {/* ── Complete ── */}
      {editable && steps.length > 0 ? (
        <Card className="mt-6">
          <CardHeader title="🏁 Complete inspection" subtitle="Passing requires every required step answered with no failures" />
          <CardBody className="space-y-4">
            {readyToPass ? (
              <form action={completeInspection}>
                <input type="hidden" name="inspectionId" value={inspection.id} />
                <input type="hidden" name="outcome" value="PASSED" />
                <Button type="submit" variant="success" size="lg" className="w-full">
                  ✓ Mark PASSED
                  {inspection.template.issuesCertification
                    ? ` — issues "${inspection.template.issuesCertification}"`
                    : ""}
                </Button>
              </form>
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-semibold">Can&apos;t mark PASSED yet:</p>
                <ul className="mt-1 list-disc pl-5">
                  {unanswered.map((s) => (
                    <li key={s.key}>Required step unanswered: {s.label}</li>
                  ))}
                  {failed.map((s) => (
                    <li key={s.key} className="text-red-700">
                      Required step failed: {s.label}
                    </li>
                  ))}
                </ul>
                {failed.length > 0 ? (
                  <p className="mt-2">
                    A required check failed — mark the inspection <span className="font-semibold">FAILED</span> below
                    (or re-run the failed step if it was corrected on site).
                  </p>
                ) : null}
              </div>
            )}

            <form action={completeInspection} className="space-y-2">
              <input type="hidden" name="inspectionId" value={inspection.id} />
              <input type="hidden" name="outcome" value="FAILED" />
              <Textarea
                name="note"
                rows={2}
                required
                placeholder="Failure reason (required) — what failed and why"
                className="text-base"
              />
              <Button type="submit" variant="danger" size="lg" className="w-full">
                ✗ Mark FAILED — notifies the office
              </Button>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {!editable ? (
        <div className="mt-6 text-center text-xs text-slate-400">
          This inspection is {statusLabel(inspection.status).toLowerCase()} — the checklist is locked.
        </div>
      ) : null}
    </div>
  );
}
