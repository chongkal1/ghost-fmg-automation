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
 * Take a numbered debug screenshot and log the step.
 */
let stepCounter = 0;
async function debugScreenshot(page, label) {
  stepCounter++;
  const num = String(stepCounter).padStart(2, "0");
  const filename = `step-${num}-${label}`;
  const filePath = screenshotPath(filename);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`[FMG] Step ${num}: ${label} — screenshot: ${filePath}`);
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
 * Select author from the MUI Select dropdown.
 */
async function selectAuthor(page) {
  const sel = config.fmg.selectors;
  const authorValue = config.fmg.authorValue;

  if (!authorValue) {
    console.log("[FMG] No author value configured — skipping author selection");
    return;
  }

  console.log(`[FMG] Selecting author (value: ${authorValue})`);

  // Find the MUI Select trigger near the author input
  // The authorSelect points to the hidden input; we need to click the adjacent MUI Select div
  const authorInput = await page.$(sel.authorSelect);
  if (!authorInput) {
    console.warn("[FMG] Author input not found — trying fallback selector");
    // Fallback: try clicking any MuiSelect-select on the page
    const muiSelect = await page.$("div.MuiSelect-select");
    if (muiSelect) {
      await muiSelect.click();
    } else {
      console.warn("[FMG] No author dropdown found — skipping");
      return;
    }
  } else {
    // Click the parent MUI Select div (sibling of the hidden input)
    const parentSelect = await page.evaluateHandle((input) => {
      // Walk up to find the MuiSelect-select element
      let el = input.parentElement;
      while (el) {
        const selectDiv = el.querySelector("div.MuiSelect-select");
        if (selectDiv) return selectDiv;
        el = el.parentElement;
      }
      return null;
    }, authorInput);

    if (parentSelect && await parentSelect.evaluate(el => el !== null)) {
      await parentSelect.click();
    } else {
      // Direct fallback: click the first MuiSelect-select
      await page.click("div.MuiSelect-select");
    }
  }

  // Wait for the dropdown menu to appear
  await page.waitForSelector("ul.MuiMenu-list, ul.MuiList-root", { state: "visible", timeout: 5000 });
  console.log("[FMG] Author dropdown opened");

  // Click the specific author option
  const optionSelector = `li[data-value="${authorValue}"]`;
  const option = await page.$(optionSelector);
  if (option) {
    await option.click();
    console.log("[FMG] Author option clicked");
  } else {
    // Fallback: try to find by text content
    console.warn(`[FMG] Author option ${optionSelector} not found — trying text match`);
    const menuItems = await page.$$("li.MuiMenuItem-root");
    for (const item of menuItems) {
      const text = await item.textContent();
      if (text.includes("Brent") || text.includes("Rupnow")) {
        await item.click();
        console.log(`[FMG] Author selected by text: ${text}`);
        break;
      }
    }
  }

  // Wait for dropdown to close
  await page.waitForSelector("ul.MuiMenu-list, ul.MuiList-root", { state: "hidden", timeout: 5000 }).catch(() => {});
  console.log("[FMG] Author selection complete");
}

