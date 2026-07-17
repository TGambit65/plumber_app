/* Seed realistic demo data. Run: npm run db:seed */
import { db, t } from "./index";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";

const $ = (dollars: number) => Math.round(dollars * 100);
const daysFromNow = (d: number, h = 9, m = 0) => {
  const dt = new Date();
  dt.setDate(dt.getDate() + d);
  dt.setHours(h, m, 0, 0);
  return dt;
};
const period = () => new Date().toISOString().slice(0, 7);

async function main() {
  console.log("Clearing existing data…");
  // Order matters (FKs). Truncate everything in one statement.
  await db.execute(sql`
    TRUNCATE TABLE
      audit_logs, notifications, activities, integration_connections,
      kb_articles, commission_entries, commission_rules,
      purchase_order_lines, purchase_orders, part_requests, material_usages,
      stock_levels, inventory_locations, price_book_items,
      payments, invoice_line_items, invoices,
      subcontractors, cost_entries, permits, change_orders, milestones,
      time_entries, job_forms, job_photos,
      estimate_line_items, estimate_options, follow_ups, estimates,
      jobs, projects, leads, memberships, equipment, properties, customers, users
    CASCADE
  `);

  console.log("Users…");
  const hash = await bcrypt.hash("demo1234", 10);
  const [admin, office, sales, sales2, tech, tech2] = await db
    .insert(t.users)
    .values([
      { email: "owner@apexplumbing.demo", name: "Dana Whitfield", role: "ADMIN", passwordHash: hash, phone: "555-0100" },
      { email: "office@apexplumbing.demo", name: "Rosa Jimenez", role: "OFFICE", passwordHash: hash, phone: "555-0101" },
      { email: "sales@apexplumbing.demo", name: "Marcus Bell", role: "SALES_PM", passwordHash: hash, phone: "555-0102" },
      { email: "pm@apexplumbing.demo", name: "Priya Nair", role: "SALES_PM", passwordHash: hash, phone: "555-0103" },
      { email: "tech@apexplumbing.demo", name: "Jake Sullivan", role: "TECH", passwordHash: hash, phone: "555-0104" },
      { email: "tech2@apexplumbing.demo", name: "Luis Ortega", role: "TECH", passwordHash: hash, phone: "555-0105" },
    ])
    .returning();

  console.log("Customers & properties…");
  const custRows = await db
    .insert(t.customers)
    .values([
      { name: "Helen Marsh", type: "RESIDENTIAL", email: "helen.marsh@example.com", phone: "555-2001" },
      { name: "Tom & Erica Boyd", type: "RESIDENTIAL", email: "boyds@example.com", phone: "555-2002" },
      { name: "Gerald Nakamura", type: "RESIDENTIAL", email: "gnak@example.com", phone: "555-2003" },
      { name: "Sandra Ellis", type: "RESIDENTIAL", email: "sellis@example.com", phone: "555-2004" },
      { name: "Ravi Patel", type: "RESIDENTIAL", email: "rpatel@example.com", phone: "555-2005" },
      { name: "Maria Fuentes", type: "RESIDENTIAL", email: "mfuentes@example.com", phone: "555-2006" },
      { name: "Bill Hendricks", type: "RESIDENTIAL", phone: "555-2007" },
      { name: "Lakeview Property Group", type: "COMMERCIAL", company: "Lakeview Property Group LLC", email: "maint@lakeviewpg.example.com", phone: "555-3001", notes: "Property manager: Carla. NET-30 terms." },
      { name: "Hartman & Sons GC", type: "COMMERCIAL", company: "Hartman & Sons General Contracting", email: "bids@hartmangc.example.com", phone: "555-3002", notes: "GC — bid work. Contact: Doug Hartman." },
      { name: "Bluebird Cafe", type: "COMMERCIAL", company: "Bluebird Cafe Inc.", email: "owner@bluebirdcafe.example.com", phone: "555-3003" },
    ])
    .returning();
  const [helen, boyd, gerald, sandra, ravi, maria, bill, lakeview, hartman, bluebird] = custRows;

  const propRows = await db
    .insert(t.properties)
    .values([
      { customerId: helen.id, address: "412 Sycamore Ln", city: "Riverton", state: "OH", zip: "45201", petNotes: "Dog: Biscuit (friendly)", shutoffLocation: "Basement, NE corner behind shelving", accessNotes: "Use side door; front porch step is loose" },
      { customerId: boyd.id, address: "88 Cliffside Dr", city: "Riverton", state: "OH", zip: "45201", gateCode: "4482", shutoffLocation: "Garage wall by water heater", parkingNotes: "Park on street — steep driveway" },
      { customerId: gerald.id, address: "2203 Fernwood Ave", city: "Maple Falls", state: "OH", zip: "45222", shutoffLocation: "Crawlspace access in hall closet" },
      { customerId: sandra.id, address: "15 Birchwood Ct", city: "Riverton", state: "OH", zip: "45201", petNotes: "Two cats — keep doors closed" },
      { customerId: ravi.id, address: "731 Alder St", city: "Maple Falls", state: "OH", zip: "45222", gateCode: "1177" },
      { customerId: maria.id, address: "9 Quarry Rd", city: "Riverton", state: "OH", zip: "45203" },
      { customerId: bill.id, address: "504 Dover Pl", city: "Riverton", state: "OH", zip: "45201" },
      { customerId: lakeview.id, label: "Lakeview Apartments — Bldg A", address: "1200 Lakeview Pkwy", city: "Riverton", state: "OH", zip: "45204", accessNotes: "Check in at leasing office for unit keys", parkingNotes: "Service vehicles: lot C" },
      { customerId: lakeview.id, label: "Lakeview Apartments — Bldg B", address: "1220 Lakeview Pkwy", city: "Riverton", state: "OH", zip: "45204" },
      { customerId: hartman.id, label: "Jobsite: Willow Creek Phase 2", address: "Willow Creek Dr & Rte 9", city: "Maple Falls", state: "OH", zip: "45222", accessNotes: "Hard hats required. Site super: Denny 555-3010" },
      { customerId: bluebird.id, address: "77 Main St", city: "Riverton", state: "OH", zip: "45201", accessNotes: "Service entrance in alley; kitchen closes 3-5pm" },
    ])
    .returning();
  const [pHelen, pBoyd, pGerald, pSandra, pRavi, pMaria, pBill, pLakeA, , pWillow, pBluebird] = propRows;

  console.log("Equipment…");
  await db.insert(t.equipment).values([
    { propertyId: pHelen.id, kind: "Water Heater", brand: "Rheem", model: "XG50T06EC36U0", serial: "RH-2019-88231", installedAt: daysFromNow(-2100), notes: "50 gal gas. Anode rod replaced 14 months ago." },
    { propertyId: pHelen.id, kind: "Sump Pump", brand: "Zoeller", model: "M53", serial: "ZM53-44121" },
    { propertyId: pBoyd.id, kind: "Water Heater", brand: "AO Smith", model: "GCR-40", serial: "AOS-2015-11220", installedAt: daysFromNow(-3900), notes: "11 years old — replacement candidate" },
    { propertyId: pGerald.id, kind: "Tankless Water Heater", brand: "Navien", model: "NPE-240A2", serial: "NV-2023-55871", installedAt: daysFromNow(-700) },
    { propertyId: pBluebird.id, kind: "Grease Trap", brand: "Schier", model: "GB-250", notes: "Quarterly service contract" },
    { propertyId: pLakeA.id, kind: "Boiler", brand: "Weil-McLain", model: "CGa-6", serial: "WM-2016-90455", notes: "Serves units A1–A24" },
  ]);

  await db.insert(t.memberships).values([
    { customerId: helen.id, plan: "Home Care Club", renewsAt: daysFromNow(210) },
    { customerId: bluebird.id, plan: "Commercial Service Agreement", renewsAt: daysFromNow(90) },
  ]);

  console.log("Price book…");
  const pb = await db
    .insert(t.priceBookItems)
    .values([
      { code: "WH-50G", name: "50-gal Gas Water Heater — Install", description: "Rheem Performance 50-gal gas, haul-away included", category: "Water Heaters", unitCostCents: $(620), unitPriceCents: $(1850), laborHours: 3 },
      { code: "WH-50G-PRO", name: "50-gal Gas Water Heater — Professional", description: "Rheem Performance Platinum, exp. tank, pan, haul-away", category: "Water Heaters", unitCostCents: $(880), unitPriceCents: $(2450), laborHours: 3.5 },
      { code: "WH-TANKLESS", name: "Tankless Water Heater — Install", description: "Navien NPE-240A2 condensing tankless, venting incl.", category: "Water Heaters", unitCostCents: $(1450), unitPriceCents: $(4200), laborHours: 6 },
      { code: "EXP-TANK", name: "Thermal Expansion Tank", category: "Water Heaters", unitCostCents: $(45), unitPriceCents: $(225), laborHours: 0.5 },
      { code: "PRV-34", name: 'Pressure Reducing Valve 3/4"', category: "Valves", unitCostCents: $(78), unitPriceCents: $(385), laborHours: 1 },
      { code: "MSV-34", name: 'Main Shutoff Valve Replacement 3/4"', category: "Valves", unitCostCents: $(32), unitPriceCents: $(295), laborHours: 1 },
      { code: "SP-M53", name: "Sump Pump — Zoeller M53 Install", category: "Pumps", unitCostCents: $(180), unitPriceCents: $(650), laborHours: 1.5 },
      { code: "SP-BATT", name: "Battery Backup Sump System", category: "Pumps", unitCostCents: $(420), unitPriceCents: $(1250), laborHours: 2 },
      { code: "DR-SNAKE", name: "Drain Clearing — Mainline Auger", category: "Drains", unitCostCents: $(15), unitPriceCents: $(325), laborHours: 1.5 },
      { code: "DR-CAM", name: "Sewer Camera Inspection", category: "Drains", unitCostCents: $(10), unitPriceCents: $(295), laborHours: 1 },
      { code: "DR-JET", name: "Hydro-Jetting Service", category: "Drains", unitCostCents: $(60), unitPriceCents: $(795), laborHours: 2.5 },
      { code: "TOI-STD", name: "Toilet Install — Standard", description: "Kohler Highline, wax ring, supply line", category: "Fixtures", unitCostCents: $(210), unitPriceCents: $(585), laborHours: 1.5 },
      { code: "TOI-COMF", name: "Toilet Install — Comfort Height Elongated", category: "Fixtures", unitCostCents: $(310), unitPriceCents: $(745), laborHours: 1.5 },
      { code: "FAU-KIT", name: "Kitchen Faucet Install", category: "Fixtures", unitCostCents: $(140), unitPriceCents: $(425), laborHours: 1 },
      { code: "GD-12HP", name: "Garbage Disposal 1/2 HP", category: "Fixtures", unitCostCents: $(95), unitPriceCents: $(385), laborHours: 1 },
      { code: "REPIPE-PEX", name: "Whole-Home Repipe — PEX (per fixture)", category: "Repipe", unitCostCents: $(260), unitPriceCents: $(950), laborHours: 4 },
      { code: "WTR-SOFT", name: "Water Softener Install", category: "Water Quality", unitCostCents: $(520), unitPriceCents: $(1650), laborHours: 3 },
      { code: "LEAK-REP", name: "Leak Repair — Copper (per joint)", category: "Repairs", unitCostCents: $(18), unitPriceCents: $(245), laborHours: 1 },
      { code: "GAS-LINE", name: "Gas Line Extension (per 10 ft)", category: "Gas", unitCostCents: $(85), unitPriceCents: $(420), laborHours: 1.5 },
      { code: "DIAG", name: "Diagnostic / Service Call", category: "Service", unitCostCents: $(0), unitPriceCents: $(89), laborHours: 0.5 },
      { code: "P-TRAP", name: 'P-Trap Assembly 1-1/2"', category: "Parts", unitCostCents: $(6), unitPriceCents: $(38) },
      { code: "WAX-RING", name: "Wax Ring w/ Flange", category: "Parts", unitCostCents: $(4), unitPriceCents: $(22) },
      { code: "SUP-LINE", name: "Braided Supply Line", category: "Parts", unitCostCents: $(5), unitPriceCents: $(28) },
      { code: "CU-34-10", name: 'Copper Pipe 3/4" (10 ft)', category: "Parts", unitCostCents: $(22), unitPriceCents: $(68) },
      { code: "PEX-34-100", name: 'PEX-A 3/4" (100 ft roll)', category: "Parts", unitCostCents: $(58), unitPriceCents: $(165) },
      { code: "BALL-VALVE", name: 'Ball Valve 3/4" Full Port', category: "Parts", unitCostCents: $(9), unitPriceCents: $(42) },
      { code: "ANODE-ROD", name: "Magnesium Anode Rod", category: "Parts", unitCostCents: $(14), unitPriceCents: $(65) },
      { code: "TP-VALVE", name: "T&P Relief Valve", category: "Parts", unitCostCents: $(12), unitPriceCents: $(58) },
    ])
    .returning();
  const pbByCode = Object.fromEntries(pb.map((i) => [i.code, i]));

  console.log("Inventory…");
  const [warehouse, truck1, truck2] = await db
    .insert(t.inventoryLocations)
    .values([
      { name: "Main Warehouse", kind: "WAREHOUSE" },
      { name: "Truck 12 — Jake", kind: "TRUCK", userId: tech.id },
      { name: "Truck 7 — Luis", kind: "TRUCK", userId: tech2.id },
    ])
    .returning();

  const stock = (locationId: string, code: string, qty: number, min: number, max: number, bin?: string) => ({
    locationId, priceBookItemId: pbByCode[code].id, qtyOnHand: qty, minQty: min, maxQty: max, bin,
  });
  await db.insert(t.stockLevels).values([
    stock(warehouse.id, "WH-50G", 4, 2, 6, "A1"),
    stock(warehouse.id, "WH-50G-PRO", 2, 1, 4, "A2"),
    stock(warehouse.id, "WH-TANKLESS", 1, 1, 3, "A3"),
    stock(warehouse.id, "SP-M53", 6, 3, 10, "B1"),
    stock(warehouse.id, "PEX-34-100", 14, 6, 20, "C4"),
    stock(warehouse.id, "CU-34-10", 30, 15, 50, "C1"),
    stock(warehouse.id, "TOI-STD", 5, 2, 8, "D2"),
    stock(warehouse.id, "EXP-TANK", 8, 4, 12, "B3"),
    stock(truck1.id, "P-TRAP", 6, 4, 10, "Bin 3"),
    stock(truck1.id, "WAX-RING", 8, 5, 12, "Bin 3"),
    stock(truck1.id, "SUP-LINE", 10, 6, 15, "Bin 4"),
    stock(truck1.id, "BALL-VALVE", 4, 3, 8, "Bin 5"),
    stock(truck1.id, "TP-VALVE", 2, 2, 5, "Bin 5"),
    stock(truck1.id, "ANODE-ROD", 1, 2, 4, "Bin 6"), // below min — shows replenishment
    stock(truck1.id, "CU-34-10", 3, 2, 6, "Rack"),
    stock(truck2.id, "P-TRAP", 5, 4, 10, "Bin 1"),
    stock(truck2.id, "WAX-RING", 3, 5, 12, "Bin 1"), // below min
    stock(truck2.id, "SUP-LINE", 8, 6, 15, "Bin 2"),
    stock(truck2.id, "EXP-TANK", 1, 1, 3, "Floor"),
  ]);

  console.log("Leads…");
  const leadRows = await db
    .insert(t.leads)
    .values([
      { source: "GOOGLE_LSA", stage: "NEW", title: "Water heater leaking — needs replacement", contactName: "Denise Cooper", phone: "555-4001", email: "dcooper@example.com", estValueCents: $(2400), respondBy: new Date(Date.now() + 30 * 60 * 1000), assignedToId: sales.id, description: "Found us on Google. 12-yr-old unit leaking from base. Wants quote ASAP." },
      { source: "WEB_FORM", stage: "NEW", title: "Bathroom remodel rough-in quote", contactName: "Alan Wexler", phone: "555-4002", email: "awex@example.com", estValueCents: $(6800), respondBy: new Date(Date.now() + 90 * 60 * 1000), assignedToId: sales.id },
      { source: "PHONE", stage: "CONTACTED", title: "Low water pressure whole house", contactName: "Grace Lin", phone: "555-4003", estValueCents: $(800), assignedToId: sales.id, firstTouchAt: daysFromNow(-1, 14), lastContactAt: daysFromNow(-1, 14) },
      { source: "ANGI", stage: "ESTIMATE_SCHEDULED", title: "Sewer line backup — camera + repair", contactName: "Frank Delgado", phone: "555-4004", estValueCents: $(4500), assignedToId: sales.id, firstTouchAt: daysFromNow(-2, 10), lastContactAt: daysFromNow(-1, 9) },
      { source: "TECH_FLAGGED", stage: "ESTIMATE_SENT", title: "Water softener opportunity — Boyd residence", contactName: "Tom Boyd", phone: "555-2002", customerId: boyd.id, propertyId: pBoyd.id, estValueCents: $(1650), techFlagged: true, spiffCents: $(50), createdById: tech.id, assignedToId: sales.id, firstTouchAt: daysFromNow(-4, 11), lastContactAt: daysFromNow(-2, 15), description: "Jake flagged hard-water scaling during water heater service." },
      { source: "REFERRAL", stage: "FOLLOW_UP", title: "Whole-home repipe — galvanized to PEX", contactName: "Sandra Ellis", phone: "555-2004", customerId: sandra.id, propertyId: pSandra.id, estValueCents: $(12800), assignedToId: sales2.id, firstTouchAt: daysFromNow(-9, 13), lastContactAt: daysFromNow(-3, 10) },
      { source: "PHONE", stage: "WON", title: "Grease trap service contract renewal", contactName: "Bluebird Cafe", customerId: bluebird.id, propertyId: pBluebird.id, estValueCents: $(2200), assignedToId: sales.id, firstTouchAt: daysFromNow(-14), lastContactAt: daysFromNow(-7) },
      { source: "WEB_FORM", stage: "LOST", title: "Faucet replacement", contactName: "Kyle Brandt", phone: "555-4005", estValueCents: $(425), lostReason: "Went with cheaper handyman", assignedToId: sales2.id, firstTouchAt: daysFromNow(-11), lastContactAt: daysFromNow(-8) },
      { source: "GOOGLE_LSA", stage: "CONTACTED", title: "Commercial bid: Willow Creek Phase 2 plumbing", contactName: "Doug Hartman", phone: "555-3002", customerId: hartman.id, propertyId: pWillow.id, estValueCents: $(148000), assignedToId: sales2.id, firstTouchAt: daysFromNow(-6), lastContactAt: daysFromNow(-2), description: "24-unit townhome development. Bid due in 10 days." },
    ])
    .returning();
  const [leadDenise, , , , leadSoftener, leadRepipe] = leadRows;

  console.log("Jobs…");
  const jobRows = await db
    .insert(t.jobs)
    .values([
      // Today's route for Jake (tech)
      { number: "J-1041", status: "DISPATCHED", priority: "HIGH", jobType: "Water Heater Replacement", customerId: boyd.id, propertyId: pBoyd.id, assignedToId: tech.id, scheduledAt: daysFromNow(0, 8, 30), scheduledEnd: daysFromNow(0, 12), description: "Replace failing 11-yr-old AO Smith GCR-40. Customer approved Better option ($2,450)." },
      { number: "J-1042", status: "SCHEDULED", priority: "NORMAL", jobType: "Drain Clearing", customerId: gerald.id, propertyId: pGerald.id, assignedToId: tech.id, scheduledAt: daysFromNow(0, 13), scheduledEnd: daysFromNow(0, 15), description: "Kitchen sink backing up. Recurring — 3rd visit in 2 yrs. Recommend camera." },
      { number: "J-1043", status: "SCHEDULED", priority: "EMERGENCY", jobType: "Leak Repair", customerId: maria.id, propertyId: pMaria.id, assignedToId: tech.id, scheduledAt: daysFromNow(0, 15, 30), scheduledEnd: daysFromNow(0, 17), description: "Active leak under kitchen sink, customer has bucket under it." },
      // Luis today
      { number: "J-1044", status: "IN_PROGRESS", priority: "NORMAL", jobType: "Toilet Install", customerId: ravi.id, propertyId: pRavi.id, assignedToId: tech2.id, scheduledAt: daysFromNow(0, 9), scheduledEnd: daysFromNow(0, 11) },
      { number: "J-1045", status: "SCHEDULED", priority: "NORMAL", jobType: "Grease Trap Service", customerId: bluebird.id, propertyId: pBluebird.id, assignedToId: tech2.id, scheduledAt: daysFromNow(0, 13, 30), scheduledEnd: daysFromNow(0, 15) },
      // Tomorrow / later
      { number: "J-1046", status: "SCHEDULED", priority: "NORMAL", jobType: "Sump Pump Install", customerId: helen.id, propertyId: pHelen.id, assignedToId: tech.id, scheduledAt: daysFromNow(1, 9), scheduledEnd: daysFromNow(1, 11), description: "Replace Zoeller M53 + add battery backup (approved estimate)." },
      { number: "J-1047", status: "UNSCHEDULED", priority: "NORMAL", jobType: "Camera Inspection", customerId: gerald.id, propertyId: pGerald.id, description: "Follow-up to recurring kitchen line clogs." },
      // Completed yesterday
      { number: "J-1039", status: "COMPLETED", priority: "NORMAL", jobType: "Water Heater Service", customerId: helen.id, propertyId: pHelen.id, assignedToId: tech.id, scheduledAt: daysFromNow(-1, 10), completedAt: daysFromNow(-1, 12), description: "Annual flush + anode inspection (membership)." },
      { number: "J-1040", status: "COMPLETED", priority: "NORMAL", jobType: "Faucet Install", customerId: bill.id, propertyId: pBill.id, assignedToId: tech2.id, scheduledAt: daysFromNow(-1, 14), completedAt: daysFromNow(-1, 15, 30) },
    ])
    .returning();
  const [jWH, jDrain, jLeak, jToilet, , , , jFlush, jFaucet] = jobRows;

  console.log("Job photos, forms, time…");
  await db.insert(t.jobPhotos).values([
    { jobId: jFlush.id, kind: "BEFORE", url: "/demo-photos/wh-before.svg", caption: "Pre-service: sediment discharge", takenById: tech.id, takenAt: daysFromNow(-1, 10, 20) },
    { jobId: jFlush.id, kind: "AFTER", url: "/demo-photos/wh-after.svg", caption: "Post-flush, clear discharge", takenById: tech.id, takenAt: daysFromNow(-1, 11, 40) },
    { jobId: jToilet.id, kind: "BEFORE", url: "/demo-photos/toilet-before.svg", caption: "Existing unit — cracked tank", takenById: tech2.id },
  ]);
  await db.insert(t.jobForms).values([
    { jobId: jWH.id, name: "Water Heater Install Checklist", required: true },
    { jobId: jWH.id, name: "Gas Safety Verification", required: true },
    { jobId: jDrain.id, name: "Drain Service Report", required: true },
    { jobId: jLeak.id, name: "Leak Assessment", required: false },
    { jobId: jFlush.id, name: "Membership Service Checklist", required: true, completedAt: daysFromNow(-1, 11, 45), data: { flushed: true, anodeCondition: "60% — replace next visit", tpValve: "OK" } },
  ]);
  await db.insert(t.timeEntries).values([
    { userId: tech.id, jobId: jFlush.id, kind: "TRAVEL", startedAt: daysFromNow(-1, 9, 40), endedAt: daysFromNow(-1, 10, 5) },
    { userId: tech.id, jobId: jFlush.id, kind: "WORK", startedAt: daysFromNow(-1, 10, 5), endedAt: daysFromNow(-1, 12) },
    { userId: tech2.id, jobId: jToilet.id, kind: "WORK", startedAt: daysFromNow(0, 9, 10) },
  ]);
  await db.insert(t.materialUsages).values([
    { jobId: jFaucet.id, priceBookItemId: pbByCode["SUP-LINE"].id, qty: 2, usedAt: daysFromNow(-1, 15) },
    { jobId: jFlush.id, priceBookItemId: pbByCode["TP-VALVE"].id, qty: 1, usedAt: daysFromNow(-1, 11) },
  ]);

  console.log("Estimates…");
  const [estWH, estSoftener, estRepipe] = await db
    .insert(t.estimates)
    .values([
      { number: "E-2088", status: "APPROVED", customerId: boyd.id, propertyId: pBoyd.id, jobId: jWH.id, createdById: sales.id, sentAt: daysFromNow(-3, 16), signedName: "Tom Boyd", signedAt: daysFromNow(-2, 9), viewCount: 4, lastViewedAt: daysFromNow(-2, 8), notes: "Customer chose Better option." },
      { number: "E-2091", status: "VIEWED", customerId: boyd.id, propertyId: pBoyd.id, leadId: leadSoftener.id, createdById: sales.id, sentAt: daysFromNow(-2, 15), viewCount: 3, lastViewedAt: daysFromNow(0, 7, 45), notes: "Tech-flagged opportunity. Customer viewed 3x — call today." },
      { number: "E-2085", status: "SENT", customerId: sandra.id, propertyId: pSandra.id, leadId: leadRepipe.id, createdById: sales2.id, sentAt: daysFromNow(-3, 11), viewCount: 1, lastViewedAt: daysFromNow(-3, 12) },
    ])
    .returning();

  const [whGood, whBetter, whBest] = await db
    .insert(t.estimateOptions)
    .values([
      { estimateId: estWH.id, tier: "GOOD", name: "Standard Replacement", description: "Like-for-like 50-gal gas water heater", sortOrder: 0 },
      { estimateId: estWH.id, tier: "BETTER", name: "Professional Package", description: "Premium unit + expansion tank + pan + 6-yr labor warranty", selected: true, sortOrder: 1 },
      { estimateId: estWH.id, tier: "BEST", name: "Tankless Upgrade", description: "Endless hot water, 0.96 UEF, 25-yr life expectancy", sortOrder: 2 },
      { estimateId: estSoftener.id, tier: "GOOD", name: "Water Softener", description: "40k grain softener installed", sortOrder: 0 },
      { estimateId: estSoftener.id, tier: "BETTER", name: "Softener + Filtration", description: "Softener plus whole-home carbon filtration", sortOrder: 1 },
      { estimateId: estRepipe.id, tier: "GOOD", name: "Repipe — 12 fixtures (PEX-A)", description: "Full galvanized replacement, drywall patching excluded", sortOrder: 0 },
      { estimateId: estRepipe.id, tier: "BETTER", name: "Repipe + New Main Shutoff + PRV", sortOrder: 1 },
    ])
    .returning();

  const li = (optionId: string, code: string, qty = 1, priceOverride?: number) => ({
    optionId,
    priceBookItemId: pbByCode[code].id,
    description: pbByCode[code].name,
    qty,
    unitPriceCents: priceOverride ?? pbByCode[code].unitPriceCents,
    unitCostCents: pbByCode[code].unitCostCents,
  });
  const opts = await db.select().from(t.estimateOptions);
  const byName = (n: string) => opts.find((o) => o.name === n)!.id;
  await db.insert(t.estimateLineItems).values([
    li(whGood.id, "WH-50G"),
    li(whBetter.id, "WH-50G-PRO"),
    li(whBetter.id, "EXP-TANK"),
    li(whBest.id, "WH-TANKLESS"),
    li(byName("Water Softener"), "WTR-SOFT"),
    li(byName("Softener + Filtration"), "WTR-SOFT"),
    { optionId: byName("Softener + Filtration"), description: "Whole-home carbon filtration system", qty: 1, unitPriceCents: $(1150), unitCostCents: $(380) },
    li(byName("Repipe — 12 fixtures (PEX-A)"), "REPIPE-PEX", 12),
    li(byName("Repipe + New Main Shutoff + PRV"), "REPIPE-PEX", 12),
    li(byName("Repipe + New Main Shutoff + PRV"), "MSV-34"),
    li(byName("Repipe + New Main Shutoff + PRV"), "PRV-34"),
  ]);

  console.log("Follow-ups…");
  await db.insert(t.followUps).values([
    { estimateId: estSoftener.id, channel: "SMS", status: "SENT", dueAt: daysFromNow(-1, 10), sentAt: daysFromNow(-1, 10), body: "Hi Tom! Just checking in on the water softener options we sent over. Any questions I can answer?" },
    { estimateId: estSoftener.id, channel: "CALL", status: "PENDING", dueAt: daysFromNow(0, 11), body: "Call — customer viewed estimate 3x this morning." },
    { estimateId: estSoftener.id, channel: "EMAIL", status: "PENDING", dueAt: daysFromNow(2, 9), body: "Email: softener financing breakdown ($38/mo)." },
    { estimateId: estRepipe.id, channel: "SMS", status: "SENT", dueAt: daysFromNow(-2, 10), sentAt: daysFromNow(-2, 10), body: "Hi Sandra, following up on your repipe estimate — happy to walk through the options." },
    { estimateId: estRepipe.id, channel: "SMS", status: "PENDING", dueAt: daysFromNow(0, 14), body: "Day-3 touch: repipe estimate, mention $118/mo financing." },
    { estimateId: estRepipe.id, channel: "EMAIL", status: "PENDING", dueAt: daysFromNow(1, 9), body: "Day-4 touch: email — what galvanized failure looks like (photos)." },
    { leadId: leadDenise.id, channel: "SMS", status: "PENDING", dueAt: new Date(Date.now() + 15 * 60 * 1000), body: "Speed-to-lead: auto-text sent, follow with call within 5 min." },
  ]);

  console.log("Project…");
  const [project] = await db
    .insert(t.projects)
    .values([
      {
        name: "Lakeview Bldg A — Boiler Replacement & Riser Repipe",
        status: "ACTIVE",
        customerId: lakeview.id,
        propertyId: pLakeA.id,
        contractValueCents: $(86500),
        budgetLaborCents: $(24000),
        budgetMaterialsCents: $(31000),
        startDate: daysFromNow(-12),
        endDate: daysFromNow(18),
      },
    ])
    .returning();

  await db.insert(t.milestones).values([
    { projectId: project.id, name: "Demo & boiler removal", status: "COMPLETE", dueDate: daysFromNow(-8), billingAmountCents: $(12000), billed: true, sortOrder: 0 },
    { projectId: project.id, name: "New boiler set & gas piping", status: "COMPLETE", dueDate: daysFromNow(-2), billingAmountCents: $(28000), billed: true, requiresInspection: true, sortOrder: 1 },
    { projectId: project.id, name: "Riser repipe floors 1-2", status: "IN_PROGRESS", dueDate: daysFromNow(6), billingAmountCents: $(22000), sortOrder: 2 },
    { projectId: project.id, name: "Riser repipe floor 3 + trim-out", status: "PENDING", dueDate: daysFromNow(13), billingAmountCents: $(16500), sortOrder: 3 },
    { projectId: project.id, name: "Final inspection & closeout", status: "BLOCKED", dueDate: daysFromNow(17), billingAmountCents: $(8000), requiresInspection: true, sortOrder: 4 },
  ]);

  await db.insert(t.changeOrders).values([
    { projectId: project.id, number: "CO-01", description: "Replace corroded gas shutoff discovered during boiler demo", amountCents: $(1850), status: "APPROVED", signedName: "Carla Reyes (Lakeview PM)", signedAt: daysFromNow(-7) },
    { projectId: project.id, number: "CO-02", description: "Asbestos abatement subcontractor (pipe insulation, floors 1-2)", amountCents: $(6400), status: "PENDING_SIGNATURE", createdAt: daysFromNow(-1) },
  ]);

  await db.insert(t.permits).values([
    { projectId: project.id, jurisdiction: "City of Riverton", permitNumber: "PLM-2026-0834", status: "ISSUED", feeCents: $(420) },
    { projectId: project.id, jurisdiction: "City of Riverton — Mechanical", permitNumber: "MEC-2026-0221", status: "INSPECTION_SCHEDULED", feeCents: $(310), inspectionAt: daysFromNow(2, 13), notes: "Boiler + gas piping rough inspection" },
  ]);

  await db.insert(t.costEntries).values([
    { projectId: project.id, kind: "MATERIAL", description: "Weil-McLain CGa-6 boiler + trim", amountCents: $(14800), incurredAt: daysFromNow(-10) },
    { projectId: project.id, kind: "MATERIAL", description: "Copper riser stock + fittings (Ferguson PO-3101)", amountCents: $(8900), incurredAt: daysFromNow(-5) },
    { projectId: project.id, kind: "LABOR", description: "Crew labor weeks 1-2", amountCents: $(11200), incurredAt: daysFromNow(-3) },
    { projectId: project.id, kind: "SUBCONTRACTOR", description: "Rigging — boiler removal/set", amountCents: $(2400), incurredAt: daysFromNow(-8) },
  ]);

  await db.insert(t.subcontractors).values([
    { projectId: project.id, name: "Riverton Rigging Co.", trade: "Rigging", phone: "555-5001", coiExpiresAt: daysFromNow(200), licenseNumber: "RG-2214" },
    { projectId: project.id, name: "SafeAir Abatement", trade: "Asbestos Abatement", phone: "555-5002", coiExpiresAt: daysFromNow(45), licenseNumber: "AB-0092" },
  ]);

  console.log("Invoices & payments…");
  const [invFlush, invFaucet, invMilestone, invOverdue] = await db
    .insert(t.invoices)
    .values([
      { number: "INV-3055", status: "PAID", customerId: helen.id, jobId: jFlush.id, issuedAt: daysFromNow(-1, 12), dueAt: daysFromNow(29), signedName: "Helen Marsh", signedAt: daysFromNow(-1, 12) },
      { number: "INV-3056", status: "SENT", customerId: bill.id, jobId: jFaucet.id, issuedAt: daysFromNow(-1, 16), dueAt: daysFromNow(29) },
      { number: "INV-3050", status: "PAID", customerId: lakeview.id, projectId: project.id, issuedAt: daysFromNow(-7), dueAt: daysFromNow(23) },
      { number: "INV-3041", status: "OVERDUE", customerId: bluebird.id, issuedAt: daysFromNow(-45), dueAt: daysFromNow(-15) },
    ])
    .returning();

  await db.insert(t.invoiceLineItems).values([
    { invoiceId: invFlush.id, priceBookItemId: pbByCode["DIAG"].id, description: "Membership annual service — water heater flush", qty: 1, unitPriceCents: $(0) },
    { invoiceId: invFlush.id, priceBookItemId: pbByCode["TP-VALVE"].id, description: "T&P Relief Valve (replaced)", qty: 1, unitPriceCents: $(58) },
    { invoiceId: invFaucet.id, priceBookItemId: pbByCode["FAU-KIT"].id, description: "Kitchen Faucet Install", qty: 1, unitPriceCents: $(425) },
    { invoiceId: invFaucet.id, priceBookItemId: pbByCode["SUP-LINE"].id, description: "Braided Supply Line", qty: 2, unitPriceCents: $(28) },
    { invoiceId: invMilestone.id, description: "Milestone 2: New boiler set & gas piping", qty: 1, unitPriceCents: $(28000) },
    { invoiceId: invOverdue.id, description: "Quarterly grease trap service (Q2)", qty: 1, unitPriceCents: $(550) },
  ]);

  await db.insert(t.payments).values([
    { invoiceId: invFlush.id, amountCents: $(58), method: "CARD", reference: "ch_demo_8812", receivedAt: daysFromNow(-1, 12, 5) },
    { invoiceId: invMilestone.id, amountCents: $(28000), method: "ACH", reference: "ach_demo_2210", receivedAt: daysFromNow(-4) },
  ]);

  console.log("Purchase orders & part requests…");
  const [po] = await db
    .insert(t.purchaseOrders)
    .values([{ number: "PO-3102", supplier: "Ferguson", status: "SENT", expectedAt: daysFromNow(2) }])
    .returning();
  await db.insert(t.purchaseOrderLines).values([
    { purchaseOrderId: po.id, priceBookItemId: pbByCode["WH-50G-PRO"].id, qty: 2, unitCostCents: $(880) },
    { purchaseOrderId: po.id, priceBookItemId: pbByCode["ANODE-ROD"].id, qty: 6, unitCostCents: $(14) },
    { purchaseOrderId: po.id, priceBookItemId: pbByCode["PEX-34-100"].id, qty: 4, unitCostCents: $(58) },
  ]);
  await db.insert(t.partRequests).values([
    { requestedById: tech.id, jobId: jDrain.id, description: "Need 2\" auger cable head — mine is worn", status: "OPEN", qty: 1 },
    { requestedById: tech2.id, priceBookItemId: pbByCode["WAX-RING"].id, description: "Wax rings — below min on truck", status: "ORDERED", qty: 6 },
  ]);

  console.log("Commission rules & entries…");
  await db.insert(t.commissionRules).values([
    { name: "Sales — % of sold revenue", kind: "PERCENT_REVENUE", rate: 5, role: "SALES_PM" },
    { name: "Tech lead-flag spiff", kind: "SPIFF", rate: 5000, role: "TECH" },
    { name: "Water heater sale spiff (tech-sold)", kind: "SPIFF", rate: 7500, role: "TECH", category: "Water Heaters" },
    { name: "PM — % of project margin", kind: "PERCENT_MARGIN", rate: 8, role: "SALES_PM" },
  ]);
  await db.insert(t.commissionEntries).values([
    { userId: sales.id, description: "E-2088 approved — Boyd water heater (5% of $2,675)", amountCents: $(133.75), period: period(), status: "APPROVED", sourceType: "ESTIMATE", sourceId: estWH.id },
    { userId: sales.id, description: "Bluebird service contract renewal (5% of $2,200)", amountCents: $(110), period: period(), status: "PENDING" },
    { userId: tech.id, description: "Lead-flag spiff — Boyd water softener opportunity", amountCents: $(50), period: period(), status: "APPROVED", sourceType: "LEAD", sourceId: leadSoftener.id },
    { userId: sales2.id, description: "Lakeview CO-01 approved (8% margin share)", amountCents: $(88), period: period(), status: "PENDING" },
    { userId: tech2.id, description: "5-star review bonus — Bill Hendricks", amountCents: $(25), period: period(), status: "PAID" },
  ]);

  console.log("Knowledge base…");
  await db.insert(t.kbArticles).values([
    {
      slug: "water-heater-install-sop",
      title: "SOP: Gas Water Heater Installation",
      category: "SOP",
      tags: ["water heater", "gas", "install"],
      authorId: admin.id,
      verifiedAt: daysFromNow(-30),
      body: `## Purpose\nStandard procedure for replacing a residential gas water heater.\n\n## Before you start\n1. Confirm signed estimate & selected option in the app\n2. **Photos: capture BEFORE photos** (existing unit, venting, gas line, surroundings)\n3. Shut off gas at appliance valve; verify with meter\n4. Shut off cold supply; connect drain hose, open T&P to break vacuum\n\n## Installation\n1. Set new unit; maintain 18" clearance to combustibles\n2. Install new dielectric nipples & flexible connectors\n3. Install expansion tank if closed system (check PRV/backflow)\n4. Reconnect venting — verify draft with smoke test\n5. Gas: pipe dope rated for LP/NG; **leak-test every joint with solution**\n\n## Commissioning\n1. Fill tank fully before igniting (open hot tap until steady flow)\n2. Light per manufacturer; set to 120°F\n3. Complete **Gas Safety Verification form** — required to close job\n4. AFTER photos matching before angles\n\n## Callback prevention\n- Verify T&P discharge pipe terminates within 6" of floor\n- Tag & date the unit; register warranty before leaving driveway`,
    },
    {
      slug: "sewer-camera-sop",
      title: "SOP: Sewer Camera Inspection & Documentation",
      category: "SOP",
      tags: ["drains", "camera", "sewer"],
      authorId: admin.id,
      verifiedAt: daysFromNow(-45),
      body: `## When to run a camera\nAlways offer after a 2nd mainline clog within 24 months (see Gerald Nakamura pattern). Recurring clogs = probable root intrusion or belly.\n\n## Procedure\n1. Locate cleanout; BEFORE photo of access\n2. Run camera slowly; note footage counter at each finding\n3. Record video; flag roots, offsets, bellies, breaks with footage marks\n4. Locate & mark surface position of major defects\n\n## Selling the repair honestly\nShow the customer the screen. Explain options: spot repair vs. liner vs. replacement — with pricing from the price book. Never diagnose what the camera didn't show.`,
    },
    {
      slug: "safety-gas-leak",
      title: "SAFETY: Suspected Gas Leak Response",
      category: "SAFETY",
      tags: ["gas", "emergency", "safety"],
      authorId: admin.id,
      verifiedAt: daysFromNow(-10),
      body: `## If you smell gas on site\n1. **Do not** operate switches, igniters, or phones inside\n2. Evacuate occupants immediately\n3. Shut off gas at meter if safely accessible\n4. Call gas utility emergency line from outside\n5. Notify office; do not re-enter until cleared\n\n## Never\n- Never use open flame to locate leaks\n- Never leave a suspected leak "for the utility to find"`,
    },
    {
      slug: "warranty-policy",
      title: "POLICY: Labor Warranty Terms",
      category: "POLICY",
      tags: ["warranty", "callbacks"],
      authorId: admin.id,
      verifiedAt: daysFromNow(-60),
      body: `## Standard terms\n- Repairs: 1 year labor\n- Fixture installs: 2 years labor\n- Water heaters (Professional package): 6 years labor\n- Repipes: 10 years labor\n\n## Callbacks\nWarranty callbacks are dispatched at HIGH priority, no charge to customer. Tech on original job gets first assignment when available. Callback rate is tracked per tech on scorecards.`,
    },
    {
      slug: "discount-policy",
      title: "POLICY: Discounts & Approvals",
      category: "POLICY",
      tags: ["pricing", "discounts"],
      authorId: admin.id,
      body: `- Techs/CSRs: may apply membership pricing automatically; no other discounts\n- Sales: up to 10% without approval; beyond 10% requires Admin approval in-app\n- Never discount below cost + 20% margin floor\n- Price-match requests: escalate to office with competitor quote photo`,
    },
    {
      slug: "navien-npe-troubleshooting",
      title: "EQUIPMENT: Navien NPE-240A2 — Common Error Codes",
      category: "EQUIPMENT",
      tags: ["tankless", "navien", "troubleshooting"],
      authorId: tech.id,
      verifiedAt: daysFromNow(-20),
      body: `## E003 — Ignition failure\nCheck gas supply pressure (NG 3.5-10.5" WC). Common cause: undersized gas line on retrofits.\n\n## E012 — Flame loss\nUsually condensate backup or wind-affected venting. Check intake screen for debris.\n\n## E407/E439 — Cold water sensor\nDescale first (isolation valves + pump, 45 min white vinegar). Hard-water homes need annual descale — **flag softener opportunity in the app** (spiff eligible).\n\n*Captured from Jake's field notes, verified by Dana.*`,
    },
    {
      slug: "on-my-way-scripts",
      title: "SOP: Customer Communication Scripts",
      category: "SOP",
      tags: ["communication", "customer service"],
      authorId: office.id,
      body: `## On my way (auto-sent by app)\n"Hi {first name}, this is {tech} from Apex Plumbing. I'm on my way and should arrive around {ETA}. Reply here with any access notes!"\n\n## Arrival\nIntroduce yourself by name, shoe covers on at the door, confirm the issue in the customer's words before opening the tool bag.\n\n## Presenting options\nAlways present all options on the tablet, top tier first, monthly payment visible. Let the customer choose — never pre-filter for them ("I didn't think you'd want the expensive one" is a lost upsell and an insult).`,
    },
    {
      slug: "grease-trap-service",
      title: "SOP: Commercial Grease Trap Service",
      category: "SOP",
      tags: ["commercial", "grease trap"],
      authorId: admin.id,
      body: `1. Schedule outside kitchen rush (Bluebird: 3-5pm window)\n2. BEFORE photo of trap condition + depth measurement\n3. Pump, scrape baffles, inspect gaskets\n4. Log FOG depth in service form — required for health-inspection records\n5. AFTER photo; leave signed service tag on unit`,
    },
    {
      slug: "hr-basics",
      title: "HR: Pay, Time Off & Truck Policy",
      category: "HR",
      tags: ["hr", "payroll"],
      authorId: admin.id,
      body: `- Pay period: 1st-15th, 16th-EOM; direct deposit 5 business days after close\n- Commission/spiffs: visible in your Earnings tab in real time, paid with regular payroll after approval\n- PTO requests: 2 weeks notice in app; emergencies call Dana\n- Trucks: take-home for on-call week only; GPS active during work hours only — you can view your own history under Profile`,
    },
    {
      slug: "emergency-after-hours",
      title: "EMERGENCY: After-Hours Dispatch Protocol",
      category: "EMERGENCY",
      tags: ["emergency", "dispatch", "on-call"],
      authorId: office.id,
      body: `1. After-hours calls hit the answering AI → emergency triage\n2. True emergencies (active leak, no water, sewage backup, gas): page on-call tech\n3. On-call tech must acknowledge within 10 min or escalation goes to backup, then Dana\n4. Emergency rate applies after 6pm & weekends — quoted up front by the AI/CSR`,
    },
  ]);

  console.log("Activities…");
  await db.insert(t.activities).values([
    { kind: "STATUS", body: "Job J-1041 dispatched to Jake Sullivan", userId: office.id, jobId: jWH.id, customerId: boyd.id, createdAt: daysFromNow(0, 7, 45) },
    { kind: "ESTIMATE_VIEW", body: "Tom Boyd viewed estimate E-2091 (3rd view)", customerId: boyd.id, leadId: leadSoftener.id, createdAt: daysFromNow(0, 7, 45) },
    { kind: "SMS", body: "Auto follow-up sent: water softener estimate day-1 touch", userId: sales.id, customerId: boyd.id, createdAt: daysFromNow(-1, 10) },
    { kind: "CALL", body: "Inbound: Denise Cooper — water heater leaking, wants quote today (recorded, 3:42)", customerId: null, leadId: leadDenise.id, createdAt: daysFromNow(0, 8, 5) },
    { kind: "PAYMENT", body: "Payment $58.00 (card) on INV-3055", customerId: helen.id, createdAt: daysFromNow(-1, 12, 5) },
    { kind: "REVIEW", body: "⭐⭐⭐⭐⭐ Google review from Bill Hendricks — mentioned Luis by name", userId: tech2.id, customerId: bill.id, createdAt: daysFromNow(-1, 18) },
    { kind: "NOTE", body: "Lakeview PM asked for CO-02 signature deadline reminder Friday", userId: sales2.id, projectId: project.id, customerId: lakeview.id, createdAt: daysFromNow(-1, 9) },
    { kind: "SYSTEM", body: "Permit MEC-2026-0221 inspection scheduled for " + daysFromNow(2, 13).toLocaleDateString(), projectId: project.id, createdAt: daysFromNow(-1, 8) },
  ]);

  console.log("Notifications…");
  await db.insert(t.notifications).values([
    { userId: sales.id, title: "🔥 Hot: Tom Boyd viewed E-2091 three times today", body: "Water softener estimate — call now.", href: "/estimates" },
    { userId: sales.id, title: "New lead: Water heater leaking (Google LSA)", body: "SLA: respond within 30 min.", href: "/leads" },
    { userId: tech.id, title: "You're dispatched: J-1041 Water Heater Replacement", body: "Boyd residence, 8:30 AM. Gate code on property record.", href: "/my-day" },
    { userId: tech.id, title: "Truck 12 below min: Anode Rods (1 of 2)", body: "Added to replenishment list.", href: "/inventory" },
    { userId: office.id, title: "Invoice INV-3041 is 15 days overdue", body: "Bluebird Cafe — $550. Collections queue.", href: "/invoices" },
    { userId: admin.id, title: "Change order CO-02 awaiting customer signature", body: "Lakeview abatement, $6,400 — sent yesterday.", href: "/projects" },
    { userId: admin.id, title: "Commission approvals pending: 2 entries", body: "$198.00 total for July.", href: "/commissions" },
    { userId: tech2.id, title: "Part request update: wax rings ordered", body: "On PO-3102, expected in 2 days.", href: "/inventory" },
  ]);

  console.log("Integrations…");
  await db.insert(t.integrationConnections).values([
    { provider: "QUICKBOOKS", status: "CONNECTED", lastSyncAt: daysFromNow(0, 6), config: { realm: "demo", syncInvoices: true, syncPayments: true } },
    { provider: "HUBSPOT", status: "CONNECTED", lastSyncAt: daysFromNow(0, 5, 30), config: { portal: "demo", leadsInbound: true, activitiesOutbound: true } },
    { provider: "STRIPE", status: "CONNECTED", lastSyncAt: daysFromNow(0, 7), config: { mode: "test" } },
    { provider: "TWILIO", status: "CONNECTED", lastSyncAt: daysFromNow(0, 7), config: { number: "+15550199" } },
    { provider: "SALESFORCE", status: "DISCONNECTED" },
    { provider: "FERGUSON", status: "ERROR", lastSyncAt: daysFromNow(-2), config: { note: "Punchout session expired — reconnect" } },
    { provider: "GOOGLE_LSA", status: "CONNECTED", lastSyncAt: daysFromNow(0, 8) },
    { provider: "ANGI", status: "CONNECTED", lastSyncAt: daysFromNow(0, 8) },
    { provider: "ORGMEMORY", status: "DISCONNECTED", config: { namespace: "plumber_app" } },
  ]);

  console.log("Messages…");
  const [conv1, conv2] = await db
    .insert(t.conversations)
    .values([
      { isGroup: false, createdById: office.id, lastMessageAt: daysFromNow(0, 8, 15) },
      { title: "Lakeview Bldg A crew", isGroup: true, createdById: sales2.id, lastMessageAt: daysFromNow(0, 7, 50) },
    ])
    .returning();
  await db.insert(t.conversationParticipants).values([
    { conversationId: conv1.id, userId: office.id, lastReadAt: daysFromNow(0, 8, 15) },
    { conversationId: conv1.id, userId: tech.id, lastReadAt: daysFromNow(-1) }, // tech has unread
    { conversationId: conv2.id, userId: sales2.id, lastReadAt: daysFromNow(0, 7, 50) },
    { conversationId: conv2.id, userId: tech.id, lastReadAt: daysFromNow(-1) },
    { conversationId: conv2.id, userId: admin.id, lastReadAt: daysFromNow(0, 7, 55) },
  ]);
  await db.insert(t.messages).values([
    { conversationId: conv1.id, senderId: office.id, body: "Hey Jake — Boyd water heater is approved, you're dispatched for 8:30. Gate code's on the property record.", createdAt: daysFromNow(0, 8, 10) },
    { conversationId: conv1.id, senderId: office.id, body: "Also, customer mentioned a dog — friendly per the notes. 🐶", createdAt: daysFromNow(0, 8, 15) },
    { conversationId: conv2.id, senderId: sales2.id, body: "Team — abatement CO-02 is out for signature. Hold floor 1-2 riser work until it's signed.", createdAt: daysFromNow(0, 7, 45) },
    { conversationId: conv2.id, senderId: admin.id, body: "Good call. I'll ping the PM at Lakeview this morning.", createdAt: daysFromNow(0, 7, 50) },
  ]);

  console.log("Audit log…");
  await db.insert(t.auditLogs).values([
    { userId: admin.id, action: "UPDATE", entity: "PriceBookItem", entityId: pbByCode["WH-50G-PRO"].id, detail: { field: "unitPriceCents", from: 239500, to: 245000 } },
    { userId: sales.id, action: "APPROVE_DISCOUNT", entity: "Estimate", entityId: estRepipe.id, detail: { requested: "8%", approved: true } },
    { userId: office.id, action: "REFUND_REQUEST", entity: "Invoice", entityId: invOverdue.id, detail: { status: "denied", reason: "No basis" } },
  ]);

  console.log("✅ Seed complete.");
  console.log("Demo accounts (password: demo1234):");
  console.log("  owner@apexplumbing.demo  (Admin/Owner)");
  console.log("  office@apexplumbing.demo (Office/Dispatch)");
  console.log("  sales@apexplumbing.demo  (Sales/PM)");
  console.log("  tech@apexplumbing.demo   (Field Tech)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
