const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const config = require("./config");

const SCREENSHOTS_DIR = path.join(__dirname, "..", "screenshots");

function ensureScreenshotsDir() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

function screenshotPath(label) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(SCREENSHOTS_DIR, `${label}-${ts}.png`);
}

/**
 * Fill a rich text body field using the appropriate strategy.
 *
 * Strategies:
 *   tinymce        — use TinyMCE's JS API
 *   ckeditor       — use CKEditor 4/5 JS API
 *   contenteditable — find [contenteditable="true"] and set innerHTML
 *   plain          — standard page.fill() for <textarea>/<input>
 *   auto (default) — try each strategy in order until one works
 */
async function fillBody(page, selector, html) {
  const strategy = config.fmg.bodyStrategy;

  if (strategy === "tinymce" || strategy === "auto") {
    const ok = await tryTinyMCE(page, html);
    if (ok) return;
    if (strategy === "tinymce") throw new Error("TinyMCE editor not found on page");
  }

  if (strategy === "ckeditor" || strategy === "auto") {
    const ok = await tryCKEditor(page, html);
    if (ok) return;
    if (strategy === "ckeditor") throw new Error("CKEditor not found on page");
  }

  if (strategy === "contenteditable" || strategy === "auto") {
    const ok = await tryContentEditable(page, selector, html);
    if (ok) return;
    if (strategy === "contenteditable")
      throw new Error("No contenteditable element found for body selector");
  }

  // plain / final auto fallback
  await page.fill(selector, html);
}

async function tryTinyMCE(page, html) {
  return page.evaluate((content) => {
    if (typeof window.tinymce === "undefined" || window.tinymce.editors.length === 0)
      return false;
    window.tinymce.editors[0].setContent(content);
    return true;
  }, html);
}

async function tryCKEditor(page, html) {
  return page.evaluate((content) => {
    // CKEditor 4
    if (typeof window.CKEDITOR !== "undefined" && window.CKEDITOR.instances) {
      const names = Object.keys(window.CKEDITOR.instances);
      if (names.length > 0) {
        window.CKEDITOR.instances[names[0]].setData(content);
        return true;
      }
    }
    // CKEditor 5 — look for the editor instance on the element
    const ck5El = document.querySelector(".ck-editor__editable");
    if (ck5El && ck5El.ckeditorInstance) {
      ck5El.ckeditorInstance.setData(content);
      return true;
    }
    return false;
  }, html);
}

async function tryContentEditable(page, selector, html) {
  // Try the configured selector first — it might point to a contenteditable
  const found = await page.evaluate(
    ({ sel, content }) => {
      let el = document.querySelector(sel);
      if (el && el.getAttribute("contenteditable") === "true") {
        el.innerHTML = content;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
      // Fallback: find the first non-body contenteditable
      const editables = document.querySelectorAll('[contenteditable="true"]');
      for (const e of editables) {
        if (e.tagName !== "BODY") {
          e.innerHTML = content;
          e.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
      }
      return false;
    },
    { sel: selector, content: html }
  );
  return found;
}

/**
 * Check page for submission success or failure indicators.
 */
async function validateSubmission(page) {
  const { success, error } = config.fmg.selectors;

  // Explicit error selector check
  if (error) {
    const errorEl = await page.$(error);
    if (errorEl) {
      const text = await errorEl.textContent();
      throw new Error(`Submission failed — error element found: ${text.trim()}`);
    }
  }

  // Explicit success selector check
  if (success) {
    const successEl = await page.$(success);
    if (successEl) {
      console.log("[FMG] Success indicator found on page");
      return;
    }
    console.warn("[FMG] Warning: success selector configured but not found on page");
  }

  // Fallback: scan page text for common error keywords
  const bodyText = await page.evaluate(() => document.body.innerText);
  const errorPatterns = [
    /\berror\b/i,
    /\bfailed\b/i,
    /\binvalid\b/i,
    /\bcould not\b/i,
    /\bunable to\b/i,
  ];

  for (const pattern of errorPatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      console.warn(
        `[FMG] Warning: page contains "${match[0]}" — submission may have failed. Check the screenshot.`
      );
      return; // warn once, don't throw
    }
  }

  console.log("[FMG] No error indicators detected on page");
}

async function submitToFMG({ title, html }) {
  ensureScreenshotsDir();

  console.log(`[FMG] Starting submission for: "${title}"`);

  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();

  try {
    // 1. Navigate to login page
    console.log(`[FMG] Navigating to ${config.fmg.loginUrl}`);
    await page.goto(config.fmg.loginUrl, { waitUntil: "networkidle", timeout: 30000 });

    // 2. Fill login credentials
    console.log("[FMG] Filling login credentials");
    await page.fill(config.fmg.selectors.username, config.fmg.username);
    await page.fill(config.fmg.selectors.password, config.fmg.password);

    // 3. Click login and wait for navigation
    console.log("[FMG] Clicking login button");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }),
      page.click(config.fmg.selectors.loginButton),
    ]);
    console.log("[FMG] Login complete");

    // 4. Navigate to submission page
    console.log(`[FMG] Navigating to ${config.fmg.targetUrl}`);
    await page.goto(config.fmg.targetUrl, { waitUntil: "networkidle", timeout: 30000 });

    // 5. Fill in the article title
    console.log("[FMG] Filling title field");
    await page.fill(config.fmg.selectors.title, title);

    // 6. Fill in the article body (handles rich text editors)
    console.log(`[FMG] Filling body field (strategy: ${config.fmg.bodyStrategy})`);
    await fillBody(page, config.fmg.selectors.body, html);

    // 7. Click submit
    console.log("[FMG] Clicking submit button");
    await page.click(config.fmg.selectors.submit);

    // 8. Wait for the page to settle after submission
    await page.waitForLoadState("networkidle", { timeout: 30000 });

    // 9. Validate submission result
    await validateSubmission(page);

    // 10. Screenshot for audit trail
    const successShot = screenshotPath("success");
    await page.screenshot({ path: successShot, fullPage: true });
    console.log(`[FMG] Success screenshot saved: ${successShot}`);

    console.log(`[FMG] Submission complete for: "${title}"`);
  } catch (err) {
    // Screenshot on error for debugging
    const errorShot = screenshotPath("error");
    await page.screenshot({ path: errorShot, fullPage: true }).catch(() => {});
    console.error(`[FMG] Error screenshot saved: ${errorShot}`);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { submitToFMG };
