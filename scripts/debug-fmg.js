#!/usr/bin/env node

/**
 * FMG Suite Selector Discovery Tool
 *
 * Launches a visible browser and pauses at each step so you can inspect
 * the page with DevTools and find the correct CSS selectors.
 *
 * Usage:  npm run debug:fmg
 *
 * At each pause:
 *   1. Right-click an element > "Inspect" to see its selector
 *   2. Update your .env file with the correct selectors
 *   3. Click "Resume" in the Playwright inspector bar to continue
 */

require("dotenv").config();

const { chromium } = require("playwright");

const loginUrl = process.env.FMG_LOGIN_URL;
const username = process.env.FMG_USERNAME;
const password = process.env.FMG_PASSWORD;
const targetUrl = process.env.FMG_TARGET_URL;

if (!loginUrl || !username || !password || !targetUrl) {
  console.error(
    "Missing required env vars: FMG_LOGIN_URL, FMG_USERNAME, FMG_PASSWORD, FMG_TARGET_URL"
  );
  console.error("Fill in your .env file first, then re-run.");
  process.exit(1);
}

const selectors = {
  username: process.env.FMG_USERNAME_SELECTOR || "#username",
  password: process.env.FMG_PASSWORD_SELECTOR || "#password",
  loginButton: process.env.FMG_LOGIN_BUTTON_SELECTOR || 'button[type="submit"]',
  title: process.env.FMG_TITLE_SELECTOR || "#title",
  body: process.env.FMG_BODY_SELECTOR || "#body",
  submit: process.env.FMG_SUBMIT_SELECTOR || 'button[type="submit"]',
};

async function detectRichTextEditors(page) {
  console.log("\n--- Rich Text Editor Detection ---");

  const results = await page.evaluate(() => {
    const found = [];

    // TinyMCE
    if (typeof window.tinymce !== "undefined" && window.tinymce.editors.length > 0) {
      found.push({
        type: "TinyMCE",
        count: window.tinymce.editors.length,
        ids: window.tinymce.editors.map((e) => e.id),
      });
    }

    // CKEditor 4
    if (typeof window.CKEDITOR !== "undefined" && window.CKEDITOR.instances) {
      const names = Object.keys(window.CKEDITOR.instances);
      if (names.length > 0) {
        found.push({ type: "CKEditor 4", count: names.length, ids: names });
      }
    }

    // CKEditor 5 — look for .ck-editor elements
    const ck5 = document.querySelectorAll(".ck-editor");
    if (ck5.length > 0) {
      found.push({ type: "CKEditor 5", count: ck5.length, ids: [] });
    }

    // contenteditable elements (excluding body itself)
    const editables = document.querySelectorAll('[contenteditable="true"]');
    const filtered = Array.from(editables).filter((el) => el.tagName !== "BODY");
    if (filtered.length > 0) {
      found.push({
        type: "contenteditable",
        count: filtered.length,
        ids: filtered.map(
          (el) => el.id || el.className.split(" ").slice(0, 2).join(".")
        ),
      });
    }

    // Iframes that might contain editors
    const iframes = document.querySelectorAll("iframe");
    const editorIframes = Array.from(iframes).filter((f) => {
      const src = f.src || "";
      const id = f.id || "";
      return /editor|mce|cke|tiny|wysiwyg/i.test(src + id + f.className);
    });
    if (editorIframes.length > 0) {
      found.push({
        type: "editor iframe",
        count: editorIframes.length,
        ids: editorIframes.map((f) => f.id || f.src),
      });
    }

    return found;
  });

  if (results.length === 0) {
    console.log("  No rich text editors detected.");
    console.log("  The body field may be a plain <textarea> or <input>.");
    console.log('  Recommended: FMG_BODY_STRATEGY=plain');
  } else {
    for (const r of results) {
      console.log(`  Found: ${r.type} (${r.count} instance(s))`);
      if (r.ids.length > 0) {
        console.log(`         IDs: ${r.ids.join(", ")}`);
      }
    }
    const mainType = results[0].type.toLowerCase();
    if (mainType.includes("tinymce")) {
      console.log('  Recommended: FMG_BODY_STRATEGY=tinymce');
    } else if (mainType.includes("ckeditor")) {
      console.log('  Recommended: FMG_BODY_STRATEGY=ckeditor');
    } else if (mainType.includes("contenteditable")) {
      console.log('  Recommended: FMG_BODY_STRATEGY=contenteditable');
    }
  }
  console.log("-----------------------------------\n");
}

(async () => {
  console.log("Launching browser in headed mode...\n");

  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const page = await browser.newPage();

  // --- STEP 1: Login page ---
  console.log(`STEP 1: Navigating to login page: ${loginUrl}`);
  console.log("  Inspect the page to find the username, password, and login button selectors.");
  console.log("  Current selectors in .env:");
  console.log(`    FMG_USERNAME_SELECTOR     = ${selectors.username}`);
  console.log(`    FMG_PASSWORD_SELECTOR     = ${selectors.password}`);
  console.log(`    FMG_LOGIN_BUTTON_SELECTOR = ${selectors.loginButton}`);
  console.log('  Click "Resume" in the Playwright bar when ready.\n');

  await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.pause();

  // --- STEP 2: Attempt login ---
  console.log("STEP 2: Attempting login with current selectors...");
  try {
    await page.fill(selectors.username, username);
    await page.fill(selectors.password, password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {}),
      page.click(selectors.loginButton),
    ]);
    console.log("  Login submitted. Check if you're now logged in.");
  } catch (err) {
    console.error(`  Login attempt failed: ${err.message}`);
    console.error("  The selectors are probably wrong. Update .env and re-run.");
  }
  console.log('  Click "Resume" to continue.\n');
  await page.pause();

  // --- STEP 3: Submission page ---
  console.log(`STEP 3: Navigating to submission page: ${targetUrl}`);
  console.log("  Inspect the page to find the title, body, and submit button selectors.");
  console.log("  Current selectors in .env:");
  console.log(`    FMG_TITLE_SELECTOR  = ${selectors.title}`);
  console.log(`    FMG_BODY_SELECTOR   = ${selectors.body}`);
  console.log(`    FMG_SUBMIT_SELECTOR = ${selectors.submit}`);
  console.log('  Click "Resume" when done inspecting.\n');

  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });
  await detectRichTextEditors(page);
  await page.pause();

  console.log("Debug session complete. Update your .env with the correct selectors and re-run.");
  await browser.close();
})();
