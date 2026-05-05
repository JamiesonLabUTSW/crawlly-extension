const JOBS = new Map();
const SUPPORTED_HOSTS = ["ethos.swmed.edu"];
const PENDING_EXTENSION_FILENAMES = [];

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
  return (
    (name || "")
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^A-Za-z0-9._-]/g, "") || "unnamed"
  );
}

function sanitizeExtension(ext) {
  if (!ext) return "";
  let value = String(ext).trim().toLowerCase();
  if (!value.startsWith(".")) value = `.${value}`;
  if (!/^\.[a-z0-9]{1,8}$/.test(value)) return "";
  return value;
}

function extractExtension(fileNameOrUrl) {
  const candidate = String(fileNameOrUrl || "")
    .split("?")[0]
    .split("#")[0];
  const lastSlash = candidate.lastIndexOf("/");
  const tail = lastSlash >= 0 ? candidate.slice(lastSlash + 1) : candidate;
  const dot = tail.lastIndexOf(".");
  if (dot <= 0) return "";
  return tail.slice(dot);
}

function normalizeStudyId(raw) {
  if (!raw) return null;
  const match = String(raw).match(/\bSTU(?:[-\s]?\d){5,}\b/i);
  return match ? match[0].trim() : null;
}

function makeRelativeFromAbsolute(absPath, studyId) {
  if (!absPath) return null;
  const marker = `ETHOS/${studyId}/`;
  const idx = absPath.replace(/\\/g, "/").indexOf(marker);
  if (idx < 0) return null;
  return absPath.replace(/\\/g, "/").slice(idx + marker.length);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractBodyHtml(html) {
  const raw = String(html || "");
  const match = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : raw;
}

function buildStitchedSectionHtml(sectionLabel, parts) {
  const safeTitle = escapeHtml(sectionLabel || "Section");
  const normalizedParts = Array.isArray(parts)
    ? parts
        .filter((part) => part?.html)
        .map((part) => ({
          html: extractBodyHtml(part.html)
        }))
    : [];
  const partBlocks = normalizedParts
    .map((part, index) => {
      const pageBreak = index < normalizedParts.length - 1 ? "<div class='page-break'></div>" : "";
      return [
        "<section class='part'>",
        "<div class='part-content'>",
        part.html,
        "</div>",
        "</section>",
        pageBreak
      ].join("");
    })
    .join("");

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset='utf-8' />",
    `<title>${safeTitle}</title>`,
    "<style>body{color:#111;margin:0;background:#fff;}.part{margin:0;}.part-content{margin:0;padding:0;}.page-break{page-break-after:always;}table{border-collapse:collapse;}td,th{border:1px solid #d2d8dd;padding:4px;vertical-align:top;}a{color:#0b5cab;}</style>",
    "</head>",
    "<body>",
    partBlocks,
    "</body>",
    "</html>"
  ].join("");
}

function queueExpectedFilename(filename, conflictAction = "uniquify") {
  PENDING_EXTENSION_FILENAMES.push({
    filename,
    conflictAction,
    createdAt: Date.now()
  });
  if (PENDING_EXTENSION_FILENAMES.length > 200) {
    PENDING_EXTENSION_FILENAMES.splice(0, PENDING_EXTENSION_FILENAMES.length - 200);
  }
}

function popExpectedFilename() {
  const now = Date.now();
  while (PENDING_EXTENSION_FILENAMES.length > 0) {
    const item = PENDING_EXTENSION_FILENAMES.shift();
    if (!item) return null;
    if (now - item.createdAt <= 120000) {
      return item;
    }
  }
  return null;
}

function createJob(tabId) {
  const job = {
    id: `job-${tabId}-${Date.now()}`,
    tabId,
    status: "running",
    step: "Initializing",
    studyId: null,
    workspaceUrl: null,
    sectionIndex: 0,
    sectionTotal: 0,
    documentIndex: 0,
    documentTotal: 0,
    logs: [],
    errors: [],
    warnings: [],
    cancelRequested: false,
    startedAt: nowIso(),
    smartformSections: [],
    documents: [],
    awaitingDoc: null,
    diagnostics: {
      schemaVersion: "1.3",
      captureEngine: "smartform-print-project-v1",
      startedAt: nowIso(),
      context: {},
      smartform: {
        frameId: null,
        sectionCountDetected: 0,
        sectionReports: []
      },
      documents: {
        frameId: null,
        optionRowsDetected: 0,
        items: []
      },
      warnings: [],
      errors: []
    }
  };
  JOBS.set(tabId, job);
  return job;
}

function logJob(job, message) {
  const line = `${new Date().toLocaleTimeString()} ${message}`;
  job.logs.push(line);
  if (job.logs.length > 300) {
    job.logs = job.logs.slice(job.logs.length - 300);
  }
}

function failJob(job, err) {
  job.status = "failed";
  job.step = "Failed";
  const message = err?.message || String(err);
  job.errors.push(message);
  job.diagnostics.errors.push(message);
  logJob(job, `ERROR: ${message}`);
}

function completeJob(job) {
  if (job.warnings.length > 0) {
    job.status = "completed_with_warnings";
    job.step = "Completed with warnings";
    logJob(job, "Export completed with warnings.");
    return;
  }
  job.status = "completed";
  job.step = "Completed";
  logJob(job, "Export completed.");
}

function cancelJob(job) {
  job.status = "cancelled";
  job.step = "Cancelled";
  logJob(job, "Export cancelled.");
}

function warnJob(job, message) {
  job.warnings.push(message);
  job.diagnostics.warnings.push(message);
  logJob(job, `WARN: ${message}`);
}

async function runScript(tabId, func, args = [], frameId = null) {
  const target = frameId == null ? { tabId } : { tabId, frameIds: [frameId] };
  const result = await chrome.scripting.executeScript({
    target,
    func,
    args
  });
  if (!result || !result.length) return null;
  return result[0].result;
}

async function runScriptAllFrames(tabId, func, args = []) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func,
    args
  });
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(250);
  }
  throw new Error("Timed out waiting for tab load.");
}

function stripHash(url) {
  return String(url || "").split("#")[0];
}

async function getWindowTabSnapshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  return {
    tabId,
    windowId: tab.windowId,
    url: tab.url || "",
    tabIds: tabs.map((item) => item.id).filter((id) => typeof id === "number")
  };
}

async function detectLinkClickOutcome(tabId, beforeSnapshot) {
  if (!beforeSnapshot) {
    return {
      urlChanged: false,
      openedNewTabIds: [],
      currentUrl: ""
    };
  }
  const currentTab = await chrome.tabs.get(tabId);
  const tabs = await chrome.tabs.query({ windowId: beforeSnapshot.windowId });
  const beforeIds = new Set(beforeSnapshot.tabIds || []);
  const openedNewTabIds = tabs
    .map((item) => item.id)
    .filter((id) => typeof id === "number" && !beforeIds.has(id));
  const currentUrl = currentTab.url || "";
  const urlChanged = stripHash(currentUrl) !== stripHash(beforeSnapshot.url);
  return {
    urlChanged,
    openedNewTabIds,
    currentUrl
  };
}

function isLikelyEthosDownload(item) {
  const name = String(item?.filename || "").toLowerCase();
  const urls = [item?.url, item?.finalUrl].map((v) => String(v || "")).filter(Boolean);

  for (const raw of urls) {
    try {
      const host = new URL(raw).host.toLowerCase();
      if (host.includes("ethos.swmed.edu")) return true;
    } catch (_) {
      // ignore parse errors
    }
  }

  if (/^download(\s\(\d+\))?\.html$/.test(name)) return true;
  if (name.includes("/ethos/") || name.includes("\\ethos\\")) return true;
  return false;
}

async function waitForCreatedDownload(job, timeoutMs = 30000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onCreated.removeListener(onCreated);
      reject(new Error("Timed out waiting for download creation."));
    }, timeoutMs);

    function onCreated(item) {
      if (item.byExtensionId === chrome.runtime.id) return;
      if (Date.now() < startTime) return;

      const tabMatches =
        item.tabId === job.tabId || item.tabId === -1 || typeof item.tabId !== "number";
      const likelyEthos = isLikelyEthosDownload(item);
      const awaitingJobs = Array.from(JOBS.values()).filter(
        (entry) => entry.status === "running" && entry.awaitingDoc
      );
      const onlyThisJobAwaiting = awaitingJobs.length === 1 && awaitingJobs[0]?.id === job.id;
      if (!tabMatches && !likelyEthos && !onlyThisJobAwaiting) return;

      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      resolve(item);
    }
    chrome.downloads.onCreated.addListener(onCreated);
  });
}

async function waitForDownloadComplete(downloadId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items?.[0];
    if (!item) throw new Error(`Download ${downloadId} not found.`);
    if (item.state === "complete") return item;
    if (item.state === "interrupted") {
      throw new Error(`Download interrupted: ${item.error || "unknown error"}`);
    }
    await sleep(300);
  }
  throw new Error(`Download ${downloadId} did not complete in time.`);
}

async function saveTextFile(
  studyId,
  relativePath,
  text,
  mimeType = "text/plain;charset=utf-8",
  conflictAction = "overwrite"
) {
  let url = null;
  try {
    if (typeof URL !== "undefined" && URL.createObjectURL) {
      const blob = new Blob([text], { type: mimeType });
      url = URL.createObjectURL(blob);
    }
    if (!url) {
      const encoded = btoa(unescape(encodeURIComponent(text)));
      url = `data:${mimeType};base64,${encoded}`;
    }
    const expectedFilename = `ETHOS/${studyId}/${relativePath}`;
    queueExpectedFilename(expectedFilename, conflictAction);
    const id = await chrome.downloads.download({
      url,
      filename: expectedFilename,
      saveAs: false,
      conflictAction
    });
    const item = await waitForDownloadComplete(id);
    return makeRelativeFromAbsolute(item.filename, studyId) || relativePath;
  } finally {
    try {
      if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
    } catch (_) {
      // no-op
    }
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) {
    const expected = popExpectedFilename();
    if (expected) {
      suggest({
        filename: expected.filename,
        conflictAction: expected.conflictAction || "uniquify"
      });
      return;
    }
    suggest();
    return;
  }

  const runningJobs = Array.from(JOBS.values()).filter(
    (job) => job.status === "running" && job.awaitingDoc && job.studyId
  );

  let job = null;
  if (typeof item.tabId === "number" && item.tabId >= 0) {
    const byTab = JOBS.get(item.tabId);
    if (byTab && byTab.status === "running" && byTab.awaitingDoc && byTab.studyId) {
      job = byTab;
    }
  }
  if (!job && runningJobs.length === 1) {
    // Some ETHOS-triggered downloads report no/invalid tabId.
    job = runningJobs[0];
  }

  if (!job || !job.awaitingDoc || !job.studyId) {
    suggest();
    return;
  }

  const hintedExt = sanitizeExtension(job.awaitingDoc.extHint || "");
  let ext =
    sanitizeExtension(extractExtension(item.filename)) ||
    sanitizeExtension(extractExtension(item.finalUrl)) ||
    "";
  if ((!ext || ext === ".html" || ext === ".htm") && hintedExt) {
    ext = hintedExt;
  }
  if (!ext) ext = ".bin";
  const filename = `ETHOS/${job.studyId}/documents/${job.awaitingDoc.safeBase}${ext}`;
  suggest({ filename, conflictAction: "overwrite" });
});

