const RUN = new URLSearchParams(location.search).get("run") ?? "unknown";
function record(task, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  fetch(`${location.protocol}//${location.host}/record?run=${encodeURIComponent(RUN)}&task=${encodeURIComponent(task)}&value=${encodeURIComponent(text)}`);
  const status = document.getElementById("status");
  if (status) status.textContent = `Recorded: ${text}`;
}
