const contextEl = document.getElementById("context");
const startBtn = document.getElementById("startBtn");
const cancelBtn = document.getElementById("cancelBtn");
const stepEl = document.getElementById("step");
const progressEl = document.getElementById("progress");
const logsEl = document.getElementById("logs");

let activeTabId = null;
let pollTimer = null;
let detectedStudyId = null;

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function appendLine(line) {
  const now = new Date().toLocaleTimeString();
  const existing = logsEl.textContent ? `${logsEl.textContent}\n` : "";
  logsEl.textContent = `${existing}[${now}] ${line}`;
  logsEl.scrollTop = logsEl.scrollHeight;
}

async function sendMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function refreshContext() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    contextEl.textContent = "No active tab found.";
    startBtn.disabled = true;
    return;
  }

  activeTabId = tab.id;
  const res = await sendMessage("detectStudyContext", { tabId: activeTabId });
  if (!res?.ok) {
    contextEl.textContent = res?.error || "Could not inspect page.";
    startBtn.disabled = true;
    return;
  }

  detectedStudyId = res.context.studyId || null;
  if (!res.context.supportedHost) {
    contextEl.textContent = "Open an ETHOS page on ethos.swmed.edu.";
    startBtn.disabled = true;
    return;
  }
  if (!res.context.isLikelyWorkspace) {
    contextEl.textContent = `ETHOS detected${detectedStudyId ? ` (${detectedStudyId})` : ""}, but this does not look like a study workspace.`;
    startBtn.disabled = true;
    return;
  }

  contextEl.textContent = `Ready${detectedStudyId ? ` - ${detectedStudyId}` : ""}`;
  startBtn.disabled = false;
}

function renderJob(job) {
  if (!job) {
    stepEl.textContent = "Idle";
    progressEl.textContent = "";
    cancelBtn.disabled = true;
    return;
  }

  const statusLabel = String(job.status || "")
    .replace(/_/g, " ")
    .toUpperCase();
  stepEl.textContent = `${statusLabel} - ${job.step}`;
  const docs = `${job.documentIndex}/${job.documentTotal}`;
  const sections = `${job.sectionIndex}/${job.sectionTotal}`;
  progressEl.textContent = `Study: ${job.studyId || "-"} | Sections: ${sections} | Documents: ${docs} | W:${job.warningCount || 0} E:${job.errorCount || 0}`;
  cancelBtn.disabled = job.status !== "running";
}

async function pollStatus() {
  if (!activeTabId) return;
  const res = await sendMessage("getJobStatus", { tabId: activeTabId });
  if (!res?.ok) return;
  renderJob(res.job);

  const lines = res.job?.logs || [];
  logsEl.textContent = lines.join("\n");
  logsEl.scrollTop = logsEl.scrollHeight;

  if (!res.job || res.job.status !== "running") {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
}

startBtn.addEventListener("click", async () => {
  if (!activeTabId) return;
  startBtn.disabled = true;
  appendLine("Starting export...");
  const res = await sendMessage("startExport", { tabId: activeTabId });
  if (!res?.ok) {
    appendLine(`Start failed: ${res?.error || "unknown error"}`);
    await refreshContext();
    return;
  }
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      pollStatus().catch((err) => appendLine(`Polling error: ${err.message || err}`));
    }, 1000);
  }
  await pollStatus();
});

cancelBtn.addEventListener("click", async () => {
  if (!activeTabId) return;
  const res = await sendMessage("cancelExport", { tabId: activeTabId });
  if (res?.ok) appendLine("Cancel requested.");
});

(async () => {
  await refreshContext();
  await pollStatus();
})();