async function detectStudyContext(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let host = "";
  try {
    host = new URL(tab.url || "").hostname.toLowerCase();
  } catch (_) {
    host = "";
  }
  const supportedHost = SUPPORTED_HOSTS.includes(host);
  if (!supportedHost) {
    return {
      supportedHost: false,
      isLikelyWorkspace: false,
      studyId: null,
      url: tab.url || ""
    };
  }

  const ctx = await runScript(tabId, () => {
    const bodyText = document.body ? document.body.innerText : "";
    const studyIdPattern = /\bSTU(?:[-\s]?\d){5,}\b/i;
    const idFromUrl = (location.href.match(studyIdPattern) || [])[0] || null;
    const idFromBody = (bodyText.match(studyIdPattern) || [])[0] || null;
    const docsLink = Array.from(document.querySelectorAll("a,button")).find((el) =>
      /documents/i.test((el.textContent || "").trim())
    );
    const smartFormHint = Array.from(document.querySelectorAll("a")).some((a) => {
      const text = (a.textContent || "").toLowerCase();
      const href = (a.getAttribute("href") || "").toLowerCase();
      return (
        text.includes("read-only view") || text.includes("smartform") || href.includes("/smartform")
      );
    });

    return {
      rawStudyId: idFromUrl || idFromBody || null,
      hasDocumentsLink: Boolean(docsLink),
      hasSmartFormHint: smartFormHint
    };
  });

  return {
    supportedHost: true,
    isLikelyWorkspace: Boolean(ctx?.hasDocumentsLink || ctx?.hasSmartFormHint),
    studyId: normalizeStudyId(ctx?.rawStudyId),
    url: tab.url || ""
  };
}

async function openSmartFormReadOnly(tabId) {
  return runScript(tabId, async () => {
    const linkNodes = Array.from(document.querySelectorAll("a"));
    const isVisible = (el) => !!(el && el.offsetParent !== null);
    const inSidebar = (el) =>
      !!el.closest(".sidebar, [class*='recent'], [class*='history'], nav, aside");

    function clickNode(node) {
      node.scrollIntoView({ block: "center", behavior: "instant" });
      node.click();
      return true;
    }

    for (const node of linkNodes) {
      const text = (node.textContent || "").trim();
      if (!/read-?only/i.test(text) || !/protocol/i.test(text)) continue;
      if (!isVisible(node) || inSidebar(node)) continue;
      clickNode(node);
      return { ok: true, method: "read-only-link" };
    }

    for (const node of linkNodes) {
      const href = (node.getAttribute("href") || "").toLowerCase();
      if (!href.includes("/smartform")) continue;
      if (!isVisible(node) || inSidebar(node)) continue;
      clickNode(node);
      return { ok: true, method: "smartform-href" };
    }

    for (const node of linkNodes) {
      const text = (node.textContent || "").trim();
      if (!/smart\s*form/i.test(text)) continue;
      if (!isVisible(node)) continue;
      clickNode(node);
      return { ok: true, method: "smartform-text" };
    }

    return { ok: false, error: "Could not find SmartForm read-only link." };
  });
}

async function findSmartFormFrame(tabId) {
  const results = await runScriptAllFrames(tabId, () => {
    const count = document.querySelectorAll(
      "a.smartFormSectionLink.smartFormLink, a.smartFormSectionLink"
    ).length;
    return {
      href: location.href,
      sectionCount: count,
      looksSmartForm: /smartform/i.test(location.href)
    };
  });

  if (!results || results.length === 0) return null;
  results.sort((a, b) => {
    const scoreA = (a.result.looksSmartForm ? 1000 : 0) + a.result.sectionCount;
    const scoreB = (b.result.looksSmartForm ? 1000 : 0) + b.result.sectionCount;
    return scoreB - scoreA;
  });
  const best = results[0];
  if (best.result.sectionCount <= 0 && !best.result.looksSmartForm) return null;
  return best.frameId;
}

async function listSmartFormSections(tabId, frameId) {
  return runScript(
    tabId,
    () => {
      const links = Array.from(
        document.querySelectorAll("a.smartFormSectionLink.smartFormLink, a.smartFormSectionLink")
      );
      return links.map((node, index) => {
        const label = (
          node.getAttribute("aria-label") ||
          node.getAttribute("title") ||
          node.textContent ||
          `Section ${index + 1}`
        ).trim();
        return { index, label };
      });
    },
    [],
    frameId
  );
}

async function resolveSmartFormPrintProjectUrl(tabId) {
  return runScript(tabId, () => {
    function extractOid(value) {
      const decoded = decodeURIComponent(String(value || ""));
      const match = decoded.match(/Project=com\.webridge\.entity\.Entity\[OID\[([^\]]+)\]\]/i);
      return match ? match[1] : "";
    }

    const editLink = Array.from(document.querySelectorAll("a")).find((anchor) => {
      const href = String(anchor.getAttribute("href") || "");
      const title = String(anchor.getAttribute("title") || "");
      return href.includes("/smartform/edit") || /edit the protocol/i.test(title);
    });
    const projectOid = extractOid(editLink?.getAttribute("href") || "");
    if (!projectOid) return { ok: false, error: "Could not resolve SmartForm project OID." };

    return {
      ok: true,
      url: `${location.origin}/ETHOS/app/portal/smartform/printProject/_IRBSubmission/${encodeURIComponent(
        projectOid
      )}?packetIds=defaultPrintPacket`
    };
  });
}

async function openSmartFormPrintProject(tabId) {
  const printInfo = await resolveSmartFormPrintProjectUrl(tabId);
  if (!printInfo?.ok) return printInfo;
  await chrome.tabs.update(tabId, { url: printInfo.url });
  await waitForTabComplete(tabId, 40000);
  const ready = await waitForPrintedSmartFormReady(tabId, 120000);
  if (!ready.ok) return ready;
  return { ok: true, method: "print-project", url: printInfo.url, ...ready };
}

async function waitForPrintedSmartFormReady(tabId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let firstRenderableAt = 0;
  let stableSince = 0;
  let lastSignature = "";
  let lastState = null;

  while (Date.now() < deadline) {
    const state = await runScript(tabId, () => {
      const normalizeText = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const sectionBlocks = Array.from(document.querySelectorAll("div#_webr_EntityView")).filter(
        (node) => !node.parentElement?.closest("div#_webr_EntityView")
      );
      const headings = sectionBlocks
        .map((node) => {
          const headingNodes = Array.from(
            node.querySelectorAll("h1, h2, h3, [role='heading'], strong, b, legend")
          );
          return (
            headingNodes
              .map((heading) => normalizeText(heading.textContent || ""))
              .find((heading) => /^\d+\.\d+(?!\.)\b/.test(heading)) || ""
          );
        })
        .filter(Boolean);
      const progressElement = document.querySelector("#printProgress, #printProgressBar");
      const progressText = normalizeText(progressElement?.textContent || "");
      const bodyText = document.body?.innerText || "";
      return {
        headingCount: headings.length,
        headings,
        hasProgressElement: Boolean(progressElement),
        progressText,
        readyState: document.readyState,
        sectionCount: sectionBlocks.length,
        viewLinkCount: Array.from(document.querySelectorAll("a")).filter((anchor) =>
          /^view$/i.test(normalizeText(anchor.textContent || ""))
        ).length,
        hasStudyId: /\bSTU(?:[-\s]?\d){5,}\b/i.test(bodyText)
      };
    });
    lastState = state;

    if (state?.sectionCount > 0 && state?.hasStudyId) {
      if (!firstRenderableAt) firstRenderableAt = Date.now();
      const signature = `${state.sectionCount}|${state.headingCount}|${state.viewLinkCount}|${state.headings.join(
        "|"
      )}`;
      if (signature === lastSignature) {
        if (!stableSince) stableSince = Date.now();
      } else {
        lastSignature = signature;
        stableSince = 0;
      }

      const progressComplete = /(?:^|\D)100\s*%/i.test(state.progressText);
      const progressUnavailable = !state.hasProgressElement || !state.progressText;
      const renderMs = Date.now() - firstRenderableAt;
      const stableMs = stableSince ? Date.now() - stableSince : 0;

      if (
        state.headingCount > 0 &&
        state.readyState === "complete" &&
        renderMs >= 4000 &&
        stableMs >= 2500 &&
        (progressComplete || (progressUnavailable && stableMs >= 6000))
      ) {
        return {
          ok: true,
          sectionCount: state.sectionCount,
          headingCount: state.headingCount,
          viewLinkCount: state.viewLinkCount,
          progressText: state.progressText,
          progressIncomplete: !progressComplete && progressUnavailable
        };
      }
    }
    await sleep(500);
  }

  if (lastState?.headingCount > 0 && stableSince && Date.now() - stableSince >= 15000) {
    return {
      ok: true,
      sectionCount: lastState.sectionCount,
      headingCount: lastState.headingCount,
      viewLinkCount: lastState.viewLinkCount,
      progressText: lastState.progressText,
      progressIncomplete: true
    };
  }

  return {
    ok: false,
    error: `Timed out waiting for SmartForm print view to finish rendering sections. Last state: ${JSON.stringify(
      lastState || {}
    )}`
  };
}

