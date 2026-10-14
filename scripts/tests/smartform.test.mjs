import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../../background.js", import.meta.url), "utf8");
const labels = [
  "1.0 Intake Questions",
  "Non-Regulated Research",
  "3.0 Study Personnel",
  "5.0 Performance Sites",
  "6.0 Study Summary/Consent forms",
  "20.0 Final Page"
];
const inventory = labels.map((label, index) => ({ label, index }));
const page = (label, content = "Synthetic question and answer content") =>
  `<div id="_webr_EntityView"><h2>${label}</h2>${content}</div>`;
const fixture = (pages) => `<body>STU12345678<div id="printProgress">100%</div>${pages}</body>`;
function harness(html) {
  const dom = new JSDOM(html, {
    url: "https://ethos.swmed.edu/ETHOS/",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const document = dom.window.document;
  Object.defineProperty(document, "readyState", { get: () => "complete" });
  let time = 1000;
  let onSleep = () => {};
  class Clock extends Date {
    static now() {
      return time;
    }
  }
  const context = vm.createContext({
    Date: Clock,
    URL,
    URLSearchParams,
    console,
    setTimeout: (callback, ms) => {
      time += ms;
      onSleep(time);
      callback();
    },
    chrome: {
      runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version: "test" }) },
      downloads: { onDeterminingFilename: { addListener() {} } },
      scripting: {
        executeScript: async ({ func, args }) => {
          // Execute in an isolated DOM realm, as Chrome does. Worker helpers cannot leak in.
          dom.window.__args = args;
          const result = await vm.runInContext(
            `(${func.toString()})(...__args)`,
            dom.getInternalVMContext()
          );
          return [{ result, frameId: 0 }];
        }
      }
    }
  });
  vm.runInContext(source, context);
  return {
    context,
    document,
    dom,
    now: () => time,
    onSleep: (callback) => {
      onSleep = callback;
    }
  };
}

test("numbered and named pages capture once in source order, excluding unrelated and nested blocks", async () => {
  const nested =
    page("Unrelated nested heading", "Nested personnel information") +
    `<a onclick="showReadOnlyCustomDataForm('item','view','root','rootView','path','attribute')">View</a>`;
  const h = harness(
    fixture(
      labels.map((label, i) => page(label, i === 2 ? nested : undefined)).join("") +
        page(labels[1]) +
        page("Unrelated status")
    )
  );
  const result = await h.context.capturePrintedSmartForm(1, inventory);
  assert.deepEqual(
    Array.from(result.sections, (section) => section.label),
    labels
  );
  assert.equal(result.sections[2].views.length, 1);
  assert.match(result.sections[2].views[0].url, /readonly=1/);
  assert.match(result.sections[2].html, /Nested personnel information/);
});

test("navigation-identified named pages do not collide with each other or numbered prefixes", async () => {
  const names = ["Named page A", "Named page B", "1.0 Intake A", "1.0 Intake B"];
  const h = harness(fixture(names.map((label) => page(label)).join("")));
  const result = await h.context.capturePrintedSmartForm(
    1,
    names.map((label) => ({ label }))
  );
  assert.deepEqual(
    Array.from(result.sections, (section) => section.label),
    names
  );
});

test("serialization preserves live answers, required markers, full text, and unanswered controls", async () => {
  const h = harness(
    fixture(
      page(
        labels[1],
        `<label>* 1.1 Question<input id="yes" name="q1" type="radio" value="yes" required>Yes<input name="q1" type="radio" value="no">No</label>
    <label>1.2 Question<input name="q2" type="radio" value="yes" checked>Yes<input id="no" name="q2" type="radio" value="no">No</label>
    <label>1.3 Unanswered<input name="q3" type="radio" value="yes">Yes<input name="q3" type="radio" value="no">No</label>
    <input id="check" type="checkbox"><textarea>Old text</textarea><input id="text" value="old">
    <select id="category"><option>Other</option><option>Routine Quality Improvement</option></select>
    <select id="empty"><option>Must not infer this</option></select>`
      )
    )
  );
  h.document.querySelector("#yes").checked = true;
  h.document.querySelector("#no").checked = true;
  h.document.querySelector("#check").checked = true;
  h.document.querySelector("textarea").value = "Full multiline answer\nwith additional detail";
  h.document.querySelector("#text").value = "";
  h.document.querySelector("#category").selectedIndex = 1;
  h.document.querySelector("#empty").selectedIndex = -1;
  const result = await h.context.capturePrintedSmartForm(1, inventory);
  const saved = new JSDOM(result.sections[0].html).window.document;
  assert.equal(saved.querySelector('input[name="q1"]:checked').value, "yes");
  assert.equal(saved.querySelector('input[name="q2"]:checked').value, "no");
  assert.equal(saved.querySelector('input[name="q3"]:checked'), null);
  assert.equal(saved.querySelector("#yes").required, true);
  assert.equal(saved.querySelector("#check").checked, true);
  assert.equal(
    saved.querySelector("textarea").value,
    "Full multiline answer\nwith additional detail"
  );
  assert.equal(saved.querySelector("#text").value, "");
  assert.equal(saved.querySelector("#category").value, "Routine Quality Improvement");
  assert.equal(saved.querySelector("#empty option:checked").dataset.exportUnanswered, "true");
});

