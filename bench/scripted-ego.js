const B = "http://127.0.0.1:8900";
const RUN = "script-ego";
const task = await taskSpace("scripted-bench");
const page = task.page("p1");
const times = {};
const time = async (name, work) => {
  const start = performance.now();
  await work();
  times[name] = Math.round(performance.now() - start);
};
const url = (file) => `${B}/${file}?run=${RUN}`;
const refOf = (snapshot, role, text) => {
  const lines = snapshot.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(new RegExp(`^\\s*${role} \\[ref=(\\d+)\\]`));
    if (!match) continue;
    const window = lines.slice(index, index + 4).join(" ");
    if (!text || window.includes(text)) return `@${match[1]}`;
  }
  throw new Error(`no ${role} ${text}`);
};

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
  const snapshot = await page.snapshot();
  await page.fill(refOf(snapshot, "textbox"), "ARC-42");
  await page.click(refOf(snapshot, "button", "Verify"));
});
await time("B3", async () => {
  await page.goto(url("b3.html"));
  const receipt = await page.click("text=Delete project");
  if (receipt?.dialog || (await page.info()).dialog) await page.acceptDialog();
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
  const popupPromise = page.waitForEvent("popup");
  await page.click("text=Open report");
  const report = await popupPromise;
  await report.waitForLoadState();
  const code = await report.evaluate(() => document.getElementById("code").textContent);
  if (code !== "Q7-ZEBRA") throw new Error(`B6 code ${code}`);
  await report.close();
});
await time("B7", async () => {
  await page.goto(url("b7.html"));
  await page.waitForSelector(".cm-content", { timeout: 15_000 });
  await page.click(".cm-content");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.paste("function add(a, b) {\n  return a + b;\n}");
  await page.click("text=Save snippet");
});
await time("B8", async () => {
  await page.goto(url("b8.html"));
  const snapshot = await page.snapshot();
  await page.click(refOf(snapshot, "button", "Activate engine"));
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
await task.finish({ keep: [] });
console.log(JSON.stringify(times));