async function capturePrintedSmartForm(tabId) {
  return runScript(tabId, () => {
    function normalizeText(value) {
      return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function sectionPrefix(value) {
      const match = String(value || "").match(/^\s*(\d+\.\d+)(?!\.)\b/);
      return match ? match[1] : "";
    }

    function headingText(root) {
      const headingNodes = Array.from(
        root.querySelectorAll("h1, h2, h3, [role='heading'], strong, b, legend")
      );
      const heading =
        headingNodes.find((node) => /^\s*\d+\.\d+(?!\.)\b/.test(node.textContent || "")) ||
        headingNodes[0];
      return normalizeText(heading?.textContent || "");
    }

    function serializePrintSection(rootElement, title) {
      const clone = rootElement.cloneNode(true);
      const removeSelectors = [
        "script",
        "style",
        "noscript",
        "input[type='hidden']",
        ".ALDForPrint",
        ".Hidden",
        "#fileProgressDiv",
        "#documentFormHolder",
        "#PortalToolsData"
      ];
      clone.querySelectorAll(removeSelectors.join(",")).forEach((node) => node.remove());
      clone.querySelectorAll("table").forEach((table) => {
        const headerText = normalizeText(
          Array.from(table.querySelectorAll("th, .DisplayHead, .ViewSetTableHeader"))
            .map((cell) => cell.textContent || "")
            .join(" ")
        );
        if (
          /\b(accountdisabled|cachedpermissionlists|encryptedpassword|passwordsalt|passwordmustchange|projectworkingset)\b/i.test(
            headerText
          )
        ) {
          table.remove();
        }
      });
      clone.querySelectorAll("*").forEach((node) => {
        const style = String(node.getAttribute("style") || "")
          .toLowerCase()
          .replace(/\s+/g, "");
        if (
          style.includes("display:none") ||
          style.includes("visibility:hidden") ||
          node.getAttribute("aria-hidden") === "true" ||
          node.hasAttribute("hidden")
        ) {
          node.remove();
        }
      });
      clone.querySelectorAll("a").forEach((anchor) => {
        anchor.setAttribute("href", anchor.href || "#");
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
      });

      return [
        "<!doctype html>",
        "<html>",
        "<head>",
        "<meta charset='utf-8' />",
        `<title>${String(title || "").replace(/</g, "&lt;")}</title>`,
        "<style>body{margin:16px;font-family:Segoe UI,Tahoma,sans-serif;background:#fff;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px;vertical-align:top}a{color:#004c7d}</style>",
        "</head>",
        "<body>",
        clone.outerHTML,
        "</body>",
        "</html>"
      ].join("");
    }

    function quotedArgs(value) {
      return [...String(value || "").matchAll(/'([^']*)'/g)].map((match) => match[1]);
    }

    function resolveReadonlyViewUrl(anchor) {
      const args = quotedArgs(anchor.getAttribute("onclick") || "");
      if (args.length < 6 || !/showReadOnlyCustomDataForm/i.test(anchor.getAttribute("onclick")))
        return null;

      const [itemOID, entityview, rootEntity, rootViewId, cdtDerefPath, qualifiedAttributeName] = [
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5]
      ];
      const params = new URLSearchParams({
        readonly: "1",
        itemOID,
        entityview,
        rootEntity,
        qualifiedAttributeName,
        showReviewerNotes: "false",
        isIframe: "false",
        rootViewId,
        cdtDerefPath
      });
      return `${location.origin}/ETHOS/sd/CommonAdministration/Choosers/Entity/CustomDataType/DataEntry/Form?${params.toString()}`;
    }

    const sectionBlocks = Array.from(document.querySelectorAll("div#_webr_EntityView")).filter(
      (node) => {
        if (node.parentElement?.closest("div#_webr_EntityView")) return false;
        const heading = headingText(node);
        const prefix = sectionPrefix(heading);
        const text = normalizeText(node.textContent || "");
        return Boolean(prefix && text.length > 20);
      }
    );

    const seenPrefixes = new Set();
    const sections = [];
    for (const node of sectionBlocks) {
      const label = headingText(node);
      const prefix = sectionPrefix(label);
      if (!prefix || seenPrefixes.has(prefix)) continue;
      seenPrefixes.add(prefix);

      const viewLinks = Array.from(node.querySelectorAll("a")).filter(
        (anchor) =>
          /^view$/i.test(normalizeText(anchor.textContent || "")) && resolveReadonlyViewUrl(anchor)
      );
      const views = viewLinks.map((anchor, index) => ({
        index: index + 1,
        method: "print-readonly-url",
        url: resolveReadonlyViewUrl(anchor),
        html: "",
        error: null
      }));

      sections.push({
        ok: true,
        label,
        html: serializePrintSection(node, label),
        views,
        selectorStats: {
          source: "printProject",
          heading: label,
          viewLinkCount: views.length,
          sectionNavCount: sectionBlocks.length,
          containerMatchedLabel: true
        }
      });
    }

    return {
      ok: sections.length > 0,
      sectionCount: sections.length,
      sections,
      error: sections.length ? "" : "No printable SmartForm section blocks found."
    };
  });
}

