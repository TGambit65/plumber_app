import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await b.newPage();
await page.goto("file:///tmp/pzdoc/doc.html", { waitUntil: "networkidle" });
await page.evaluate(async () => { await document.fonts.ready; });
await page.waitForTimeout(600);
const footer = `<div style="width:100%;font-family:Inter,sans-serif;font-size:7pt;color:#8a94a3;padding:0 0.55in;display:flex;justify-content:space-between;">
  <span>Plumb Zebra Field Ops — private pilot invitation</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;
await page.pdf({
  path: "/tmp/pzdoc/Plumb-Zebra-Field-Ops.pdf",
  format: "Letter",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate: footer,
  margin: { top: "0.5in", bottom: "0.7in", left: "0.55in", right: "0.55in" },
});
await b.close();
console.log("PDF rendered");
