const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");
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
 * Download an image URL to a temp file. Returns the local file path.
 */
async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${url}`);

  const contentType = res.headers.get("content-type") || "";
  let ext = ".jpg";
  if (contentType.includes("png")) ext = ".png";
  else if (contentType.includes("webp")) ext = ".webp";
  else if (contentType.includes("gif")) ext = ".gif";

  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpPath = path.join(os.tmpdir(), `fmg-upload-${Date.now()}${ext}`);
  fs.writeFileSync(tmpPath, buffer);
  console.log(`[FMG] Downloaded featured image to ${tmpPath} (${buffer.length} bytes)`);
  return tmpPath;
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
 * Upload a featured image via the FMG file chooser.
 */
async function uploadFeaturedImage(page, imageUrl) {
  if (!imageUrl) {
    console.log("[FMG] No featured image — skipping upload");
    return;
  }

  const sel = config.fmg.selectors;
  let tmpPath;

  try {
    tmpPath = await downloadImage(imageUrl);

    // Set up file chooser listener before clicking the upload button
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10000 }),
      page.click(sel.uploadButton),
    ]);

    await fileChooser.setFiles(tmpPath);
    console.log("[FMG] Featured image uploaded");

    // Wait a moment for the upload to process
    await page.waitForTimeout(2000);
  } finally {
    // Clean up temp file
    if (tmpPath && fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  }
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

    // 6. Upload featured image
    await uploadFeaturedImage(page, featureImage);

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
