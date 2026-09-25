const B = "http://127.0.0.1:8900";
const RUN = "script-arc";
const t = await task("scripted-bench");
const page = t.page();
const times = {};
const time = async (name, work) => {
  const start = performance.now();
  await work();
  times[name] = Math.round(performance.now() - start);
};
const url = (file) => `${B}/${file}?run=${RUN}`;

await time("B1", async () => {
  await page.goto(url("b1.html"));
  await page.fill("#name", "Ada Lovelace");
  await page.fill("#email", "ada@example.com");
  await page.selectOption("#country", "Portugal");
  await page.click('input[value="Pro"]');
  await page.click('input[name="terms"]');
  await page.click("form button");
});
await time("B2", async () => {
  await page.goto(url("b2.html"));
  await page.waitForTimeout(300);
  const found = await page.find("code");
  const field = found.match(/^(@[\d.]+) textbox/m)[1];
  await page.fill(field, "ARC-42");
  const button = (await page.find("verify")).match(/^(@[\d.]+) button/m)[1];
  await page.click(button);
});
await time("B3", async () => {
  await page.goto(url("b3.html"));
  await page.acceptDialog();
  await page.click("text=Delete project");
});
await time("B4", async () => {
  await page.goto(url("b4.html"));
  await page.evaluate(() => {
    const viewport = document.getElementById("vp");
    viewport.scrollTop = 777 * 32 - 100;
    viewport.dispatchEvent(new Event("scroll"));
  });
  await page.click('text="Row 777"');
});
await time("B5", async () => {
  await page.goto(url("b5.html"));
  await page.dragAndDrop("li:nth-child(4)", "li:nth-child(1)");
  await page.click("#save");
});
await time("B6", async () => {
  await page.goto(url("b6.html"));
  const receipt = await page.click("text=Open report");
  const report = t.page(receipt.popups[0].label);
  const code = await report.evaluate("document.getElementById('code').textContent");
  if (code !== "Q7-ZEBRA") throw new Error(`B6 code ${code}`);
  await report.close();
});
await time("B7", async () => {
  await page.goto(url("b7.html"));
  await page.waitForSelector(".cm-content", { timeout: 15_000 });
  await page.fill(".cm-content", "function add(a, b) {\n  return a + b;\n}");
  await page.click("text=Save snippet");
});
await time("B8", async () => {
  await page.goto(url("b8.html"));
  await page.click("text=Activate engine");
});
await time("B9", async () => {
  await page.goto(url("b9.html"));
  await page.click("text=Load results");
  await page.waitForFunction(() => Boolean(document.getElementById("cont")), undefined, { timeout: 8_000 });
  await page.click("#cont");
});
await time("B10", async () => {
  await page.goto(url("b10.html"));
  await page.hover("text=Account");
  await page.click("text=Sign out");
});
await t.finish();
console.log(JSON.stringify(times));