test("readiness waits for a delayed named page and delayed answer updates despite 100% progress", async () => {
  const h = harness(fixture(page(labels[0])));
  let inserted = false;
  let answered = false;
  h.onSleep((time) => {
    if (!inserted && time >= 6000) {
      h.document.body.insertAdjacentHTML(
        "beforeend",
        page(labels[1], '<input id="answer" value="">Question content')
      );
      inserted = true;
    }
    if (!answered && time >= 8000) {
      h.document.querySelector("#answer").value = "Late answer";
      answered = true;
    }
  });
  const result = await h.context.waitForPrintedSmartFormReady(1, 20000, inventory.slice(0, 2));
  assert.equal(result.ok, true);
  assert.equal(result.headingCount, 2);
  assert.ok(h.now() >= 11000);
});

test("missing named pages and absent independent inventory cannot report completeness", async () => {
  const h = harness(fixture(page(labels[0])));
  const state = await h.context.capturePrintedSmartForm(1, inventory.slice(0, 2), true);
  assert.deepEqual(Array.from(state.missingLabels), [labels[1]]);
  const job = h.context.createJob(1);
  job.smartformSections = [{ label: labels[0] }];
  h.context.checkSmartFormCompleteness(job, inventory.slice(0, 2));
  assert.equal(job.diagnostics.smartform.completeness, "incomplete");
  assert.match(job.warnings.join(" "), /Missing: 2 Non-Regulated Research/);
  h.context.checkSmartFormCompleteness(job, []);
  assert.equal(job.diagnostics.smartform.completeness, "unverified");
});

test("named page persists with the existing package path and diagnostic contract", async () => {
  const h = harness(fixture(page(labels[1])));
  const saved = [];
  h.context.saveTextFile = async (_study, path, text) => {
    saved.push({ path, text });
    return path;
  };
  const job = h.context.createJob(1);
  job.studyId = "STU12345678";
  const result = await h.context.capturePrintedSmartForm(1, inventory);
  await h.context.persistSmartFormSnapshot(job, 1, null, 2, result.sections[0]);
  assert.equal(saved[0].path, "smartform/Non-Regulated_Research/segment.html");
  assert.equal(job.smartformSections[0].label, labels[1]);
  assert.equal(job.diagnostics.smartform.sectionReports[0].label, labels[1]);
  h.context.checkSmartFormCompleteness(job, [inventory[1]]);
  assert.equal(job.diagnostics.smartform.completeness, "complete");
});

test("read-only navigation captures named heading before its locally numbered questions", async () => {
  const h = harness(`<a class="smartFormSectionLink" data-viewid="named">Non-Regulated Research</a>
    <div id="named"><strong>Non-Regulated Research</strong><strong>1.1 Screening question</strong>
    <label>Selected answer<input type="radio" name="screen" value="No" checked>No</label></div>`);
  h.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  h.dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 100 }];
  h.dom.window.setTimeout = (callback) => callback();
  const result = await h.context.captureSectionSnapshot(1, 0, 0);
  assert.equal(result.ok, true);
  assert.equal(result.selectorStats.heading, labels[1]);
  const saved = new JSDOM(result.html).window.document;
  assert.equal(saved.querySelector('input[name="screen"]:checked').value, "No");
});