async function captureSectionSnapshot(tabId, frameId, sectionIndex) {
  return runScript(
    tabId,
    async (idx) => {
      function sleepInner(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function asAbsolute(url) {
        try {
          return new URL(url, location.href).toString();
        } catch (_) {
          return null;
        }
      }

      function resolveViewUrl(anchor) {
        const href = anchor.getAttribute("href") || "";
        if (href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
          return asAbsolute(href);
        }
        const onclick = anchor.getAttribute("onclick") || "";
        const quoted = onclick.match(/'([^']+)'/g) || [];
        for (const token of quoted) {
          const value = token.slice(1, -1);
          if (/dataentry\/form|readonly|customdataform/i.test(value)) {
            return asAbsolute(value);
          }
        }
        return null;
      }

      function serializeStandaloneHtml(rootElement, title) {
        const sourceNodes = [rootElement, ...rootElement.querySelectorAll("*")];
        let clone = rootElement.cloneNode(true);
        const clonedNodes = [clone, ...clone.querySelectorAll("*")];
        const cssProps = [
          "display",
          "position",
          "top",
          "right",
          "bottom",
          "left",
          "float",
          "clear",
          "width",
          "height",
          "max-width",
          "min-width",
          "max-height",
          "min-height",
          "margin",
          "padding",
          "border",
          "border-radius",
          "background",
          "background-color",
          "color",
          "font",
          "font-size",
          "font-weight",
          "line-height",
          "text-align",
          "white-space",
          "overflow",
          "overflow-x",
          "overflow-y",
          "vertical-align",
          "table-layout"
        ];

        for (let i = 0; i < sourceNodes.length && i < clonedNodes.length; i++) {
          const src = sourceNodes[i];
          const dst = clonedNodes[i];
          if (
            !src ||
            !dst ||
            src.nodeType !== Node.ELEMENT_NODE ||
            dst.nodeType !== Node.ELEMENT_NODE
          )
            continue;
          const style = getComputedStyle(src);
          const srcTag = String(src.tagName || "").toUpperCase();
          const hasLayout =
            typeof src.getClientRects === "function" ? src.getClientRects().length > 0 : true;
          const nonLayoutAllowed = new Set([
            "BR",
            "HR",
            "TD",
            "TH",
            "TR",
            "TBODY",
            "THEAD",
            "TFOOT",
            "LABEL",
            "SPAN",
            "A",
            "B",
            "I",
            "STRONG",
            "EM"
          ]);
          const srcText = (src.textContent || "").trim();
          const isStyleHidden =
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity || "1") === 0;
          const isNoLayoutShell =
            !hasLayout && !nonLayoutAllowed.has(srcTag) && srcText.length === 0;
          const isDialogChrome = Boolean(
            src.closest(
              ".DialogButtonBar, .ui-dialog-titlebar, #navigation, #btnOkReadOnly, #fileProgressDiv, #documentFormHolder, #PortalToolsData, .BtnRNPageComments, .BtnRNFieldComments, [class*='ReviewerNotes'], [class*='BtnRN']"
            )
          );
          if (isStyleHidden || isNoLayoutShell || isDialogChrome) {
            dst.setAttribute("data-export-remove", "1");
            continue;
          }

          const inline = cssProps
            .map((prop) => `${prop}:${style.getPropertyValue(prop)};`)
            .join("");
          dst.setAttribute("style", inline);
          if (dst.tagName === "A") {
            dst.setAttribute("href", src.href || "#");
            dst.setAttribute("target", "_blank");
            dst.setAttribute("rel", "noopener noreferrer");
          }
          if (dst.tagName === "IMG" && src.currentSrc) {
            dst.setAttribute("src", src.currentSrc);
          }
          if (dst.tagName === "TEXTAREA") {
            dst.textContent = src.value || src.textContent || "";
          }
          if (dst.tagName === "INPUT") {
            const type = String(src.getAttribute("type") || "").toLowerCase();
            if (type === "checkbox" || type === "radio") {
              if (src.checked) dst.setAttribute("checked", "checked");
              else dst.removeAttribute("checked");
            } else if (src.value) {
              dst.setAttribute("value", src.value);
            }
          }
          if (dst.tagName === "SELECT") {
            const sourceOptions = Array.from(src.options || []);
            Array.from(dst.options || []).forEach((option) => option.removeAttribute("selected"));
            Array.from(src.selectedOptions || []).forEach((option) => {
              const index = sourceOptions.indexOf(option);
              if (index >= 0 && dst.options[index]) {
                dst.options[index].setAttribute("selected", "selected");
              }
            });
          }
        }

        const removeSelectors = [
          "script",
          "style",
          "noscript",
          "input[type='hidden']",
          ".ALDForPrint",
          ".Hidden",
          ".DialogButtonBar",
          ".ui-dialog-titlebar",
          "#navigation",
          "#btnOkReadOnly",
          "#fileProgressDiv",
          "#documentFormHolder",
          "#PortalToolsData",
          ".BtnRNPageComments",
          ".BtnRNFieldComments",
          "[class*='ReviewerNotes']",
          "[class*='BtnRN']",
          "[title^='Open reviewer notes']",
          "[aria-label^='Open reviewer notes']",
          "[role='button'][data-projectid][data-projecttype]"
        ];
        clone.querySelectorAll(removeSelectors.join(",")).forEach((node) => node.remove());
        clone.querySelectorAll("[data-export-remove='1']").forEach((node) => node.remove());
        clone.querySelectorAll("table").forEach((table) => {
          const headerText = normalizeText(
            Array.from(table.querySelectorAll("th, .DisplayHead, .ViewSetTableHeader"))
              .map((cell) => cell.textContent || "")
              .join(" ")
          );
          if (
            /\b(accountdisabled|cachedpermissionlists|encryptedpassword|passwordsalt|passwordmustchange|projectworkingset)\b/i.test(
              headerText
            )
          ) {
            table.remove();
          }
        });

        clone.querySelectorAll("*").forEach((node) => {
          const style = String(node.getAttribute("style") || "").toLowerCase();
          if (
            style.includes("display:none") ||
            style.includes("visibility:hidden") ||
            node.getAttribute("aria-hidden") === "true" ||
            node.hasAttribute("hidden")
          ) {
            node.remove();
            return;
          }
          if (style.includes("position:fixed") || style.includes("position:sticky")) {
            node.remove();
            return;
          }
          const tag = String(node.tagName || "").toUpperCase();
          const text = (node.textContent || node.getAttribute("value") || "").trim();
          const title = String(node.getAttribute("title") || "");
          const aria = String(node.getAttribute("aria-label") || "");
          const className = String(node.getAttribute("class") || "");
          if (
            /reviewer\s*notes/i.test(`${text} ${title} ${aria}`) ||
            /\bBtnRN|ReviewerNotes|Icon-ReviewerNotes/i.test(className)
          ) {
            node.remove();
            return;
          }
          if (tag === "BUTTON" || tag === "INPUT") {
            const type = String(node.getAttribute("type") || "").toLowerCase();
            if (
              (type === "button" || type === "submit" || tag === "BUTTON") &&
              /^(ok|close|print|help|finish|save|submit|continue|back|exit)$/i.test(text)
            ) {
              node.remove();
            }
          }
        });

        if (clone.tagName === "BODY") {
          const bodyContent = document.createElement("div");
          while (clone.firstChild) {
            bodyContent.appendChild(clone.firstChild);
          }
          clone = bodyContent;
        }

        return [
          "<!doctype html>",
          "<html>",
          "<head>",
          "<meta charset='utf-8' />",
          `<title>${String(title || "").replace(/</g, "&lt;")}</title>`,
          "<style>body{margin:16px;font-family:Segoe UI,Tahoma,sans-serif;background:#fff;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px;vertical-align:top}a{color:#004c7d}</style>",
          "</head>",
          "<body>",
          clone.outerHTML,
          "</body>",
          "</html>"
        ].join("");
      }

      function normalizeText(value) {
        return String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      }

      function sectionPrefix(value) {
        const match = String(value || "").match(/^\s*(\d+(?:\.\d+)*)\b/);
        return match ? match[1] : "";
      }

      function headingText(root) {
        if (!root) return "";
        const headingNodes = Array.from(
          root.querySelectorAll("h1, h2, h3, [role='heading'], strong, b, legend")
        );
        const heading =
          headingNodes.find((node) => /^\s*\d+(?:\.\d+)*/.test(node.textContent || "")) ||
          headingNodes[0];
        return (heading?.textContent || "").trim();
      }

      function sectionMatchesLabel(root, label) {
        const expectedPrefix = sectionPrefix(label);
        const heading = headingText(root);
        if (expectedPrefix && sectionPrefix(heading) === expectedPrefix) return true;
        const normalizedLabel = normalizeText(label);
        const normalizedHeading = normalizeText(heading);
        if (normalizedLabel && normalizedHeading.includes(normalizedLabel)) return true;
        if (heading) return false;
        if (expectedPrefix) {
          const rootText = normalizeText(root?.textContent || "").slice(0, 500);
          return rootText.startsWith(`${expectedPrefix} `);
        }
        return Boolean(normalizedHeading || normalizeText(root?.textContent || ""));
      }

      function resolveSectionContainer(link, label) {
        const candidates = [];
        const addCandidate = (node) => {
          if (node && !candidates.includes(node)) candidates.push(node);
        };

        const viewId = link.getAttribute("data-viewid");
        if (viewId) addCandidate(document.getElementById(viewId));

        const ariaControls = link.getAttribute("aria-controls");
        if (ariaControls) addCandidate(document.getElementById(ariaControls));

        const href = link.getAttribute("href") || "";
        if (href.includes("#")) {
          const targetId = href.split("#").pop();
          if (targetId) addCandidate(document.getElementById(targetId));
        }

        const contentSelectors = [
          "._webr_EntityViewWrapper",
          "#_webr_EntityView",
          ".SmartFormViewAreaContainer",
          ".SmartFormViewArea",
          "[role='main']",
          "main"
        ];
        for (const selector of contentSelectors) {
          document.querySelectorAll(selector).forEach((node) => addCandidate(node));
        }

        const visibleCandidates = candidates.filter((node) => {
          if (!node || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true")
            return false;
          const style = window.getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const text = (node.textContent || "").trim();
          return text.length > 40;
        });

        return (
          visibleCandidates.find((node) => sectionMatchesLabel(node, label)) ||
          visibleCandidates.sort((a, b) => b.textContent.length - a.textContent.length)[0] ||
          null
        );
      }

      async function waitForSectionContainer(link, label, maxWaitMs = 10000) {
        const started = Date.now();
        let lastContainer = null;
        while (Date.now() - started < maxWaitMs) {
          const container = resolveSectionContainer(link, label);
          if (container) {
            lastContainer = container;
            if (sectionMatchesLabel(container, label)) return { container, matched: true };
          }
          await sleepInner(200);
        }
        return { container: lastContainer, matched: false };
      }

      async function closeDialogIfPresent() {
        const selectors = [
          "button[aria-label='Close']",
          ".ui-dialog-titlebar-close",
          "[role='dialog'] button",
          ".DialogOverlay button"
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) {
            btn.click();
            await sleepInner(150);
            return true;
          }
        }
        return false;
      }

      async function captureViewFromClick(anchor, label, viewIndex) {
        async function findDialogIframe(maxWaitMs = 6000) {
          const started = Date.now();
          while (Date.now() - started < maxWaitMs) {
            let iframeCandidate =
              document.querySelector("iframe[name='dialogIframe']") ||
              document.querySelector("iframe[id*='dialogIframe']") ||
              document.querySelector("iframe[src*='DataEntry/Form']");
            let docRef = document;

            if (!iframeCandidate) {
              try {
                if (window.parent && window.parent.document) {
                  iframeCandidate =
                    window.parent.document.querySelector("iframe[name='dialogIframe']") ||
                    window.parent.document.querySelector("iframe[id*='dialogIframe']") ||
                    window.parent.document.querySelector("iframe[src*='DataEntry/Form']");
                  if (iframeCandidate) docRef = window.parent.document;
                }
              } catch (_) {
                // cross-origin parent access can fail
              }
            }

            if (iframeCandidate) {
              return { iframe: iframeCandidate, parentDoc: docRef };
            }
            await sleepInner(150);
          }
          return { iframe: null, parentDoc: document };
        }

        async function extractViewHtmlFromIframe(iframeNode, title, idx, maxWaitMs = 10000) {
          const started = Date.now();
          while (Date.now() - started < maxWaitMs) {
            try {
              const iframeDoc = iframeNode.contentDocument;
              const body = iframeDoc?.body;
              if (!body) {
                await sleepInner(200);
                continue;
              }

              const textLength = (body.innerText || "").replace(/\s+/g, "").length;
              const elementCount = body.querySelectorAll("*").length;
              const hasSemanticElements = Boolean(
                body.querySelector("form, table, .formBody, .EntityViewForm, [id*='EntityView']")
              );
              const hasMeaningfulContent =
                textLength > 80 || (hasSemanticElements && elementCount > 20);

              if (hasMeaningfulContent) {
                return serializeStandaloneHtml(body, `${title} - View ${idx}`);
              }
            } catch (_) {
              // iframe document may be unavailable while loading
            }
            await sleepInner(200);
          }
          return "";
        }

        try {
          anchor.scrollIntoView({ block: "center", behavior: "instant" });
          anchor.click();
          await sleepInner(1200);

          const iframeInfo = await findDialogIframe(6000);
          const iframe = iframeInfo.iframe;
          const parentDoc = iframeInfo.parentDoc;

          let url = null;
          let html = "";
          let method = "click";

          if (iframe) {
            const src = iframe.getAttribute("src") || "";
            url = asAbsolute(src);
            html = await extractViewHtmlFromIframe(iframe, label, viewIndex, 10000);
            if (html) {
              method = "iframe-content";
            } else {
              method = "iframe-empty";
            }
          }

          if (!html) {
            const directUrl = resolveViewUrl(anchor);
            if (directUrl) {
              url = directUrl;
              method =
                method === "iframe-empty" ? "url-fallback-after-empty-iframe" : "url-fallback";
            }
          }

          try {
            if (parentDoc !== document) {
              const closeBtn =
                parentDoc.querySelector("button[aria-label='Close']") ||
                parentDoc.querySelector(".ui-dialog-titlebar-close");
              if (closeBtn) closeBtn.click();
            } else {
              await closeDialogIfPresent();
            }
          } catch (_) {
            // no-op
          }

          return {
            ok: Boolean(html || url),
            html,
            url,
            method,
            error: html || url ? null : "View click did not expose iframe content or URL."
          };
        } catch (err) {
          return {
            ok: false,
            html: "",
            url: null,
            method: "error",
            error: err?.message || String(err)
          };
        }
      }

      const links = Array.from(
        document.querySelectorAll("a.smartFormSectionLink.smartFormLink, a.smartFormSectionLink")
      );
      const link = links[idx];
      if (!link) return { ok: false, error: `Section index ${idx} not found.` };

      const label = (
        link.getAttribute("aria-label") ||
        link.getAttribute("title") ||
        link.textContent ||
        `Section ${idx + 1}`
      ).trim();
      link.scrollIntoView({ block: "center", behavior: "instant" });
      link.click();
      await sleepInner(250);

      const ready = await waitForSectionContainer(link, label);
      let container = ready.container;
      if (!container || !ready.matched) {
        return {
          ok: false,
          error: `Timed out waiting for section "${label}" to become active. Current heading: "${headingText(container)}".`
        };
      }

      const viewLinks = Array.from(container.querySelectorAll("a")).filter((a) =>
        /\bview\b/i.test((a.textContent || "").trim())
      );
      const views = [];
      for (let viewIndex = 0; viewIndex < viewLinks.length; viewIndex++) {
        const anchor = viewLinks[viewIndex];
        const result = await captureViewFromClick(anchor, label, viewIndex + 1);
        views.push({
          index: viewIndex + 1,
          method: result.method,
          url: result.url || null,
          html: result.html || "",
          error: result.error || null
        });
      }

      const html = serializeStandaloneHtml(container, label);
      return {
        ok: true,
        label,
        html,
        views,
        selectorStats: {
          sectionNavCount: links.length,
          viewLinkCount: viewLinks.length,
          heading: headingText(container),
          containerMatchedLabel: ready.matched
        }
      };
    },
    [sectionIndex],
    frameId
  );
}

