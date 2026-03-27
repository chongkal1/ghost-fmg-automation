#!/usr/bin/env node

/**
 * Seed compliance.json from FMG Suite
 *
 * Logs into FMG, scrapes the blog list, collects all posts with "Published"
 * status (these are already filed to compliance), and matches them against
 * Ghost posts to populate compliance.json.
 *
 * Usage:
 *   node scripts/seed-compliance.js              — seed from FMG
 *   node scripts/seed-compliance.js --dry-run    — preview without writing
 *   node scripts/seed-compliance.js --headed     — run with visible browser
 */

require("dotenv").config();

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

// Set DATA_DIR before requiring compliance module
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = path.join(__dirname, "..", "data");
}

const { seedCompliance, getCompliance } = require("../src/compliance");

const SHOTS = path.join(__dirname, "..", "screenshots", "seed-compliance");
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

const dryRun = process.argv.includes("--dry-run");
const headed = process.argv.includes("--headed");

const loginUrl = process.env.FMG_LOGIN_URL;
const username = process.env.FMG_USERNAME;
const password = process.env.FMG_PASSWORD;
const blogListUrl = process.env.FMG_BLOG_LIST_URL || "https://secure.fmgsuite.com/site/blog/myblogs";

const ghostApiUrl = (process.env.GHOST_API_URL || "").replace(/\/$/, "");
const ghostApiKey = process.env.GHOST_CONTENT_API_KEY || "";

if (!loginUrl || !username || !password) {
  console.error("Missing FMG_LOGIN_URL, FMG_USERNAME, or FMG_PASSWORD in .env");
  process.exit(1);
}

if (!ghostApiUrl || !ghostApiKey) {
  console.error("Missing GHOST_API_URL or GHOST_CONTENT_API_KEY in .env");
  process.exit(1);
}

/**
 * Two-step FMG login (same as dedup-fmg.js).
 */
async function login(page) {
  const userSel = process.env.FMG_USERNAME_SELECTOR || "#txtUsername";
  const passSel = process.env.FMG_PASSWORD_SELECTOR || "#txtPassword";
  const btnSel = process.env.FMG_LOGIN_BUTTON_SELECTOR || "#btnLogin";

  console.log(`[Login] Navigating to ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "load", timeout: 60000 });

  console.log("[Login] Step 1: Filling username");
  await page.fill(userSel, username);
  await page.click(btnSel);

  console.log("[Login] Step 2: Waiting for password field");
  await page.waitForSelector(passSel, { state: "visible", timeout: 15000 });
  await page.fill(passSel, password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: 60000 }),
    page.click(btnSel),
  ]);
  console.log("[Login] Done");
}

/**
 * Scrape current page rows (no navigation).
 */
async function scrapeCurrentRows(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("table tr")).filter(
      (r) => r.querySelectorAll("td").length > 0
    );
    return rows.map((row, i) => {
      const cells = row.querySelectorAll("td");
      // Column order: checkbox(0), Date(1), Title(2), Author(3), Status(4), Actions(5)
      const titleCell = cells[2] || cells[1] || cells[0];
      const title = titleCell?.textContent?.trim() || "";
      const statusCell = cells[4];
      const status = statusCell?.textContent?.trim() || "";
      return { title, status, rowIndex: i };
    }).filter((e) => e.title.length > 0);
  });
}

/**
 * Load all pages via pagination and collect all entries.
 */
async function loadAllPages(page) {
  console.log(`\n[Scrape] Navigating to ${blogListUrl}`);
  await page.goto(blogListUrl, { waitUntil: "load", timeout: 60000 });

  // Wait for spinner to disappear
  console.log("[Scrape] Waiting for data to load...");
  try {
    await page.waitForFunction(() => {
      const spinners = document.querySelectorAll(
        '.MuiCircularProgress-root, [class*="spinner"], [class*="loading"], [role="progressbar"]'
      );
      return spinners.length === 0;
    }, { timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch {
    await page.waitForTimeout(5000);
  }

  // Set rows per page to 50
  try {
    const currentValue = await page.$eval("#demo-simple-select", (el) => el.textContent.trim());
    console.log(`[Scrape] Current rows per page: ${currentValue}`);
    if (currentValue !== "50") {
      await page.click("#demo-simple-select");
      await page.waitForTimeout(500);
      await page.click('li[data-value="50"], li:has-text("50")');
      await page.waitForTimeout(3000);
      console.log("[Scrape] Rows per page set to 50");
    }
  } catch {
    console.log("[Scrape] Could not change rows per page — continuing with default");
  }

  await page.screenshot({ path: path.join(SHOTS, "01-blog-list.png"), fullPage: true });

  let allEntries = [];
  let pageNum = 1;

  while (true) {
    const rows = await scrapeCurrentRows(page);
    console.log(`[Scrape] Page ${pageNum}: ${rows.length} entries`);

    if (rows.length === 0) break;

    const offset = allEntries.length;
    rows.forEach((e) => { e.rowIndex += offset; e.pageNum = pageNum; });
    allEntries.push(...rows);

    await page.screenshot({ path: path.join(SHOTS, `page-${pageNum}.png`), fullPage: true });

    // Click "next page" button
    const hasNext = await page.evaluate(() => {
      const nextBtn = document.querySelector('button.jss41:not([disabled]) .fa-angle-right');
      if (!nextBtn) return false;
      nextBtn.closest("button").scrollIntoView();
      nextBtn.closest("button").click();
      return true;
    });

    if (!hasNext) {
      console.log("[Scrape] No next page — done");
      break;
    }
    pageNum++;
    await page.waitForTimeout(3000);
  }

  console.log(`[Scrape] Total scraped: ${allEntries.length} entries across ${pageNum} page(s)`);
  return allEntries;
}

/**
 * Fetch Ghost posts (id + title) for matching.
 */
async function fetchGhostPosts() {
  const posts = [];
  let page = 1;
  while (true) {
    const url = `${ghostApiUrl}/ghost/api/content/posts/?key=${ghostApiKey}&limit=50&page=${page}&fields=id,title&filter=status:published`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Ghost API error ${res.status}`);
    const data = await res.json();
    if (!data.posts || data.posts.length === 0) break;
    posts.push(...data.posts);
    if (page >= data.meta.pagination.pages) break;
    page++;
  }
  return posts;
}

