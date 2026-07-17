import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { asc, eq } from "drizzle-orm";
import { fmtTime, money, lineTotal } from "@/lib/format";
import {
  quickAddPhoto,
  completeJobForm,
  saveWorkSummary,
  generateInvoice,
  addInvoiceLine,
  signInvoice,
  recordPayment,
  finishCloseout,
} from "@/lib/actions/field";
import {
  Badge,
  Card,
  CardBody,
  Field,
  Input,
  Select,
  Textarea,
  buttonClass,
  invoiceStatusTone,
  statusLabel,
} from "@/components/ui";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

function StepCard({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <Card className={done ? "border-emerald-200" : undefined}>
      <CardBody className="space-y-3 p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
              done ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-600"
            }`}
          >
            {done ? "✓" : n}
          </span>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {done ? <Badge tone="green">Done</Badge> : null}
        </div>
        {children}
      </CardBody>
    </Card>
  );
}

export default async function CloseoutPage({ params }: { params: { id: string } }) {
  const session = await requireSession();

  const data = await withTenant(session.organizationId, async (tx) => {
    const job = await tx.query.jobs.findFirst({
      where: eq(t.jobs.id, params.id),
      with: {
        customer: true,
        photos: true,
        forms: { orderBy: asc(t.jobForms.name) },
        invoices: { with: { items: true, payments: true } },
        activities: true,
      },
    });
    if (!job) return null;

    const priceBook = await tx
      .select()
      .from(t.priceBookItems)
      .where(eq(t.priceBookItems.active, true))
      .orderBy(asc(t.priceBookItems.category), asc(t.priceBookItems.name));
    return { job, priceBook };
  });
  if (!data) notFound();
  const { job, priceBook } = data;

  const beforeCount = job.photos.filter((p) => p.kind === "BEFORE").length;
  const afterCount = job.photos.filter((p) => p.kind === "AFTER").length;
  const incompleteRequired = job.forms.filter((f) => f.required && !f.completedAt);
  const summaryActivity = job.activities.find((a) => a.kind === "NOTE" && a.body.startsWith("Work summary:"));
  const invoice = job.invoices[0];
  const invoiceTotal = invoice ? lineTotal(invoice.items) : 0;
  const invoicePaid = invoice ? invoice.payments.reduce((s, p) => s + p.amountCents, 0) : 0;
  const balanceDue = Math.max(0, invoiceTotal - invoicePaid);

  const step1 = beforeCount >= 1 && afterCount >= 1;
  const step2 = incompleteRequired.length === 0;
  const step3 = Boolean(summaryActivity);
  const step4 = Boolean(invoice && ["SENT", "PARTIAL", "PAID"].includes(invoice.status));
  const step5 = Boolean(invoice && invoice.signedAt && ["PARTIAL", "PAID"].includes(invoice.status));
  const step6 = job.status === "COMPLETED";
  const doneCount = [step1, step2, step3, step4, step5, step6].filter(Boolean).length;
  const canFinish = step1 && step2 && step4;

  return (
    <div className="mx-auto max-w-2xl">
      {/* Header + progress */}
      <div className="mb-5">
        <Link href={`/jobs/${job.id}`} className="text-sm font-medium text-blue-600 hover:text-blue-800">
          ← {job.number} {job.jobType}
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">⏱️ Two-minute closeout</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {job.customer.name} · {doneCount} of 6 complete
        </p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${Math.round((doneCount / 6) * 100)}%` }}
          />
        </div>
      </div>

      {step6 ? (
        <Card className="mb-4 border-emerald-300 bg-emerald-50">
          <CardBody className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-emerald-900">
              🎉 Job completed — review request sent to {job.customer.name}.
            </div>
            <Link href="/my-day" className={buttonClass("success", "md")}>
              Back to My Day
            </Link>
          </CardBody>
        </Card>
      ) : null}

      <div className="space-y-4">
        {/* Step 1 — Photos */}
        <StepCard n={1} title="Photos" done={step1}>
          <p className="text-sm text-slate-600">
            Need at least one BEFORE and one AFTER photo.{" "}
            <span className="font-medium text-slate-900">
              Before: {beforeCount} · After: {afterCount}
            </span>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <form action={quickAddPhoto}>
              <input type="hidden" name="jobId" value={job.id} />
              <input type="hidden" name="kind" value="BEFORE" />
              <button type="submit" className={buttonClass("secondary", "lg", "w-full")}>
                📷 Add BEFORE
              </button>
            </form>
            <form action={quickAddPhoto}>
              <input type="hidden" name="jobId" value={job.id} />
              <input type="hidden" name="kind" value="AFTER" />
              <button type="submit" className={buttonClass("secondary", "lg", "w-full")}>
                📷 Add AFTER
              </button>
            </form>
          </div>
        </StepCard>

        {/* Step 2 — Required forms */}
        <StepCard n={2} title="Required forms" done={step2}>
          {step2 ? (
            <p className="text-sm text-slate-600">
              {job.forms.filter((f) => f.required).length === 0
                ? "No required forms on this job."
                : "All required forms completed."}
            </p>
          ) : (
            <div className="space-y-3">
              {incompleteRequired.map((f) => (
                <form key={f.id} action={completeJobForm} className="rounded-lg border border-slate-200 p-3">
                  <input type="hidden" name="formId" value={f.id} />
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{f.name}</span>
                    <Badge tone="red">Required</Badge>
                  </div>
                  <Textarea name="note" rows={2} placeholder="Findings / readings…" className="mb-2" />
                  <button type="submit" className={buttonClass("secondary", "lg", "w-full sm:w-auto")}>
                    ✓ Complete form
                  </button>
                </form>
              ))}
            </div>
          )}
        </StepCard>

        {/* Step 3 — Work summary */}
        <StepCard n={3} title="Work summary" done={step3}>
          {step3 && summaryActivity ? (
            <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              {summaryActivity.body.replace(/^Work summary: /, "")}
            </div>
          ) : null}
          <form action={saveWorkSummary} className="space-y-2">
            <input type="hidden" name="jobId" value={job.id} />
            <Textarea
              name="summary"
              rows={3}
              placeholder="Voice note → AI summary (demo: type or accept default)"
            />
            <div className="grid grid-cols-2 gap-3">
              <button type="submit" name="mode" value="save" className={buttonClass("secondary", "lg", "w-full")}>
                Save summary
              </button>
              <button type="submit" name="mode" value="ai" className={buttonClass("primary", "lg", "w-full")}>
                ✨ Use AI draft
              </button>
            </div>
          </form>
        </StepCard>

        {/* Step 4 — Invoice */}
        <StepCard n={4} title="Invoice" done={step4}>
          {!invoice ? (
            <form action={generateInvoice}>
              <input type="hidden" name="jobId" value={job.id} />
              <p className="mb-3 text-sm text-slate-600">
                Builds line items from materials used plus a flat-rate labor line from the price book.
              </p>
              <button type="submit" className={buttonClass("primary", "lg", "h-14 w-full text-base font-semibold")}>
                🧾 Generate invoice
              </button>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-900">{invoice.number}</span>
                <Badge tone={invoiceStatusTone[invoice.status]}>{statusLabel(invoice.status)}</Badge>
              </div>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {invoice.items.map((li) => (
                  <li key={li.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="text-slate-800">
                      {li.qty !== 1 ? `${li.qty} × ` : ""}
                      {li.description}
                    </span>
                    <span className="tabular-nums text-slate-600">{money(Math.round(li.qty * li.unitPriceCents))}</span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-3 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
                  <span>Total</span>
                  <span className="tabular-nums">{money(invoiceTotal)}</span>
                </li>
              </ul>
              <form action={addInvoiceLine} className="grid gap-2 sm:grid-cols-[1fr_5rem_auto]">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Select name="priceBookItemId">
                  {priceBook.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({money(i.unitPriceCents)})
                    </option>
                  ))}
                </Select>
                <Input name="qty" type="number" step="0.5" min="0.5" defaultValue="1" />
                <button type="submit" className={buttonClass("secondary", "md")}>
                  ＋ Add line
                </button>
              </form>
            </div>
          )}
        </StepCard>

        {/* Step 5 — Sign & pay */}
        <StepCard n={5} title="Sign & pay" done={step5}>
          {!invoice ? (
            <p className="text-sm text-slate-500">Generate the invoice first (step 4).</p>
          ) : (
            <div className="space-y-4">
              {invoice.signedAt ? (
                <p className="text-sm text-emerald-700">
                  ✍️ Signed by <span className="font-semibold">{invoice.signedName}</span> at {fmtTime(invoice.signedAt)}
                </p>
              ) : (
                <form action={signInvoice} className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <Input name="signedName" required placeholder={`Customer signs: ${job.customer.name}`} />
                  <button type="submit" className={buttonClass("secondary", "lg")}>
                    ✍️ Capture signature
                  </button>
                </form>
              )}

              {invoice.payments.length > 0 ? (
                <ul className="space-y-1 text-sm text-slate-700">
                  {invoice.payments.map((p) => (
                    <li key={p.id}>
                      💳 {money(p.amountCents)} via {p.method} · {fmtTime(p.receivedAt)}
                    </li>
                  ))}
                </ul>
              ) : null}

              {balanceDue > 0 ? (
                <form action={recordPayment} className="space-y-2 rounded-lg bg-slate-50 p-3">
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Method">
                      <Select name="method" defaultValue="CARD">
                        <option value="CARD">Card (tap-to-pay)</option>
                        <option value="ACH">ACH</option>
                        <option value="CASH">Cash</option>
                        <option value="CHECK">Check</option>
                        <option value="FINANCING">Financing</option>
                      </Select>
                    </Field>
                    <Field label="Amount ($)">
                      <Input
                        name="amount"
                        type="number"
                        step="0.01"
                        min="0.01"
                        defaultValue={(balanceDue / 100).toFixed(2)}
                      />
                    </Field>
                  </div>
                  <button type="submit" className={buttonClass("success", "lg", "h-14 w-full text-base font-semibold")}>
                    💳 Take payment — {money(balanceDue)} due
                  </button>
                </form>
              ) : (
                <p className="text-sm font-medium text-emerald-700">Paid in full. ✓</p>
              )}
            </div>
          )}
        </StepCard>

        {/* Step 6 — Finish */}
        <StepCard n={6} title="Finish job" done={step6}>
          {step6 ? (
            <Link href="/my-day" className={buttonClass("success", "lg", "h-14 w-full text-base font-semibold")}>
              ✅ Done — back to My Day
            </Link>
          ) : (
            <>
              {!canFinish ? (
                <ul className="space-y-1 text-sm text-amber-700">
                  {!step1 ? <li>• Need at least one BEFORE and one AFTER photo</li> : null}
                  {!step2 ? <li>• Complete required forms ({incompleteRequired.length} left)</li> : null}
                  {!step4 ? <li>• Generate the invoice</li> : null}
                </ul>
              ) : (
                <p className="text-sm text-slate-600">
                  Marks the job complete, stops the clock, and sends {job.customer.name} a review request.
                </p>
              )}
              <form action={finishCloseout}>
                <input type="hidden" name="jobId" value={job.id} />
                <button
                  type="submit"
                  disabled={!canFinish}
                  className={buttonClass("success", "lg", "h-14 w-full text-lg font-semibold")}
                >
                  🏁 Complete job
                </button>
              </form>
            </>
          )}
        </StepCard>
      </div>
    </div>
  );
}