async function fetchViewHtml(tabId, frameId, url) {
  return runScript(
    tabId,
    async (targetUrl) => {
      try {
        function pruneDocument(doc) {
          const removeSelectors = [
            "script",
            "style",
            "noscript",
            "input[type='hidden']",
            ".ALDForPrint",
            ".Hidden",
            ".DialogButtonBar",
            ".ui-dialog-titlebar",
            "#navigation",
            "#btnOkReadOnly",
            "#fileProgressDiv",
            "#documentFormHolder",
            "#PortalToolsData",
            ".BtnRNPageComments",
            ".BtnRNFieldComments",
            "[class*='ReviewerNotes']",
            "[class*='BtnRN']",
            "[title^='Open reviewer notes']",
            "[aria-label^='Open reviewer notes']",
            "[role='button'][data-projectid][data-projecttype]"
          ];
          doc.querySelectorAll(removeSelectors.join(",")).forEach((node) => node.remove());
          doc.querySelectorAll("table").forEach((table) => {
            const headerText = String(
              Array.from(table.querySelectorAll("th, .DisplayHead, .ViewSetTableHeader"))
                .map((cell) => cell.textContent || "")
                .join(" ")
            )
              .replace(/\u00a0/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            if (
              /\b(accountdisabled|cachedpermissionlists|encryptedpassword|passwordsalt|passwordmustchange|projectworkingset)\b/i.test(
                headerText
              )
            ) {
              table.remove();
            }
          });
          doc.querySelectorAll("*").forEach((node) => {
            const style = String(node.getAttribute("style") || "").toLowerCase();
            if (
              style.includes("display:none") ||
              style.includes("visibility:hidden") ||
              node.getAttribute("aria-hidden") === "true" ||
              node.hasAttribute("hidden")
            ) {
              node.remove();
              return;
            }
            if (style.includes("position:fixed") || style.includes("position:sticky")) {
              node.remove();
              return;
            }
            const tag = String(node.tagName || "").toUpperCase();
            const text = (node.textContent || node.getAttribute("value") || "").trim();
            const title = String(node.getAttribute("title") || "");
            const aria = String(node.getAttribute("aria-label") || "");
            const className = String(node.getAttribute("class") || "");
            if (
              /reviewer\s*notes/i.test(`${text} ${title} ${aria}`) ||
              /\bBtnRN|ReviewerNotes|Icon-ReviewerNotes/i.test(className)
            ) {
              node.remove();
              return;
            }
            if (tag === "BUTTON" || tag === "INPUT") {
              const type = String(node.getAttribute("type") || "").toLowerCase();
              if (
                (type === "button" || type === "submit" || tag === "BUTTON") &&
                /^(ok|close|print|help|finish|save|submit|continue|back|exit)$/i.test(text)
              ) {
                node.remove();
              }
            }
          });
        }

        const res = await fetch(targetUrl, { credentials: "include" });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const text = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, "text/html");
        pruneDocument(doc);
        const body = doc.body || doc.documentElement;
        const textLength = (body?.innerText || "").replace(/\s+/g, "").length;
        const elementCount = body ? body.querySelectorAll("*").length : 0;
        const hasSemanticElements = Boolean(
          body?.querySelector("form, table, .formBody, .EntityViewForm, [id*='EntityView']")
        );
        const hasMeaningfulContent = textLength > 80 || (hasSemanticElements && elementCount > 20);
        if (!hasMeaningfulContent) {
          return { ok: false, error: "Fetched view HTML was empty/shell." };
        }
        return { ok: true, html: body.outerHTML || text };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    [url],
    frameId
  );
}

async function openDocumentsTab(tabId) {
  return runScript(tabId, async () => {
    const nodes = Array.from(document.querySelectorAll("a,button,[role='tab']"));
    const match = nodes.find((n) => /documents/i.test((n.textContent || "").trim()));
    if (!match) return { ok: false, error: "Documents tab/link not found." };
    match.scrollIntoView({ block: "center", behavior: "instant" });
    match.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { ok: true };
  });
}

async function findDocumentsFrame(tabId) {
  const results = await runScriptAllFrames(tabId, () => {
    const candidates = Array.from(
      document.querySelectorAll(
        "button, a, [role='button'], [role='menuitem'], [aria-label], [title]"
      )
    );
    const count = candidates.filter((n) => {
      const text = String(n.textContent || "").trim();
      const aria = String(n.getAttribute("aria-label") || "").trim();
      const title = String(n.getAttribute("title") || "").trim();
      return (
        /document options/i.test(text) ||
        /document options/i.test(aria) ||
        /document options/i.test(title)
      );
    }).length;
    return {
      href: location.href,
      count
    };
  });

  if (!results || !results.length) return null;
  results.sort((a, b) => (b.result.count || 0) - (a.result.count || 0));
  if ((results[0].result.count || 0) <= 0) return null;
  return results[0].frameId;
}

async function getDocumentsCount(tabId, frameId = null) {
  return runScript(
    tabId,
    () => {
      const buttons = Array.from(
        document.querySelectorAll(
          "button, a, [role='button'], [role='menuitem'], [aria-label], [title]"
        )
      ).filter((n) => {
        const text = String(n.textContent || "").trim();
        const aria = String(n.getAttribute("aria-label") || "").trim();
        const title = String(n.getAttribute("title") || "").trim();
        return (
          /document options/i.test(text) ||
          /document options/i.test(aria) ||
          /document options/i.test(title)
        );
      });
      return { count: buttons.length };
    },
    [],
    frameId
  );
}

async function waitForDocumentsCountStable(tabId, frameId = null, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastInfo = { count: 0 };
  let lastCount = -1;

  while (Date.now() < deadline) {
    const info = (await getDocumentsCount(tabId, frameId)) || { count: 0 };
    const count = info.count || 0;
    lastInfo = info;

    if (count > 0 && count === lastCount) {
      return { ...info, stable: true };
    }

    lastCount = count;
    await sleep(1000);
  }

  return { ...lastInfo, stable: false };
}

async function getDocumentRowInfo(tabId, index, frameId = null) {
  return runScript(
    tabId,
    (idx) => {
      function parseDocInfo(value) {
        const raw = String(value || "");
        const head = raw.split("(")[0].trim() || "document";
        const extMatch = raw.match(/\.([A-Za-z0-9]{2,8})\s*(?:\(|$)/);
        const extHint = extMatch ? `.${extMatch[1].toLowerCase()}` : "";
        const cleanName = head.replace(/\.[A-Za-z0-9]{2,8}$/, "").trim() || head;
        return { cleanName, extHint };
      }

      const allButtons = Array.from(
        document.querySelectorAll(
          "button, a, [role='button'], [role='menuitem'], [aria-label], [title]"
        )
      ).filter((n) => {
        const text = String(n.textContent || "").trim();
        const aria = String(n.getAttribute("aria-label") || "").trim();
        const title = String(n.getAttribute("title") || "").trim();
        return (
          /document options/i.test(text) ||
          /document options/i.test(aria) ||
          /document options/i.test(title)
        );
      });
      const btn = allButtons[idx];
      if (!btn) return { ok: false, error: `Document Options #${idx + 1} not found.` };

      const row = btn.closest("tr");
      let docName = "document";
      let extHint = "";
      let rowLinkText = "";
      let rowLinkHref = "";

      if (row) {
        const links = Array.from(row.querySelectorAll("a")).filter((n) => {
          const text = (n.textContent || "").trim();
          const aria = String(n.getAttribute("aria-label") || "").trim();
          const title = String(n.getAttribute("title") || "").trim();
          const href = String(n.getAttribute("href") || "").trim();
          return (
            !/document options/i.test(text) &&
            !/document options/i.test(aria) &&
            !/document options/i.test(title) &&
            Boolean(text || href)
          );
        });
        const link = links[0] || null;
        if (link) {
          rowLinkText = (link.textContent || "").trim();
          rowLinkHref = String(link.getAttribute("href") || "").trim();
          const parsed = parseDocInfo(rowLinkText);
          docName = parsed.cleanName;
          extHint = parsed.extHint;
        }
        if (!docName || docName === "document") {
          const firstCell = row.querySelector("td");
          if (firstCell) {
            const parsed = parseDocInfo(firstCell.textContent || "");
            docName = parsed.cleanName;
            if (!extHint) extHint = parsed.extHint;
          }
        }
      }

      return {
        ok: true,
        docName,
        extHint,
        hasRowLink: Boolean(rowLinkText || rowLinkHref),
        rowLinkText,
        rowLinkHref
      };
    },
    [index],
    frameId
  );
}

async function clickDocumentRowLink(tabId, index, preferredName = "", frameId = null) {
  return runScript(
    tabId,
    (idx, preferredNameArg) => {
      function isVisibleNode(node) {
        if (!node) return false;
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true")
          return false;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const allButtons = Array.from(
        document.querySelectorAll(
          "button, a, [role='button'], [role='menuitem'], [aria-label], [title]"
        )
      ).filter((n) => {
        const text = String(n.textContent || "").trim();
        const aria = String(n.getAttribute("aria-label") || "").trim();
        const title = String(n.getAttribute("title") || "").trim();
        return (
          /document options/i.test(text) ||
          /document options/i.test(aria) ||
          /document options/i.test(title)
        );
      });
      const btn = allButtons[idx];
      if (!btn) return { ok: false, error: `Document Options #${idx + 1} not found.` };
      const row = btn.closest("tr");
      if (!row) return { ok: false, error: "Could not locate row for selected document option." };

      const preferred = String(preferredNameArg || "")
        .trim()
        .toLowerCase();
      const links = Array.from(row.querySelectorAll("a"))
        .filter((n) => isVisibleNode(n))
        .map((node) => {
          const text = (node.textContent || "").trim();
          const href = String(node.getAttribute("href") || "").trim();
          let score = 0;
          if (/document options/i.test(text)) score -= 100;
          if (preferred && text.toLowerCase().includes(preferred)) score += 4;
          if (href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:"))
            score += 2;
          if (text) score += 1;
          return { node, text, href, score };
        })
        .filter((item) => item.score > -100);
      links.sort((a, b) => b.score - a.score);
      const pick = links[0] || null;
      if (!pick) return { ok: false, error: "No visible row document link found to click." };

      pick.node.scrollIntoView({ block: "center", behavior: "instant" });
      pick.node.click();
      return { ok: true, clickedLabel: pick.text, clickedHref: pick.href };
    },
    [index, preferredName],
    frameId
  );
}

async function openDocumentOptions(tabId, index, frameId = null) {
  return runScript(
    tabId,
    async (idx) => {
      function isVisibleNode(node) {
        if (!node) return false;
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true")
          return false;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function collectVisibleDownloadItems() {
        return Array.from(document.querySelectorAll("[role='menuitem'], a, button"))
          .filter((n) => isVisibleNode(n))
          .map((n) => ({ node: n, text: (n.textContent || "").trim() }))
          .filter((item) => /download/i.test(item.text));
      }

      function parseDocInfo(value) {
        const raw = String(value || "");
        const head = raw.split("(")[0].trim() || "document";
        const extMatch = raw.match(/\.([A-Za-z0-9]{2,8})\s*(?:\(|$)/);
        const extHint = extMatch ? `.${extMatch[1].toLowerCase()}` : "";
        const cleanName = head.replace(/\.[A-Za-z0-9]{2,8}$/, "").trim() || head;
        return { cleanName, extHint };
      }

      const allButtons = Array.from(
        document.querySelectorAll(
          "button, a, [role='button'], [role='menuitem'], [aria-label], [title]"
        )
      ).filter((n) => {
        const text = String(n.textContent || "").trim();
        const aria = String(n.getAttribute("aria-label") || "").trim();
        const title = String(n.getAttribute("title") || "").trim();
        return (
          /document options/i.test(text) ||
          /document options/i.test(aria) ||
          /document options/i.test(title)
        );
      });
      const btn = allButtons[idx];
      if (!btn) return { ok: false, error: `Document Options #${idx + 1} not found.` };

      const row = btn.closest("tr");
      let docName = "document";
      let extHint = "";
      if (row) {
        const link = row.querySelector("a");
        if (link) {
          const parsed = parseDocInfo(link.textContent || "");
          docName = parsed.cleanName;
          extHint = parsed.extHint;
        }
        if (!docName || docName === "document") {
          const firstCell = row.querySelector("td");
          if (firstCell) {
            const parsed = parseDocInfo(firstCell.textContent || "");
            docName = parsed.cleanName;
            if (!extHint) extHint = parsed.extHint;
          }
        }
      }

      btn.scrollIntoView({ block: "center", behavior: "instant" });
      btn.click();
      let menuItems = collectVisibleDownloadItems();
      const deadline = Date.now() + 5000;
      while (!menuItems.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        menuItems = collectVisibleDownloadItems();
      }
      const hasCopy = menuItems.some((item) => /download copy/i.test(item.text));
      const hasPlain = menuItems.some((item) => /^download$/i.test(item.text));
      if (!menuItems.length) return { ok: false, error: "No download menu item found.", docName };
      return { ok: true, docName, extHint, hasCopy, hasPlain };
    },
    [index],
    frameId
  );
}

async function getDownloadMenuAction(tabId, preferCopy = true, frameId = null) {
  return runScript(
    tabId,
    (preferCopyArg) => {
      function isVisibleNode(node) {
        if (!node) return false;
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true")
          return false;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function asAbsolute(url) {
        try {
          return new URL(url, location.href).toString();
        } catch (_) {
          return null;
        }
      }

      function resolveUrlFromNode(node) {
        const href = (node.getAttribute("href") || "").trim();
        if (href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
          return asAbsolute(href);
        }

        const onclick = node.getAttribute("onclick") || "";
        const quoted = [...onclick.matchAll(/'([^']+)'|"([^"]+)"/g)]
          .map((m) => m[1] || m[2] || "")
          .filter(Boolean);

        const preferred = quoted.find((token) =>
          /download|document|file|dataentry|readonly|ethos/i.test(token)
        );
        if (preferred) return asAbsolute(preferred);

        const generic = quoted.find(
          (token) => /^https?:\/\//i.test(token) || token.startsWith("/")
        );
        if (generic) return asAbsolute(generic);

        return null;
      }

      const candidates = Array.from(document.querySelectorAll("[role='menuitem'], a, button"))
        .filter((n) => isVisibleNode(n))
        .map((n) => ({ node: n, text: (n.textContent || "").trim() }))
        .filter((item) => /download/i.test(item.text));
      if (!candidates.length) return { ok: false, error: "No download menu item found to click." };

      const copyItems = candidates.filter((item) => /download copy/i.test(item.text));
      const plainItems = candidates.filter((item) => /^download$/i.test(item.text));
      const anyDownloadItems = candidates.filter((item) => /download/i.test(item.text));
      const pickLast = (list) => (list.length ? list[list.length - 1] : null);

      const pick =
        (preferCopyArg ? pickLast(copyItems) : null) ||
        pickLast(plainItems) ||
        pickLast(copyItems) ||
        pickLast(anyDownloadItems);

      if (!pick) return { ok: false, error: "No suitable download item matched." };
      const resolvedUrl = resolveUrlFromNode(pick.node);
      return { ok: true, clickedLabel: pick.text, resolvedUrl };
    },
    [preferCopy],
    frameId
  );
}

async function clickDownloadMenuItem(tabId, preferCopy = true, frameId = null) {
  return runScript(
    tabId,
    (preferCopyArg) => {
      function isVisibleNode(node) {
        if (!node) return false;
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true")
          return false;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const candidates = Array.from(document.querySelectorAll("[role='menuitem'], a, button"))
        .filter((n) => isVisibleNode(n))
        .map((n) => ({ node: n, text: (n.textContent || "").trim() }))
        .filter((item) => /download/i.test(item.text));
      if (!candidates.length) return { ok: false, error: "No download menu item found to click." };

      const copyItems = candidates.filter((item) => /download copy/i.test(item.text));
      const plainItems = candidates.filter((item) => /^download$/i.test(item.text));
      const anyDownloadItems = candidates.filter((item) => /download/i.test(item.text));
      const pickLast = (list) => (list.length ? list[list.length - 1] : null);

      const pick =
        (preferCopyArg ? pickLast(copyItems) : null) ||
        pickLast(plainItems) ||
        pickLast(copyItems) ||
        pickLast(anyDownloadItems);

      if (!pick) return { ok: false, error: "No suitable download item matched." };
      pick.node.click();
      return { ok: true, clickedLabel: pick.text };
    },
    [preferCopy],
    frameId
  );
}

async function restoreDocumentsContext(job, tabId) {
  await chrome.tabs.update(tabId, { url: job.workspaceUrl });
  await waitForTabComplete(tabId, 40000);
  await sleep(800);
  const openDocs = await openDocumentsTab(tabId);
  if (!openDocs?.ok) throw new Error(openDocs?.error || "Failed to open Documents.");
  await sleep(1200);
  const docsFrameId = await findDocumentsFrame(tabId);
  if (docsFrameId == null) {
    logJob(job, "No separate documents frame found; using top frame.");
  } else {
    logJob(job, `Using documents frame ${docsFrameId}.`);
  }
  job.diagnostics.documents.frameId = docsFrameId;
  return docsFrameId;
}

async function writeSmartFormIndex(job) {
  const payload = {
    studyId: job.studyId,
    exportedAt: nowIso(),
    sections: job.smartformSections.map((s) => ({
      label: s.label,
      dir: s.dir,
      segmentPath: s.segmentPath,
      partCount: s.partCount
    }))
  };
  return saveTextFile(
    job.studyId,
    "smartform/index.json",
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8",
    "overwrite"
  );
}

async function writeManifest(job) {
  const payload = {
    schemaVersion: "1.2",
    studyId: job.studyId,
    exportedAt: nowIso(),
    extensionVersion: chrome.runtime.getManifest().version,
    source: {
      host: "ethos.swmed.edu",
      url: job.workspaceUrl
    },
    artifacts: {
      smartform: {
        indexPath: "smartform/index.json",
        sections: job.smartformSections.map((s) => ({
          label: s.label,
          dir: s.dir,
          segmentPath: s.segmentPath,
          partCount: s.partCount
        }))
      },
      documents: job.documents
    },
    diagnosticsPath: "export_diagnostics.json",
    warnings: job.warnings,
    errors: job.errors
  };
  return saveTextFile(
    job.studyId,
    "manifest.json",
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8",
    "overwrite"
  );
}

async function writeDiagnostics(job) {
  const payload = {
    ...job.diagnostics,
    studyId: job.studyId,
    completedAt: nowIso(),
    status: job.status,
    summary: {
      sectionCountCaptured: job.smartformSections.length,
      documentCountCaptured: job.documents.length,
      warningCount: job.warnings.length,
      errorCount: job.errors.length
    }
  };
  return saveTextFile(
    job.studyId,
    "export_diagnostics.json",
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8",
    "overwrite"
  );
}

async function persistSmartFormSnapshot(job, tabId, frameId, sectionNumber, snapshot) {
  const dir = sanitizeFilename(snapshot.label.replace(/\//g, " // "));
  const stitchedParts = [{ fileName: "segment.html", html: snapshot.html }];

  if (Array.isArray(snapshot.views) && snapshot.views.length) {
    for (let v = 0; v < snapshot.views.length; v++) {
      const view = snapshot.views[v];
      let viewHtml = view?.html || "";
      if (!viewHtml && view?.url) {
        const viewRes = await fetchViewHtml(tabId, frameId, view.url);
        if (viewRes?.ok) {
          viewHtml = viewRes.html;
        } else {
          const err = `View fetch failed for section "${snapshot.label}" (${view.url}): ${viewRes?.error || "unknown error"}`;
          warnJob(job, err);
        }
      }
      if (!viewHtml) {
        if (view?.error) warnJob(job, `View capture issue in "${snapshot.label}": ${view.error}`);
        continue;
      }
      stitchedParts.push({ fileName: `view${v + 1}.html`, html: viewHtml });
    }
  }

  const stitchedHtml = buildStitchedSectionHtml(snapshot.label, stitchedParts);
  const stitchedRel = await saveTextFile(
    job.studyId,
    `smartform/${dir}/segment.html`,
    stitchedHtml,
    "text/html;charset=utf-8"
  );
  const segmentPath = stitchedRel.startsWith("smartform/")
    ? stitchedRel.slice("smartform/".length)
    : `${dir}/segment.html`;

  job.smartformSections.push({
    label: snapshot.label,
    dir,
    segmentPath,
    partCount: stitchedParts.length
  });
  job.diagnostics.smartform.sectionReports.push({
    sectionNumber,
    label: snapshot.label,
    status: "captured",
    sectionDir: dir,
    segmentPath,
    partCountSaved: stitchedParts.length,
    viewCountDetected: Array.isArray(snapshot.views) ? snapshot.views.length : 0,
    viewCountIncluded: Math.max(0, stitchedParts.length - 1),
    selectorStats: snapshot.selectorStats || {}
  });
}

function checkSmartFormCompleteness(job, sections) {
  const expected = Array.isArray(sections) ? sections : [];
  const capturedLabels = new Set(job.smartformSections.map((section) => section.label));
  const missing = expected
    .map((section, index) => ({ index: index + 1, label: section.label }))
    .filter((section) => !capturedLabels.has(section.label));

  if (missing.length) {
    warnJob(
      job,
      `SmartForm captured ${job.smartformSections.length}/${expected.length} sections. Missing: ${missing
        .map((section) => `${section.index} ${section.label}`)
        .join("; ")}`
    );
  }

  const headingCounts = new Map();
  for (const report of job.diagnostics.smartform.sectionReports || []) {
    const heading = report?.selectorStats?.heading || "";
    if (!heading) continue;
    headingCounts.set(heading, (headingCounts.get(heading) || 0) + 1);
  }
  const duplicateHeadings = Array.from(headingCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([heading]) => heading);
  if (duplicateHeadings.length) {
    warnJob(job, `SmartForm captured duplicate section headings: ${duplicateHeadings.join("; ")}`);
  }
}

function checkDocumentCompleteness(job) {
  if (job.documentTotal > 0 && job.documents.length < job.documentTotal) {
    warnJob(
      job,
      `Documents captured ${job.documents.length}/${job.documentTotal}. Check export_diagnostics.json for failed document rows.`
    );
  }
}

async function runExport(tabId) {
  const job = createJob(tabId);
  let diagnosticsWritten = false;
  async function cancelAndPersist() {
    cancelJob(job);
    if (job.studyId) {
      try {
        await writeDiagnostics(job);
        diagnosticsWritten = true;
        logJob(job, "Wrote export_diagnostics.json");
      } catch (diagErr) {
        logJob(
          job,
          `WARN: Failed to write export_diagnostics.json: ${diagErr?.message || String(diagErr)}`
        );
      }
    }
  }
  try {
    job.step = "Detecting study workspace";
    logJob(job, "Checking ETHOS page context.");
    const ctx = await detectStudyContext(tabId);
    if (!ctx.supportedHost) throw new Error("Active tab is not on ethos.swmed.edu.");
    if (!ctx.isLikelyWorkspace)
      throw new Error("Active page does not look like a study workspace.");
    if (!ctx.studyId) throw new Error("Could not detect Study ID on this page.");

    job.studyId = ctx.studyId;
    job.workspaceUrl = ctx.url;
    job.diagnostics.context = {
      studyId: ctx.studyId,
      url: ctx.url,
      supportedHost: ctx.supportedHost,
      isLikelyWorkspace: ctx.isLikelyWorkspace
    };
    logJob(job, `Study detected: ${job.studyId}`);
    await writeDiagnostics(job);
    logJob(job, "Initialized export_diagnostics.json");

    if (job.cancelRequested) return cancelAndPersist();
    let sections = [];
    let usedPrintProject = false;
    job.step = "Opening SmartForm print view";
    const printOpenRes = await openSmartFormPrintProject(tabId);
    if (printOpenRes?.ok) {
      logJob(job, `SmartForm print view opened via ${printOpenRes.method}.`);
      job.diagnostics.smartform.printReadiness = {
        sectionBlockCount: printOpenRes.sectionCount,
        headingCount: printOpenRes.headingCount,
        viewLinkCount: printOpenRes.viewLinkCount,
        progressText: printOpenRes.progressText || "",
        progressIncomplete: Boolean(printOpenRes.progressIncomplete)
      };
      if (printOpenRes.progressIncomplete) {
        warnJob(
          job,
          "SmartForm print progress did not report 100%; captured after the section list stabilized."
        );
      }
      const printCapture = await capturePrintedSmartForm(tabId);
      if (
        printCapture?.ok &&
        Array.isArray(printCapture.sections) &&
        printCapture.sections.length
      ) {
        usedPrintProject = true;
        sections = printCapture.sections.map((section, index) => ({
          index,
          label: section.label
        }));
        job.sectionTotal = sections.length;
        job.diagnostics.smartform.frameId = null;
        job.diagnostics.smartform.sectionCountDetected = sections.length;
        job.diagnostics.smartform.captureSource = "printProject";
        logJob(job, `Found ${sections.length} printable SmartForm sections.`);

        for (let i = 0; i < printCapture.sections.length; i++) {
          if (job.cancelRequested) return cancelAndPersist();
          job.sectionIndex = i + 1;
          const snapshot = printCapture.sections[i];
          try {
            await persistSmartFormSnapshot(job, tabId, null, i + 1, snapshot);
            logJob(job, `Captured section ${i + 1}/${sections.length}: ${snapshot.label}`);
            await sleep(200);
          } catch (err) {
            const message = err?.message || String(err);
            job.errors.push(`Section ${i + 1} error: ${message}`);
            job.diagnostics.errors.push(`Section ${i + 1} error: ${message}`);
            job.diagnostics.smartform.sectionReports.push({
              sectionNumber: i + 1,
              label: snapshot?.label || `Section ${i + 1}`,
              status: "error",
              error: message,
              selectorStats: snapshot?.selectorStats || {}
            });
            warnJob(job, `Section ${i + 1} error: ${message}`);
          }
        }
      } else {
        warnJob(
          job,
          `SmartForm print capture unavailable: ${printCapture?.error || "unknown error"}`
        );
      }
    } else {
      warnJob(job, `SmartForm print view unavailable: ${printOpenRes?.error || "unknown error"}`);
    }

    if (!usedPrintProject) {
      if (job.cancelRequested) return cancelAndPersist();
      job.step = "Opening SmartForm read-only view";
      await chrome.tabs.update(tabId, { url: job.workspaceUrl });
      await waitForTabComplete(tabId, 40000);
      await sleep(800);
      const openRes = await openSmartFormReadOnly(tabId);
      if (!openRes?.ok) throw new Error(openRes?.error || "Failed to open SmartForm.");
      await waitForTabComplete(tabId, 40000);
      await sleep(1200);
      logJob(job, `SmartForm opened via ${openRes.method}.`);

      if (job.cancelRequested) return cancelAndPersist();
      job.step = "Capturing SmartForm sections";
      const frameId = await findSmartFormFrame(tabId);
      if (frameId == null) throw new Error("Could not locate SmartForm frame.");
      job.diagnostics.smartform.frameId = frameId;
      job.diagnostics.smartform.captureSource = "sectionNavigation";

      sections = (await listSmartFormSections(tabId, frameId)) || [];
      job.sectionTotal = sections.length;
      job.diagnostics.smartform.sectionCountDetected = sections.length;
      if (!sections.length) throw new Error("No SmartForm sections found.");
      logJob(job, `Found ${sections.length} sections.`);

      for (let i = 0; i < sections.length; i++) {
        if (job.cancelRequested) return cancelAndPersist();
        job.sectionIndex = i + 1;
        try {
          const snapshot = await captureSectionSnapshot(tabId, frameId, i);
          if (!snapshot?.ok) {
            const err = snapshot?.error || `Section ${i + 1} capture failed.`;
            job.errors.push(err);
            job.diagnostics.errors.push(err);
            job.diagnostics.smartform.sectionReports.push({
              sectionNumber: i + 1,
              label: sections[i]?.label || `Section ${i + 1}`,
              status: "failed",
              error: err,
              selectorStats: snapshot?.selectorStats || {}
            });
            warnJob(job, err);
            continue;
          }

          await persistSmartFormSnapshot(job, tabId, frameId, i + 1, snapshot);
          logJob(job, `Captured section ${i + 1}/${sections.length}: ${snapshot.label}`);
          await sleep(200);
        } catch (err) {
          const message = err?.message || String(err);
          job.errors.push(`Section ${i + 1} error: ${message}`);
          job.diagnostics.errors.push(`Section ${i + 1} error: ${message}`);
          job.diagnostics.smartform.sectionReports.push({
            sectionNumber: i + 1,
            label: sections[i]?.label || `Section ${i + 1}`,
            status: "error",
            error: message,
            selectorStats: {}
          });
          warnJob(job, `Section ${i + 1} error: ${message}`);
        }
      }
    }

    checkSmartFormCompleteness(job, sections);

    await writeSmartFormIndex(job);
    logJob(job, "Wrote smartform/index.json");

    if (job.cancelRequested) return cancelAndPersist();
    job.step = "Returning to workspace";
    await chrome.tabs.update(tabId, { url: job.workspaceUrl });
    await waitForTabComplete(tabId, 40000);
    await sleep(800);

    if (job.cancelRequested) return cancelAndPersist();
    job.step = "Downloading study documents";
    let docsFrameId = await restoreDocumentsContext(job, tabId);
    let docsInfo = await waitForDocumentsCountStable(tabId, docsFrameId, 10000);
    let documentCountRetryUsed = false;
    if ((docsInfo?.count || 0) === 0) {
      logJob(job, "No document rows detected on first count; reopening Documents tab.");
      documentCountRetryUsed = true;
      docsFrameId = await restoreDocumentsContext(job, tabId);
      docsInfo = await waitForDocumentsCountStable(tabId, docsFrameId, 10000);
    }
    job.documentTotal = docsInfo?.count || 0;
    job.diagnostics.documents.optionRowsDetected = job.documentTotal;
    job.diagnostics.documents.countStable = Boolean(docsInfo?.stable);
    job.diagnostics.documents.countRetryUsed = documentCountRetryUsed;
    logJob(job, `Found ${job.documentTotal} document option rows.`);
    if (job.documentTotal === 0) {
      warnJob(
        job,
        "No document rows detected after reopening Documents tab. Check ETHOS permissions/tab state or selector drift."
      );
    }

    const tryRowLinkFirst = false;
    for (let i = 0; i < job.documentTotal; i++) {
      if (job.cancelRequested) return cancelAndPersist();
      job.documentIndex = i + 1;
      let documentCaptured = false;
      for (let attempt = 1; attempt <= 2 && !documentCaptured; attempt++) {
        try {
          const prep = await getDocumentRowInfo(tabId, i, docsFrameId);
          if (!prep?.ok) {
            const err = prep?.error || `Failed to inspect document row #${i + 1}`;
            throw new Error(err);
          }

          const safeBase = sanitizeFilename(prep.docName || `document_${i + 1}`);
          const extHint = sanitizeExtension(prep.extHint || "");
          job.awaitingDoc = { displayName: prep.docName || `Document ${i + 1}`, safeBase, extHint };
          let completeItem = null;
          let primaryMethod = "";
          let fallbackUsed = false;
          let fallbackReason = "";
          let clickedRowLinkLabel = "";
          let clickedMenuLabel = "";
          let menuPrep = null;
          let menuAction = null;
          let linkOutcome = null;

          if (tryRowLinkFirst) {
            const linkSnapshot = await getWindowTabSnapshot(tabId);
            const linkClick = await clickDocumentRowLink(tabId, i, prep.docName, docsFrameId);
            if (!linkClick?.ok) {
              fallbackUsed = true;
              fallbackReason = "no_row_link";
              warnJob(
                job,
                `Row-link click unavailable for "${prep.docName}" (${linkClick?.error || "no row link"}); using menu fallback.`
              );
            } else {
              clickedRowLinkLabel = linkClick.clickedLabel || "";
              try {
                const createdFromLink = await waitForCreatedDownload(job, 15000);
                completeItem = await waitForDownloadComplete(createdFromLink.id, 120000);
                primaryMethod = "row_link";
              } catch (_) {
                fallbackUsed = true;
                linkOutcome = await detectLinkClickOutcome(tabId, linkSnapshot);
                if ((linkOutcome?.openedNewTabIds || []).length > 0) {
                  fallbackReason = "opened_new_tab";
                } else if (linkOutcome?.urlChanged) {
                  fallbackReason = "opened_preview";
                } else {
                  fallbackReason = "no_created_event";
                }
                warnJob(
                  job,
                  `Row-link download did not start for "${prep.docName}" (${fallbackReason}); using menu fallback.`
                );
                if ((linkOutcome?.openedNewTabIds || []).length > 0) {
                  try {
                    await chrome.tabs.remove(linkOutcome.openedNewTabIds);
                  } catch (closeErr) {
                    warnJob(
                      job,
                      `Could not close row-link opened tab(s): ${closeErr?.message || String(closeErr)}`
                    );
                  }
                }
                if (linkOutcome?.urlChanged || (linkOutcome?.openedNewTabIds || []).length > 0) {
                  docsFrameId = await restoreDocumentsContext(job, tabId);
                }
              }
            }
          }

          if (!completeItem) {
            menuPrep = await openDocumentOptions(tabId, i, docsFrameId);
            if (!menuPrep?.ok) {
              const err = menuPrep?.error || `Failed to prepare menu fallback for doc #${i + 1}`;
              job.awaitingDoc = null;
              throw new Error(err);
            }
            menuAction = await getDownloadMenuAction(tabId, true, docsFrameId);
            if (!menuAction?.ok) {
              const err =
                menuAction?.error || `Failed to resolve fallback download action for doc #${i + 1}`;
              job.awaitingDoc = null;
              throw new Error(err);
            }
            const downloadCreatedPromise = waitForCreatedDownload(job, 40000);
            let clickResult = null;
            try {
              clickResult = await clickDownloadMenuItem(tabId, true, docsFrameId);
            } catch (clickErr) {
              downloadCreatedPromise.catch(() => {});
              throw clickErr;
            }
            if (!clickResult?.ok) {
              const err = clickResult?.error || `Failed to click download for doc #${i + 1}`;
              downloadCreatedPromise.catch(() => {});
              job.awaitingDoc = null;
              throw new Error(err);
            }
            clickedMenuLabel = clickResult?.clickedLabel || menuAction?.clickedLabel || "";
            const created = await downloadCreatedPromise;
            completeItem = await waitForDownloadComplete(created.id, 120000);
            primaryMethod = "menu_click";
          }

          if (!completeItem) {
            throw new Error(`Document ${i + 1} completed with no download item.`);
          }

          const relativeDetected = makeRelativeFromAbsolute(completeItem.filename, job.studyId);
          const savedPath =
            relativeDetected || `documents/${safeBase}${extractExtension(completeItem.filename)}`;
          if (!relativeDetected) {
            warnJob(
              job,
              `Downloaded file path did not include ETHOS/${job.studyId} prefix: ${completeItem.filename}`
            );
          }
          const finalExt = sanitizeExtension(extractExtension(completeItem.filename));
          const mime = String(completeItem.mime || "").toLowerCase();
          const lookedLikeHtml =
            finalExt === ".html" || finalExt === ".htm" || mime.includes("text/html");
          if (lookedLikeHtml) {
            warnJob(
              job,
              `Document "${prep.docName}" downloaded as HTML (${completeItem.filename}). This usually indicates a failed file export in ETHOS.`
            );
          }
          job.documents.push({
            displayName: prep.docName || `Document ${i + 1}`,
            savedPath
          });
          job.diagnostics.documents.items.push({
            index: i + 1,
            displayName: prep.docName || `Document ${i + 1}`,
            extHint,
            primaryMethod,
            fallbackUsed,
            fallbackReason,
            clickedRowLinkLabel,
            clickedMenuLabel,
            menuHadDownloadCopy: Boolean(menuPrep?.hasCopy),
            menuHadPlainDownload: Boolean(menuPrep?.hasPlain),
            resolvedMenuUrlHost: menuAction?.resolvedUrl
              ? (() => {
                  try {
                    return new URL(menuAction.resolvedUrl).host;
                  } catch (_) {
                    return "";
                  }
                })()
              : "",
            savedPath,
            downloadId: completeItem.id || null,
            createdTabId: typeof completeItem.tabId === "number" ? completeItem.tabId : null,
            finalUrlHost: (() => {
              try {
                return new URL(completeItem.finalUrl || completeItem.url || "").host;
              } catch (_) {
                return "";
              }
            })(),
            linkOutcome: {
              urlChanged: Boolean(linkOutcome?.urlChanged),
              openedNewTabIds: linkOutcome?.openedNewTabIds || [],
              currentUrl: linkOutcome?.currentUrl || ""
            },
            finalFilename: completeItem.filename,
            mime,
            lookedLikeHtml
          });
          job.awaitingDoc = null;
          logJob(
            job,
            `Downloaded ${job.documentIndex}/${job.documentTotal}: ${prep.docName} (${primaryMethod})`
          );
          documentCaptured = true;
          await sleep(200);
        } catch (err) {
          const message = err?.message || String(err);
          job.awaitingDoc = null;
          if (attempt === 1) {
            logJob(
              job,
              `Document ${i + 1} error: ${message}; reopening Documents tab and retrying once.`
            );
            try {
              docsFrameId = await restoreDocumentsContext(job, tabId);
            } catch (restoreErr) {
              const restoreMessage = restoreErr?.message || String(restoreErr);
              const combined = `Document ${i + 1} error: ${message}; retry setup failed: ${restoreMessage}`;
              job.errors.push(combined);
              job.diagnostics.errors.push(combined);
              warnJob(job, combined);
              break;
            }
            await sleep(500);
            continue;
          }
          job.errors.push(`Document ${i + 1} error: ${message}`);
          job.diagnostics.errors.push(`Document ${i + 1} error: ${message}`);
          warnJob(job, `Document ${i + 1} error: ${message}`);
        }
      }
    }

    if (job.cancelRequested) return cancelAndPersist();
    checkDocumentCompleteness(job);
    job.step = "Writing manifest";
    await writeManifest(job);
    logJob(job, "Wrote manifest.json");
    completeJob(job);
    await writeDiagnostics(job);
    diagnosticsWritten = true;
    logJob(job, "Wrote export_diagnostics.json");
  } catch (err) {
    failJob(job, err);
    if (job.studyId && !diagnosticsWritten) {
      try {
        await writeDiagnostics(job);
        logJob(job, "Wrote export_diagnostics.json");
      } catch (diagErr) {
        logJob(
          job,
          `WARN: Failed to write export_diagnostics.json: ${diagErr?.message || String(diagErr)}`
        );
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "detectStudyContext") {
        const context = await detectStudyContext(message.tabId);
        sendResponse({ ok: true, context });
        return;
      }

      if (message.type === "startExport") {
        const existing = JOBS.get(message.tabId);
        if (existing && existing.status === "running") {
          sendResponse({ ok: true, jobId: existing.id });
          return;
        }
        runExport(message.tabId);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "getJobStatus") {
        const job = JOBS.get(message.tabId) || null;
        if (!job) {
          sendResponse({ ok: true, job: null });
          return;
        }
        sendResponse({
          ok: true,
          job: {
            id: job.id,
            status: job.status,
            step: job.step,
            studyId: job.studyId,
            sectionIndex: job.sectionIndex,
            sectionTotal: job.sectionTotal,
            documentIndex: job.documentIndex,
            documentTotal: job.documentTotal,
            warningCount: job.warnings.length,
            errorCount: job.errors.length,
            logs: job.logs
          }
        });
        return;
      }

      if (message.type === "cancelExport") {
        const job = JOBS.get(message.tabId);
        if (job && job.status === "running") {
          job.cancelRequested = true;
          logJob(job, "Cancellation requested.");
        }
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type." });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
