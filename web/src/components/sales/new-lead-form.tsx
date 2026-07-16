"use client";

import { useState } from "react";
import { createLead } from "@/lib/actions/sales";
import { Button, Card, CardBody, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";

const SOURCES = [
  ["PHONE", "📞 Phone"],
  ["WEB_FORM", "🌐 Web form"],
  ["GOOGLE_LSA", "G Google LSA"],
  ["ANGI", "🏠 Angi"],
  ["REFERRAL", "🤝 Referral"],
  ["TECH_FLAGGED", "🔧 Tech-flagged"],
  ["SMS", "💬 SMS"],
  ["OTHER", "📌 Other"],
] as const;

export function NewLeadPanel({ reps }: { reps: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        + New lead
      </Button>
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16">
      <Card className="w-full max-w-2xl">
        <CardHeader
          title="New lead"
          subtitle="A 30-minute speed-to-lead SLA timer starts immediately."
          action={
            <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>
              ✕
            </Button>
          }
        />
        <CardBody>
          <form action={createLead} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Title *">
                <Input name="title" required placeholder="e.g. Water heater leaking — needs replacement" />
              </Field>
            </div>
            <Field label="Contact name *">
              <Input name="contactName" required placeholder="Jane Smith" />
            </Field>
            <Field label="Phone">
              <Input name="phone" placeholder="555-0100" />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" placeholder="jane@example.com" />
            </Field>
            <Field label="Source">
              <Select name="source" defaultValue="PHONE">
                {SOURCES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Est. value ($)">
              <Input name="estValue" inputMode="decimal" placeholder="2400" />
            </Field>
            <Field label="Assign to">
              <Select name="assignedToId" defaultValue="">
                <option value="">— Unassigned —</option>
                {reps.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Notes">
                <Textarea name="description" rows={2} placeholder="What the customer told us…" />
              </Field>
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit">Create lead</Button>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