for (const recoveryFails of [false, true]) {
  test(`print omission ${recoveryFails ? "reports failed recovery" : "recovers only missing page in navigation order"}`, async () => {
    const h = harness(fixture(labels.map((label) => page(label)).join("")));
    const saved = new Map();
    const recovered = [];
    const ctx = h.context;
    ctx.chrome.tabs = { update: async () => {} };
    ctx.waitForTabComplete = async () => {};
    ctx.detectStudyContext = async () => ({
      supportedHost: true,
      isLikelyWorkspace: true,
      studyId: "STU12345678",
      url: "https://ethos.swmed.edu/workspace"
    });
    let opens = 0;
    ctx.openSmartFormReadOnly = async () => {
      opens++;
      return {
        ok: !(recoveryFails && opens === 2),
        method: "test",
        error: "Synthetic recovery failure"
      };
    };
    ctx.findSmartFormFrame = async () => 0;
    ctx.listSmartFormSections = async () => inventory;
    ctx.openSmartFormPrintProject = async () => ({ ok: true, method: "test" });
    ctx.capturePrintedSmartForm = async () => ({
      ok: true,
      sections: labels
        .filter((label) => label !== labels[1])
        .map((label) => ({ label, html: page(label), views: [] }))
    });
    ctx.captureSectionSnapshot = async (_tab, _frame, index) => {
      recovered.push(index);
      return { ok: true, label: labels[index], html: page(labels[index]), views: [] };
    };
    ctx.restoreDocumentsContext = async () => 0;
    ctx.waitForDocumentsCountStable = async () => ({ count: 0, stable: true });
    ctx.saveTextFile = async (_study, path, text) => {
      saved.set(path, text);
      return path;
    };
    await ctx.runExport(1);
    const diagnostics = JSON.parse(saved.get("export_diagnostics.json"));
    const index = JSON.parse(saved.get("smartform/index.json"));
    const manifest = JSON.parse(saved.get("manifest.json"));
    assert.equal(diagnostics.smartform.inventorySource, "readOnlyNavigation");
    assert.equal(diagnostics.smartform.missingPrintPages[0].label, labels[1]);
    assert.equal(diagnostics.smartform.completeness, recoveryFails ? "incomplete" : "complete");
    if (!recoveryFails) {
      assert.deepEqual(recovered, [1]);
      assert.deepEqual(
        diagnostics.smartform.sectionReports.map((report) => report.sectionNumber),
        [1, 2, 3, 4, 5, 6]
      );
      assert.deepEqual(
        index.sections.map((section) => section.label),
        labels
      );
      assert.match(JSON.stringify(manifest), /Non-Regulated Research/);
      assert.ok(saved.has("smartform/Non-Regulated_Research/segment.html"));
    } else {
      assert.equal(index.sections.length, 5);
      assert.match(diagnostics.warnings.join(" "), /navigation recovery failed/);
      assert.equal(diagnostics.smartform.missingSections[0].label, labels[1]);
    }
  });
}

test("navigation and page capitalization differences preserve source headings without false omissions", async () => {
  const heading = "6.0 Study Summary/Consent Forms";
  const expected = [{ label: "6.0 Study Summary/Consent forms" }];
  const h = harness(fixture(page(heading)));
  const state = await h.context.capturePrintedSmartForm(1, expected, true);
  assert.equal(state.missingLabels.length, 0);
  const result = await h.context.capturePrintedSmartForm(1, expected);
  assert.equal(result.sections[0].label, heading);
  const job = h.context.createJob(1);
  job.smartformSections = result.sections;
  h.context.checkSmartFormCompleteness(job, expected);
  assert.equal(job.diagnostics.smartform.completeness, "complete");
});

test("full export with case-varied print heading stays in navigation order without recovery", async () => {
  const h = harness(fixture(labels.map((label) => page(label)).join("")));
  const ctx = h.context;
  const saved = new Map();
  let navigationOpens = 0;
  ctx.chrome.tabs = { update: async () => {} };
  ctx.waitForTabComplete = async () => {};
  ctx.detectStudyContext = async () => ({
    supportedHost: true,
    isLikelyWorkspace: true,
    studyId: "STU12345678",
    url: "https://ethos.swmed.edu/workspace"
  });
  ctx.openSmartFormReadOnly = async () => {
    navigationOpens++;
    return { ok: true, method: "test" };
  };
  ctx.findSmartFormFrame = async () => 0;
  ctx.listSmartFormSections = async () => inventory;
  ctx.openSmartFormPrintProject = async () => ({ ok: true, method: "test" });
  ctx.capturePrintedSmartForm = async () => ({
    ok: true,
    sections: labels.map((label) => ({
      label: label.replace("Consent forms", "Consent Forms"),
      html: page(label),
      views: []
    }))
  });
  ctx.restoreDocumentsContext = async () => 0;
  ctx.waitForDocumentsCountStable = async () => ({ count: 0, stable: true });
  ctx.saveTextFile = async (_study, path, text) => {
    saved.set(path, text);
    return path;
  };
  await ctx.runExport(1);
  assert.equal(navigationOpens, 1);
  const diagnostics = JSON.parse(saved.get("export_diagnostics.json"));
  assert.equal(diagnostics.smartform.completeness, "complete");
  assert.equal(diagnostics.smartform.captureSource, "printProject");
  assert.equal(diagnostics.smartform.missingPrintPages.length, 0);
  const index = JSON.parse(saved.get("smartform/index.json"));
  assert.deepEqual(
    index.sections.map((section) => section.label.toLowerCase()),
    labels.map((label) => label.toLowerCase())
  );
});
