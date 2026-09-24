const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SETTLE_MS = 250;

function between(from, to, fraction) {
  return { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction };
}

function eventWaiter(page, waitForEvent) {
  if (waitForEvent) return waitForEvent;
  if (typeof page._waitForCdpEvent === "function") return (method, options) => page._waitForCdpEvent(method, options);
  throw new Error("html5Drag needs page._waitForCdpEvent or a waitForEvent option.");
}

async function looksDraggable(page, point) {
  return page
    .evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("[draggable=\"true\"], a[href], img")),
      point,
    )
    .catch(() => false);
}

export async function html5Drag(page, from, to, { steps = 8, timeout = 3000, waitForEvent } = {}) {
  const wait = eventWaiter(page, waitForEvent);
  const draggable = await looksDraggable(page, from);
  await page.cdp("Input.setInterceptDrags", { enabled: true });
  let data = null;
  const intercepted = Promise.resolve()
    .then(() => wait("Input.dragIntercepted", { timeout }))
    .then(
      (params) => {
        data = params.data;
      },
      () => {},
    );
  try {
    await page.mouse.move(from.x, from.y, { label: "drag" });
    await page.mouse.down();
    let current = from;
    for (let step = 1; step <= steps && !data; step++) {
      current = between(from, to, step / steps);
      await page.mouse.move(current.x, current.y, { label: false });
    }
    if (!data) await Promise.race([intercepted, sleep(draggable ? timeout : SETTLE_MS)]);
    if (data) {
      await page.cdp("Input.dispatchDragEvent", { type: "dragEnter", x: current.x, y: current.y, data });
      const overSteps = Math.max(1, Math.ceil(steps / 2));
      for (let step = 1; step <= overSteps; step++) {
        const point = between(current, to, step / overSteps);
        await page.cdp("Input.dispatchDragEvent", { type: "dragOver", x: point.x, y: point.y, data });
      }
      await page.cdp("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
    }
    await page.mouse.move(to.x, to.y, { label: "drop" });
    await page.mouse.up();
    return { intercepted: Boolean(data) };
  } finally {
    await page.cdp("Input.setInterceptDrags", { enabled: false }).catch(() => {});
  }
}
