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
      schemaVersion: "1.2",
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
      if (!tabMatches && !likelyEthos) return;

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
  suggest({ filename, conflictAction: "uniquify" });
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
              ".DialogButtonBar, .ui-dialog-titlebar, #navigation, #btnOkReadOnly, #fileProgressDiv, #documentFormHolder, #PortalToolsData"
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
        }

        const removeSelectors = [
          "script",
          "style",
          "noscript",
          "input[type='hidden']",
          ".Hidden",
          ".DialogButtonBar",
          ".ui-dialog-titlebar",
          "#navigation",
          "#btnOkReadOnly",
          "#fileProgressDiv",
          "#documentFormHolder",
          "#PortalToolsData"
        ];
        clone.querySelectorAll(removeSelectors.join(",")).forEach((node) => node.remove());
        clone.querySelectorAll("[data-export-remove='1']").forEach((node) => node.remove());

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
          if (tag === "BUTTON" || tag === "INPUT") {
            const type = String(node.getAttribute("type") || "").toLowerCase();
            const text = (node.textContent || node.getAttribute("value") || "").trim();
            if (
              (type === "button" || type === "submit" || tag === "BUTTON") &&
              /^(ok|close)$/i.test(text)
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
      await sleepInner(800);

      let container = null;
      const viewId = link.getAttribute("data-viewid");
      if (viewId) {
        container = document.getElementById(viewId);
      }
      if (!container) {
        const href = link.getAttribute("href") || "";
        if (href.includes("#")) {
          const targetId = href.split("#").pop();
          if (targetId) container = document.getElementById(targetId);
        }
      }
      if (!container) {
        const area = document.querySelector(".SmartFormViewArea");
        if (area) {
          const candidates = Array.from(area.querySelectorAll("div, section, article")).filter(
            (el) => {
              const text = (el.textContent || "").trim();
              return text.length > 80 && el.offsetParent !== null;
            }
          );
          container =
            candidates.sort((a, b) => b.textContent.length - a.textContent.length)[0] || area;
        }
      }
      if (!container) container = document.body;

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
          viewLinkCount: viewLinks.length
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
            ".Hidden",
            ".DialogButtonBar",
            ".ui-dialog-titlebar",
            "#navigation",
            "#btnOkReadOnly",
            "#fileProgressDiv",
            "#documentFormHolder",
            "#PortalToolsData"
          ];
          doc.querySelectorAll(removeSelectors.join(",")).forEach((node) => node.remove());
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
            if (tag === "BUTTON" || tag === "INPUT") {
              const type = String(node.getAttribute("type") || "").toLowerCase();
              const text = (node.textContent || node.getAttribute("value") || "").trim();
              if (
                (type === "button" || type === "submit" || tag === "BUTTON") &&
                /^(ok|close)$/i.test(text)
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

async function openDocumentOptions(tabId, index, frameId = null) {
  return runScript(
    tabId,
    async (idx) => {
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
      await new Promise((resolve) => setTimeout(resolve, 300));

      const menuItems = Array.from(document.querySelectorAll("[role='menuitem'], a, button"))
        .map((n) => ({ node: n, text: (n.textContent || "").trim() }))
        .filter((item) => /download/i.test(item.text));
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
        .map((n) => ({ node: n, text: (n.textContent || "").trim() }))
        .filter((item) => /download/i.test(item.text));
      if (!candidates.length) return { ok: false, error: "No download menu item found to click." };

      const copyItems = candidates.filter((item) => /download copy/i.test(item.text));
      const plainItems = candidates.filter((item) => /^download$/i.test(item.text));
      const anyDownloadItems = candidates.filter((item) => /download/i.test(item.text));

      const pick =
        (preferCopyArg ? copyItems[0] : null) ||
        plainItems[0] ||
        copyItems[0] ||
        anyDownloadItems[0];

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
      const candidates = Array.from(document.querySelectorAll("[role='menuitem'], a, button"))
        .map((n) => ({ node: n, text: (n.textContent || "").trim() }))
        .filter((item) => /download/i.test(item.text));
      if (!candidates.length) return { ok: false, error: "No download menu item found to click." };

      const copyItems = candidates.filter((item) => /download copy/i.test(item.text));
      const plainItems = candidates.filter((item) => /^download$/i.test(item.text));
      const anyDownloadItems = candidates.filter((item) => /download/i.test(item.text));

      const pick =
        (preferCopyArg ? copyItems[0] : null) ||
        plainItems[0] ||
        copyItems[0] ||
        anyDownloadItems[0];

      if (!pick) return { ok: false, error: "No suitable download item matched." };
      pick.node.click();
      return { ok: true, clickedLabel: pick.text };
    },
    [preferCopy],
    frameId
  );
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
    job.step = "Opening SmartForm read-only view";
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

    const sections = (await listSmartFormSections(tabId, frameId)) || [];
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
          warnJob(job, err);
          continue;
        }

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
              if (view?.error)
                warnJob(job, `View capture issue in "${snapshot.label}": ${view.error}`);
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
          sectionNumber: i + 1,
          label: snapshot.label,
          sectionDir: dir,
          segmentPath,
          partCountSaved: stitchedParts.length,
          viewCountDetected: Array.isArray(snapshot.views) ? snapshot.views.length : 0,
          viewCountIncluded: Math.max(0, stitchedParts.length - 1),
          selectorStats: snapshot.selectorStats || {}
        });
        logJob(job, `Captured section ${i + 1}/${sections.length}: ${snapshot.label}`);
        await sleep(200);
      } catch (err) {
        const message = err?.message || String(err);
        job.errors.push(`Section ${i + 1} error: ${message}`);
        job.diagnostics.errors.push(`Section ${i + 1} error: ${message}`);
        warnJob(job, `Section ${i + 1} error: ${message}`);
      }
    }

    await writeSmartFormIndex(job);
    logJob(job, "Wrote smartform/index.json");

    if (job.cancelRequested) return cancelAndPersist();
    job.step = "Returning to workspace";
    await chrome.tabs.update(tabId, { url: job.workspaceUrl });
    await waitForTabComplete(tabId, 40000);
    await sleep(800);

    if (job.cancelRequested) return cancelAndPersist();
    job.step = "Downloading study documents";
    const openDocs = await openDocumentsTab(tabId);
    if (!openDocs?.ok) throw new Error(openDocs?.error || "Failed to open Documents.");
    await sleep(1200);
    const docsFrameId = await findDocumentsFrame(tabId);
    if (docsFrameId == null) {
      warnJob(job, "Could not identify a frame containing Document Options; using top frame.");
    } else {
      logJob(job, `Using documents frame ${docsFrameId}.`);
    }
    const docsInfo = await getDocumentsCount(tabId, docsFrameId);
    job.documentTotal = docsInfo?.count || 0;
    job.diagnostics.documents.frameId = docsFrameId;
    job.diagnostics.documents.optionRowsDetected = job.documentTotal;
    logJob(job, `Found ${job.documentTotal} document option rows.`);
    if (job.documentTotal === 0) {
      warnJob(
        job,
        "No document rows detected. Check ETHOS permissions/tab state or selector drift."
      );
    }

    for (let i = 0; i < job.documentTotal; i++) {
      if (job.cancelRequested) return cancelAndPersist();
      job.documentIndex = i + 1;
      try {
        const prep = await openDocumentOptions(tabId, i, docsFrameId);
        if (!prep?.ok) {
          const err = prep?.error || `Failed to prepare download for doc #${i + 1}`;
          job.errors.push(err);
          job.diagnostics.errors.push(err);
          warnJob(job, err);
          continue;
        }

        const safeBase = sanitizeFilename(prep.docName || `document_${i + 1}`);
        const extHint = sanitizeExtension(prep.extHint || "");
        job.awaitingDoc = { displayName: prep.docName || `Document ${i + 1}`, safeBase, extHint };
        const action = await getDownloadMenuAction(tabId, true, docsFrameId);
        if (!action?.ok) {
          const err = action?.error || `Failed to resolve download action for doc #${i + 1}`;
          job.errors.push(err);
          job.diagnostics.errors.push(err);
          warnJob(job, err);
          job.awaitingDoc = null;
          continue;
        }

        let completeItem = null;
        let usedDirect = false;
        if (action.resolvedUrl) {
          try {
            const expectedDocFilename = `ETHOS/${job.studyId}/documents/${safeBase}${extHint || ""}`;
            queueExpectedFilename(expectedDocFilename, "uniquify");
            const directId = await chrome.downloads.download({
              url: action.resolvedUrl,
              filename: expectedDocFilename,
              saveAs: false,
              conflictAction: "uniquify"
            });
            completeItem = await waitForDownloadComplete(directId, 120000);
            usedDirect = true;
          } catch (directErr) {
            warnJob(
              job,
              `Direct URL download failed for "${prep.docName}", falling back to click mode: ${directErr?.message || String(directErr)}`
            );
          }
        } else {
          warnJob(job, `Could not resolve direct URL for "${prep.docName}", using click fallback.`);
        }

        let clickResult = { ok: true, clickedLabel: action.clickedLabel || "" };
        if (!completeItem) {
          const downloadCreatedPromise = waitForCreatedDownload(job, 40000);
          clickResult = await clickDownloadMenuItem(tabId, true, docsFrameId);
          if (!clickResult?.ok) {
            const err = clickResult?.error || `Failed to click download for doc #${i + 1}`;
            job.errors.push(err);
            job.diagnostics.errors.push(err);
            warnJob(job, err);
            job.awaitingDoc = null;
            continue;
          }
          const created = await downloadCreatedPromise;
          completeItem = await waitForDownloadComplete(created.id, 120000);
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
          menuHadDownloadCopy: Boolean(prep.hasCopy),
          menuHadPlainDownload: Boolean(prep.hasPlain),
          clickedMenuLabel: clickResult?.clickedLabel || "",
          usedDirectUrl: usedDirect,
          resolvedUrlHost: action.resolvedUrl
            ? (() => {
                try {
                  return new URL(action.resolvedUrl).host;
                } catch (_) {
                  return "";
                }
              })()
            : "",
          savedPath,
          finalFilename: completeItem.filename,
          mime,
          lookedLikeHtml
        });
        job.awaitingDoc = null;
        logJob(job, `Downloaded ${job.documentIndex}/${job.documentTotal}: ${prep.docName}`);
        await sleep(200);
      } catch (err) {
        const message = err?.message || String(err);
        job.errors.push(`Document ${i + 1} error: ${message}`);
        job.diagnostics.errors.push(`Document ${i + 1} error: ${message}`);
        warnJob(job, `Document ${i + 1} error: ${message}`);
        job.awaitingDoc = null;
      }
    }

    if (job.cancelRequested) return cancelAndPersist();
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