(async () => {
  console.log("=== Seed Compliance from FMG ===");
  if (dryRun) console.log("MODE: DRY RUN (no changes written)\n");

  const existingCount = getCompliance().length;
  console.log(`Current compliance entries: ${existingCount}`);

  const browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    // 1. Login to FMG
    await login(page);

    // 2. Scrape all blog entries
    console.log("\n--- Scanning FMG blog list ---");
    const allEntries = await loadAllPages(page);

    if (allEntries.length === 0) {
      console.log("\nNo blog entries found.");
      return;
    }

    // 3. All entries on FMG are already filed (Published = approved, In Compliance = pending approval)
    const publishedEntries = allEntries.filter(
      (e) => e.status.toLowerCase().includes("published")
    );
    const inComplianceEntries = allEntries.filter(
      (e) => !e.status.toLowerCase().includes("published")
    );

    console.log(`\nTotal FMG entries: ${allEntries.length}`);
    console.log(`  Published (approved): ${publishedEntries.length}`);
    console.log(`  In Compliance (pending approval): ${inComplianceEntries.length}`);
    console.log(`  All will be marked as filed to prevent re-submission`);

    // 4. Fetch Ghost posts to match by title → get IDs
    console.log("\n--- Fetching Ghost posts for ID matching ---");
    const ghostPosts = await fetchGhostPosts();
    console.log(`Ghost published posts: ${ghostPosts.length}`);

    // Build title→id lookup (case-insensitive)
    const ghostByTitle = new Map();
    for (const gp of ghostPosts) {
      ghostByTitle.set(gp.title.trim().toLowerCase(), gp.id);
    }

    // 5. Match ALL FMG entries to Ghost IDs (both Published and In Compliance)
    const articles = [];
    let matched = 0;
    let unmatched = 0;

    for (const entry of allEntries) {
      const normalized = entry.title.trim().toLowerCase();
      const ghostId = ghostByTitle.get(normalized) || null;

      if (ghostId) {
        matched++;
      } else {
        unmatched++;
        console.log(`  WARNING: No Ghost match for FMG post: "${entry.title}"`);
      }

      articles.push({
        id: ghostId,
        title: entry.title,
        filedAt: new Date().toISOString(),
      });
    }

    console.log(`\nMatched to Ghost: ${matched}`);
    console.log(`No Ghost match (FMG-only): ${unmatched}`);

    if (dryRun) {
      console.log("\n--- DRY RUN: Would seed these entries ---");
      articles.forEach((a) => console.log(`  [${a.id || "no-id"}] ${a.title}`));
      console.log(`\nWould seed ${articles.length} articles.`);
      return;
    }

    // 6. Seed compliance.json
    const result = seedCompliance(articles);
    console.log(`\nSeeded: ${result.added} new articles added (${result.total} total tracked)`);
  } catch (err) {
    console.error("\nFatal error:", err.message);
    await page.screenshot({ path: path.join(SHOTS, "error.png"), fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
