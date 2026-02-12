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
 * Format an ISO date string as MM/DD/YYYY for the FMG date input.
 */
function formatDate(isoString) {
  if (!isoString) {
    const now = new Date();
    return `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;
  }
  const d = new Date(isoString);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

/**
 * Upload a featured image via the Filestack URL input.
 *
 * Flow:
 * 1. Click "Upload Image" button → Filestack modal opens
 * 2. Click "Link (URL)" sidebar tab
 * 3. Paste the image URL into the input
 * 4. Click the submit button
 * 5. Wait for processing, then confirm upload
 */

/**
 * Two-step FMG login flow:
 * 1. Fill username, click "Next"
 * 2. Wait for password field, fill password, click "Let's Go"
 */
async function login(page) {
  const sel = config.fmg.selectors;

  console.log(`[FMG] Navigating to ${config.fmg.loginUrl}`);
  await page.goto(config.fmg.loginUrl, { waitUntil: "networkidle", timeout: 30000 });

  // Step 1: Enter username and click Next
  console.log("[FMG] Step 1: Filling username");
  await page.fill(sel.username, config.fmg.username);
  await page.click(sel.loginButton);

  // Step 2: Wait for password field to appear, fill it, click login
  console.log("[FMG] Step 2: Waiting for password field");
  await page.waitForSelector(sel.password, { state: "visible", timeout: 15000 });
  await page.fill(sel.password, config.fmg.password);
  console.log("[FMG] Step 2: Clicking login button");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }),
    page.click(sel.loginButton),
  ]);

  console.log("[FMG] Login complete");
}

/**
 * Upload a featured image via the FMG file chooser.
 */
async function uploadFeaturedImage(page, imageUrl) {
  if (!imageUrl) {
    console.log("[FMG] No featured image — skipping upload");
    return;
  }

  const sel = config.fmg.selectors;

  // Step 1: Click "Upload Image" button to open Filestack modal
  console.log("[FMG] Opening Filestack upload modal");
  await page.click(sel.uploadButton);
  await page.waitForSelector(".fsp-modal", { state: "visible", timeout: 10000 });

  // Step 2: Click "Link (URL)" tab in the sidebar
  console.log("[FMG] Switching to Link (URL) tab");
  await page.click('div[title="Link (URL)"]');
  await page.waitForSelector("input.fsp-url-source__input", { state: "visible", timeout: 5000 });

  // Step 3: Paste the image URL
  console.log(`[FMG] Entering image URL: ${imageUrl}`);
  await page.fill("input.fsp-url-source__input", imageUrl);

  // Step 4: Click submit button
  await page.click("button.fsp-url-source__submit-button");
  console.log("[FMG] URL submitted — waiting for processing");
  await page.waitForTimeout(3000);

  // Step 5: Click "Upload" / confirm button if present
  const uploadConfirm = await page.$('.fsp-button--primary:not(.fsp-button--disabled)');
  if (uploadConfirm) {
    console.log("[FMG] Clicking upload confirm button");
    await uploadConfirm.click();
    await page.waitForTimeout(3000);
  }

  // Wait for modal to close or close it manually
  const modalStillOpen = await page.$(".fsp-modal");
  if (modalStillOpen) {
    const closeBtn = await page.$(".fsp-picker__close-button");
    if (closeBtn) await closeBtn.click();
    await page.waitForTimeout(1000);
  }

  console.log("[FMG] Featured image upload complete");
}

/**
 * Check page for submission success or failure indicators.
 */
async function validateSubmission(page) {
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
      return;
    }
  }

  console.log("[FMG] No error indicators detected on page");
}

async function submitToFMG({ title, html, featureImage, publishedAt, metaDescription }) {
  ensureScreenshotsDir();

  console.log(`[FMG] Starting submission for: "${title}"`);

  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();
  const sel = config.fmg.selectors;

  try {
    // 1. Login (two-step)
    await login(page);

    // 2. Navigate to blog add page
    console.log(`[FMG] Navigating to ${config.fmg.targetUrl}`);
    await page.goto(config.fmg.targetUrl, { waitUntil: "networkidle", timeout: 30000 });

    // 3. Fill title
    console.log("[FMG] Filling title");
    await page.fill(sel.title, title);

    // 4. Set post date (MM/DD/YYYY)
    const dateStr = formatDate(publishedAt);
    console.log(`[FMG] Setting post date: ${dateStr}`);
    await page.click(sel.displayDate, { clickCount: 3 }); // select all existing text
    await page.keyboard.press("Backspace");
    await page.type(sel.displayDate, dateStr);

    // 5. Fill body via TinyMCE
    console.log("[FMG] Filling body via TinyMCE");
    await page.waitForFunction(() => typeof window.tinymce !== "undefined" && window.tinymce.editors.length > 0, { timeout: 15000 });
    await page.evaluate((content) => {
      window.tinymce.editors[0].setContent(content);
    }, html);

    // 6. Upload featured image (non-fatal — continue if upload fails)
    try {
      await uploadFeaturedImage(page, featureImage);
    } catch (uploadErr) {
      console.warn(`[FMG] Featured image upload failed (continuing): ${uploadErr.message}`);
    }

    // 7. Fill summary (max 240 chars)
    if (metaDescription) {
      const summary = metaDescription.slice(0, 240);
      console.log(`[FMG] Filling summary (${summary.length} chars)`);
      await page.fill(sel.summary, summary);
    }

    // 8. Fill SEO Title Tag (max 100 chars)
    const seoTitle = title.slice(0, 100);
    console.log(`[FMG] Filling SEO title tag`);
    await page.fill(sel.seoTitle, seoTitle);

    // 9. Fill SEO Description Tag (max 280 chars)
    if (metaDescription) {
      const seoDesc = metaDescription.slice(0, 280);
      console.log(`[FMG] Filling SEO description tag (${seoDesc.length} chars)`);
      await page.fill(sel.seoDescription, seoDesc);
    }

    // 10. Click Publish
    console.log("[FMG] Clicking Publish");
    await page.click(sel.publish);

    // 11. Wait for page to settle
    await page.waitForLoadState("networkidle", { timeout: 30000 });

    // 12. Validate submission
    await validateSubmission(page);

    // 13. Screenshot for audit trail
    const successShot = screenshotPath("success");
    await page.screenshot({ path: successShot, fullPage: true });
    console.log(`[FMG] Success screenshot saved: ${successShot}`);

    console.log(`[FMG] Submission complete for: "${title}"`);
  } catch (err) {
    const errorShot = screenshotPath("error");
    await page.screenshot({ path: errorShot, fullPage: true }).catch(() => {});
    console.error(`[FMG] Error screenshot saved: ${errorShot}`);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { submitToFMG };
