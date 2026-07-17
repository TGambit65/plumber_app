import { chromium, devices } from "playwright";
const BASE="http://localhost:3000";
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium"});
for (const [k,opts] of [["desktop",{viewport:{width:1440,height:900},deviceScaleFactor:2}],["mobile",devices["iPhone 13"]]]){
  const p=await (await b.newContext(opts)).newPage();
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle"}); await p.waitForTimeout(600);
  await p.screenshot({path:`/tmp/shots/login_${k}.png`});
}
await b.close(); console.log("login re-captured");