/**
 * Upload a featured image via the Filestack URL input.
 *
 * Flow:
 * 1. Click "Upload Image" button → Filestack modal opens
 * 2. Click "Link (URL)" sidebar tab
 * 3. Paste the image URL into the input
 * 4. Click the submit button
 * 5. Wait for image to load and become selected
 * 6. Click "Upload N" button to enter crop/edit screen
 * 7. Click "Save" on the crop screen
 * 8. Click final "Upload" button
 * 9. Wait for modal to close
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
  await debugScreenshot(page, "modal-opened");

  // Step 2: Click "Link (URL)" tab in the sidebar
  console.log("[FMG] Switching to Link (URL) tab");
  await page.click('div[title="Link (URL)"]');
  await page.waitForSelector("input.fsp-url-source__input", { state: "visible", timeout: 5000 });
  await debugScreenshot(page, "url-tab-clicked");

  // Step 3: Paste the image URL
  console.log(`[FMG] Entering image URL: ${imageUrl}`);
  await page.fill("input.fsp-url-source__input", imageUrl);
  await debugScreenshot(page, "url-filled");

  // Step 4: Click submit button
  console.log("[FMG] Clicking URL submit button");
  await page.click("button.fsp-url-source__submit-button");
  await debugScreenshot(page, "url-submitted");

  // Step 5: Wait for the image to load — look for "Selected" indicator or button to become enabled
  console.log("[FMG] Waiting for image to load...");
  await page.waitForTimeout(3000);

  // Check for various indicators that the file has been selected
  try {
    await page.waitForFunction(() => {
      // Check if "View/Edit Selected" button is enabled
      const primaryBtn = document.querySelector(".fsp-button--primary:not(.fsp-button--disabled)");
      if (primaryBtn) return true;
      // Check for selected files text
      const bodyText = document.body.innerText;
      if (bodyText.includes("Selected") || bodyText.includes("selected")) return true;
      // Check for thumbnail
      const thumb = document.querySelector(".fsp-grid__cell, .fsp-source-list__item");
      if (thumb) return true;
      return false;
    }, { timeout: 10000 });
    console.log("[FMG] Image appears to be loaded/selected");
  } catch {
    console.warn("[FMG] Timeout waiting for image selection indicator — continuing anyway");
  }
  await debugScreenshot(page, "image-loaded");

  // Step 6: Click "Upload N" primary button to enter crop/edit screen
  const uploadNBtn = await page.$(".fsp-button--primary:not(.fsp-button--disabled)");
  if (uploadNBtn) {
    const btnText = await uploadNBtn.textContent();
    console.log(`[FMG] Clicking primary button: "${btnText.trim()}"`);
    await uploadNBtn.click();
  } else {
    console.warn("[FMG] No primary button found after image load — skipping");
  }

  // Step 7: Wait for crop/edit screen, then click "Save"
  console.log("[FMG] Waiting for crop/edit screen...");
  await page.waitForSelector('span.fsp-button--outline[title="Save"]', { state: "visible", timeout: 10000 });
  await debugScreenshot(page, "crop-screen");
  console.log('[FMG] Clicking "Save" on crop screen');
  await page.click('span.fsp-button--outline[title="Save"]');

  // Step 8: Wait for final "Upload" button and click it
  console.log("[FMG] Waiting for final Upload button...");
  await page.waitForTimeout(2000);
  // After Save, the button changes to a final "Upload" — it reuses .fsp-button--primary
  try {
    await page.waitForSelector(".fsp-button--primary:not(.fsp-button--disabled)", { state: "visible", timeout: 10000 });
    await debugScreenshot(page, "final-upload-ready");
    const finalUploadBtn = await page.$(".fsp-button--primary:not(.fsp-button--disabled)");
    if (finalUploadBtn) {
      const finalText = await finalUploadBtn.textContent();
      console.log(`[FMG] Clicking final button: "${finalText.trim()}"`);
      await finalUploadBtn.click();
      console.log("[FMG] Final Upload clicked — waiting for modal to close");
    }
  } catch {
    console.warn("[FMG] Final Upload button not found — trying Save fallback");
  }

  // Step 9: Wait for modal to close (indicates upload complete)
  try {
    await page.waitForSelector(".fsp-modal", { state: "hidden", timeout: 20000 });
    console.log("[FMG] Filestack modal closed — upload complete");
  } catch {
    console.warn("[FMG] Filestack modal did not close — attempting manual close");
    const closeBtn = await page.$(".fsp-picker__close-button");
    if (closeBtn) {
      await closeBtn.click();
      await page.waitForTimeout(1000);
    }
  }

  console.log("[FMG] Featured image upload flow complete");
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
  stepCounter = 0; // Reset step counter for each submission

  console.log(`[FMG] Starting submission for: "${title}"`);

  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();
  const sel = config.fmg.selectors;

  try {
    // 1. Login (two-step)
    await login(page);
    await debugScreenshot(page, "after-login");

    // 2. Navigate to blog add page
    console.log(`[FMG] Navigating to ${config.fmg.targetUrl}`);
    await page.goto(config.fmg.targetUrl, { waitUntil: "networkidle", timeout: 30000 });
    await debugScreenshot(page, "form-loaded");

    // 3. Fill title
    console.log("[FMG] Filling title");
    await page.fill(sel.title, title);
    await debugScreenshot(page, "title-filled");

    // 4. Select author (NEW)
    try {
      await selectAuthor(page);
      await debugScreenshot(page, "author-selected");
    } catch (authorErr) {
      console.warn(`[FMG] Author selection failed (continuing): ${authorErr.message}`);
      await debugScreenshot(page, "author-failed");
    }

    // 5. Set post date (MM/DD/YYYY)
    const dateStr = formatDate(publishedAt);
    console.log(`[FMG] Setting post date: ${dateStr}`);
    await page.click(sel.displayDate, { clickCount: 3 }); // select all existing text
    await page.keyboard.press("Backspace");
    await page.type(sel.displayDate, dateStr);
    await debugScreenshot(page, "date-filled");

    // 6. Fill body via TinyMCE
    console.log("[FMG] Filling body via TinyMCE");
    await page.waitForFunction(() => typeof window.tinymce !== "undefined" && window.tinymce.editors.length > 0, { timeout: 15000 });
    await page.evaluate((content) => {
      window.tinymce.editors[0].setContent(content);
    }, html);
    await debugScreenshot(page, "body-filled");

    // 7. Upload featured image (non-fatal — continue if upload fails)
    try {
      await uploadFeaturedImage(page, featureImage);
      await debugScreenshot(page, "upload-confirmed");
    } catch (uploadErr) {
      console.warn(`[FMG] Featured image upload failed (continuing): ${uploadErr.message}`);
      await debugScreenshot(page, "upload-failed");
    }

    // 8. Fill summary (max 240 chars)
    if (metaDescription) {
      const summary = metaDescription.slice(0, 240);
      console.log(`[FMG] Filling summary (${summary.length} chars)`);
      await page.fill(sel.summary, summary);
    }
    await debugScreenshot(page, "summary-filled");

    // 9. Fill SEO Title Tag (max 100 chars)
    const seoTitle = title.slice(0, 100);
    console.log(`[FMG] Filling SEO title tag`);
    await page.fill(sel.seoTitle, seoTitle);

    // 10. Fill SEO Description Tag (max 280 chars)
    if (metaDescription) {
      const seoDesc = metaDescription.slice(0, 280);
      console.log(`[FMG] Filling SEO description tag (${seoDesc.length} chars)`);
      await page.fill(sel.seoDescription, seoDesc);
    }
    await debugScreenshot(page, "seo-filled");

    // 11. Disable search engine indexing
    console.log("[FMG] Checking 'Disable search engine indexing' checkbox");
    const indexingCheckbox = page.locator('[data-testid="qa-indexing-checkbox"]');
    await indexingCheckbox.click();
    await debugScreenshot(page, "indexing-disabled");

    // 12. Click Publish
    console.log("[FMG] Clicking Publish");
    await debugScreenshot(page, "before-publish");
    await page.click(sel.publish);

    // 13. Wait for page to settle
    await page.waitForLoadState("networkidle", { timeout: 30000 });

    // 14. Validate submission
    await validateSubmission(page);

    // 15. Final screenshot
    await debugScreenshot(page, "after-publish");

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
