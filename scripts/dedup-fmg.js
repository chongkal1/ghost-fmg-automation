#!/usr/bin/env node

/**
 * FMG Blog Deduplicator
 *
 * Logs into FMG, scrapes the blog list, identifies duplicates by title,
 * and deletes all but the oldest copy of each.
 *
 * Usage:
 *   node scripts/dedup-fmg.js              — scan + delete duplicates
 *   node scripts/dedup-fmg.js --dry-run    — scan only, no deletes
 *   node scripts/dedup-fmg.js --headed     — run with visible browser
 */

require("dotenv").config();

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const SHOTS = path.join(__dirname, "..", "screenshots", "dedup");
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
 * Fetch all published post titles from Ghost API.
 */
async function fetchGhostTitles() {
  const titles = [];
  let page = 1;
  while (true) {
    const url = `${ghostApiUrl}/ghost/api/content/posts/?key=${ghostApiKey}&limit=50&page=${page}&fields=title&filter=status:published`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Ghost API error ${res.status}`);
    const data = await res.json();
    if (!data.posts || data.posts.length === 0) break;
    titles.push(...data.posts.map((p) => p.title));
    if (page >= data.meta.pagination.pages) break;
    page++;
  }
  return titles;
}

/**
 * Two-step FMG login (same as main automation).
 */
async function login(page) {
  const userSel = process.env.FMG_USERNAME_SELECTOR || "#txtUsername";
  const passSel = process.env.FMG_PASSWORD_SELECTOR || "#txtPassword";
  const btnSel = process.env.FMG_LOGIN_BUTTON_SELECTOR || "#btnLogin";

  console.log(`[Login] Navigating to ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "load", timeout: 60000 });

  // Step 1: Username
  console.log("[Login] Step 1: Filling username");
  await page.fill(userSel, username);
  await page.click(btnSel);

  // Step 2: Password
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
 * Scrape all blog entries from the FMG blog list page.
 * Returns array of { title, editUrl, deleteButton, rowIndex }.
 *
 * This tries multiple strategies since we don't know the exact DOM structure.
 */
async function scrapeBlogList(page) {
  console.log(`\n[Scrape] Navigating to ${blogListUrl}`);
  await page.goto(blogListUrl, { waitUntil: "load", timeout: 60000 });

  // Wait for spinner to disappear and data to load
  console.log("[Scrape] Waiting for data to load (spinner to disappear)...");
  try {
    // Wait for the loading spinner/indicator to go away
    await page.waitForFunction(() => {
      const spinners = document.querySelectorAll(
        '.MuiCircularProgress-root, [class*="spinner"], [class*="loading"], [role="progressbar"]'
      );
      // Also check for CSS animation-based spinners
      const allElements = document.querySelectorAll('*');
      let animatedSpinner = false;
      for (const el of allElements) {
        const style = window.getComputedStyle(el);
        if (style.animation && style.animation.includes('spin') || style.animation.includes('rotate')) {
          if (el.offsetWidth > 0 && el.offsetWidth < 100) {
            animatedSpinner = true;
            break;
          }
        }
      }
      return spinners.length === 0 && !animatedSpinner;
    }, { timeout: 30000 });
    console.log("[Scrape] Spinner gone");
    // Extra wait for DOM to settle
    await page.waitForTimeout(2000);
  } catch {
    console.log("[Scrape] Spinner wait timed out — continuing with whatever loaded");
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: path.join(SHOTS, "01-blog-list.png"), fullPage: true });

  // Debug: dump table structure
  const debug = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return { hasTable: false };
    const allRows = table.querySelectorAll("tr");
    const rowData = Array.from(allRows).map((r, i) => ({
      index: i,
      cellCount: r.querySelectorAll("td, th").length,
      text: r.textContent?.trim().slice(0, 150),
      html: r.innerHTML?.slice(0, 300),
    }));
    return { hasTable: true, totalRows: allRows.length, rows: rowData };
  });
  console.log(`[Scrape] Debug — table found: ${debug.hasTable}, total rows: ${debug.totalRows || 0}`);
  if (debug.rows) {
    debug.rows.forEach((r) => console.log(`  Row ${r.index} (${r.cellCount} cells): ${r.text}`));
  }

  // Try to find all blog entries — look for table rows or card/list items
  const entries = await page.evaluate(() => {
    const results = [];

    // Strategy 1: Table rows — select all tr with td cells (skip header row with th)
    const rows = Array.from(document.querySelectorAll("table tr")).filter(
      (r) => r.querySelectorAll("td").length > 0
    );
    if (rows.length > 0) {
      rows.forEach((row, i) => {
        const cells = row.querySelectorAll("td");
        // Column order: checkbox(0), Date(1), Title(2), Author(3), Status(4), Actions(5)
        const titleCell = cells[2] || cells[1] || cells[0];
        if (!titleCell) return;

        const title = titleCell.textContent?.trim();
        if (!title) return;

        // Look for edit link
        const editLink = row.querySelector('a[href*="edit"], a[href*="blog"]');
        const editUrl = editLink?.href || "";

        // Look for delete button
        const deleteBtn = row.querySelector(
          'button[data-testid*="delete"], button[aria-label*="delete"], button[aria-label*="Delete"], ' +
          'button.delete, button.btn-danger, [data-testid*="delete"], ' +
          'button[title="Delete"], button[title="delete"]'
        );

        results.push({
          title,
          editUrl,
          hasDeleteBtn: !!deleteBtn,
          rowIndex: i,
          cellCount: cells.length,
          rowText: row.textContent?.trim().slice(0, 200),
        });
      });
      return { strategy: "table", entries: results };
    }

    // Strategy 2: Card/list items
    const cards = document.querySelectorAll(
      '.blog-item, .post-item, [class*="blog"], [class*="post"], ' +
      '.MuiCard-root, .MuiListItem-root, .MuiPaper-root'
    );
    if (cards.length > 0) {
      cards.forEach((card, i) => {
        const titleEl = card.querySelector("h2, h3, h4, .title, [class*='title']");
        const title = titleEl?.textContent?.trim() || card.textContent?.trim().slice(0, 100);
        if (!title) return;

        const editLink = card.querySelector('a[href*="edit"], a[href*="blog"]');
        const deleteBtn = card.querySelector('button[data-testid*="delete"], button.delete, [data-testid*="delete"]');

        results.push({
          title,
          editUrl: editLink?.href || "",
          hasDeleteBtn: !!deleteBtn,
          rowIndex: i,
          rowText: card.textContent?.trim().slice(0, 200),
        });
      });
      return { strategy: "cards", entries: results };
    }

    // Strategy 3: Just dump the page structure for debugging
    const allText = document.body.innerText.slice(0, 5000);
    return { strategy: "unknown", entries: [], pageText: allText };
  });

  console.log(`[Scrape] Strategy used: ${entries.strategy}`);
  console.log(`[Scrape] Found ${entries.entries.length} entries`);

  if (entries.strategy === "unknown") {
    console.log("\n[Scrape] Could not detect blog list structure. Page text preview:");
    console.log(entries.pageText?.slice(0, 1000));
    console.log("\nCheck screenshot at:", path.join(SHOTS, "01-blog-list.png"));
  }

  return entries;
}

/**
 * Identify duplicates using Ghost titles as the reference.
 *
 * Rules:
 * - Only consider FMG posts whose title matches a Ghost post (exact match)
 * - Posts NOT in Ghost are untouched
 * - Never delete a post with status "Published" — only delete "In Compliance"
 * - For each Ghost title: keep 1 copy, delete the rest
 */
function findDuplicates(entries, ghostTitles) {
  // Normalize Ghost titles for matching
  const ghostSet = new Set(ghostTitles.map((t) => t.trim().toLowerCase()));

  // Group FMG entries by normalized title
  const byTitle = new Map();
  let notFromGhost = 0;

  for (const entry of entries) {
    const normalized = entry.title.trim().toLowerCase();
    if (!ghostSet.has(normalized)) {
      notFromGhost++;
      continue; // Not a Ghost post — skip entirely
    }
    if (!byTitle.has(normalized)) {
      byTitle.set(normalized, []);
    }
    byTitle.get(normalized).push(entry);
  }

  console.log(`  FMG posts matching Ghost titles: ${entries.length - notFromGhost}`);
  console.log(`  FMG posts NOT from Ghost (untouched): ${notFromGhost}`);

  const duplicates = [];
  const kept = [];

  for (const [, group] of byTitle) {
    if (group.length <= 1) {
      kept.push(group[0]);
      continue;
    }

    // Sort: "Published" first (protected), then "In Compliance" (deletable)
    const published = group.filter((e) => e.status.toLowerCase().includes("published"));
    const inCompliance = group.filter((e) => !e.status.toLowerCase().includes("published"));

    // Keep: prefer the Published one, otherwise the first In Compliance
    const toKeep = published.length > 0 ? published[0] : inCompliance.shift();
    kept.push(toKeep);

    // Delete: all In Compliance copies except the one we kept
    const toDelete = inCompliance.filter((e) => e !== toKeep);

    // If multiple Published exist, keep all of them (never delete Published)
    if (published.length > 1) {
      console.log(`  WARNING: "${group[0].title}" has ${published.length} Published copies — keeping all`);
      kept.push(...published.slice(1));
    }

    if (toDelete.length > 0) {
      duplicates.push(...toDelete);
      const statuses = group.map((e) => e.status).join(", ");
      console.log(`  "${group[0].title}" — ${group.length} copies [${statuses}] → deleting ${toDelete.length} In Compliance`);
    }
  }

  return { duplicates, kept };
}

/**
 * Delete duplicate entries from FMG.
 * Tries multiple approaches: row-level delete buttons, edit page delete, etc.
 */
async function deleteDuplicates(page, duplicates) {
  console.log(`\n[Delete] Attempting to delete ${duplicates.length} duplicate(s)...`);

  let deleted = 0;
  let failed = 0;

  for (const dupe of duplicates) {
    console.log(`\n[Delete] Removing: "${dupe.title}" (row ${dupe.rowIndex})`);

    try {
      // If we have an edit URL, navigate there and look for a delete button
      if (dupe.editUrl) {
        await page.goto(dupe.editUrl, { waitUntil: "load", timeout: 15000 });
        await page.waitForTimeout(1000);

        // Look for delete button on edit page
        const deleteBtn = await page.$(
          'button[data-testid*="delete"], button[data-testid*="Delete"], ' +
          'button:has-text("Delete"), button:has-text("delete"), ' +
          'button.btn-danger, [data-testid="qa-action-delete-button"]'
        );

        if (deleteBtn) {
          await deleteBtn.click();

          // Handle confirmation dialog
          await page.waitForTimeout(1000);
          const confirmBtn = await page.$(
            'button:has-text("Confirm"), button:has-text("Yes"), button:has-text("OK"), ' +
            'button:has-text("Delete"), button.MuiButton-containedError, ' +
            '[data-testid*="confirm"], [data-testid*="Confirm"]'
          );
          if (confirmBtn) {
            await confirmBtn.click();
            await page.waitForTimeout(2000);
          }

          console.log(`  ✓ Deleted via edit page`);
          deleted++;
          continue;
        }
      }

      // Fallback: go back to list and try row-level delete
      await page.goto(blogListUrl, { waitUntil: "load", timeout: 15000 });
      await page.waitForTimeout(1000);

      // Find the row by title text and click its delete button
      const deletedViaRow = await page.evaluate((title) => {
        const rows = document.querySelectorAll("table tbody tr, .MuiTableBody-root tr");
        for (const row of rows) {
          if (row.textContent?.includes(title)) {
            const btn = row.querySelector(
              'button[data-testid*="delete"], button[aria-label*="delete"], ' +
              'button[aria-label*="Delete"], button.delete, [data-testid*="delete"]'
            );
            if (btn) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      }, dupe.title);

      if (deletedViaRow) {
        // Handle confirmation
        await page.waitForTimeout(1000);
        const confirmBtn = await page.$(
          'button:has-text("Confirm"), button:has-text("Yes"), button:has-text("OK"), ' +
          'button:has-text("Delete"), [data-testid*="confirm"]'
        );
        if (confirmBtn) {
          await confirmBtn.click();
          await page.waitForTimeout(2000);
        }
        console.log(`  ✓ Deleted via row button`);
        deleted++;
      } else {
        console.warn(`  ✗ Could not find delete mechanism for this entry`);
        failed++;
      }
    } catch (err) {
      console.error(`  ✗ Error deleting: ${err.message}`);
      failed++;
    }
  }

  return { deleted, failed };
}

/**
 * Scrape current page rows (no navigation — just reads the current table).
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
      const editLink = row.querySelector('a[href*="edit"], a[href*="blog"]');
      return {
        title,
        status,
        editUrl: editLink?.href || "",
        rowIndex: i,
      };
    }).filter((e) => e.title.length > 0);
  });
}

/**
 * Load all pages via pagination and collect all entries.
 */
async function loadAllPages(page) {
  // First, navigate and wait for data
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

  // Check pagination info
  const paginationInfo = await page.evaluate(() => {
    const body = document.body.innerText;
    // Look for patterns like "1-20 of 96", "Showing 1 to 20 of 96", "Page 1 of 5"
    const match = body.match(/(\d+)\s*[-–]\s*(\d+)\s+of\s+(\d+)/i)
      || body.match(/showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)/i)
      || body.match(/page\s+(\d+)\s+of\s+(\d+)/i);
    return match ? match[0] : null;
  });
  console.log(`[Scrape] Pagination info: ${paginationInfo || "not found"}`);

  // Set rows per page to 50 via MUI Select
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

    // Offset rowIndex for global indexing
    const offset = allEntries.length;
    rows.forEach((e) => { e.rowIndex += offset; e.pageNum = pageNum; });
    allEntries.push(...rows);

    // Screenshot each page
    await page.screenshot({ path: path.join(SHOTS, `page-${pageNum}.png`), fullPage: true });

    // Click "next page" button: button.jss41 with fa-angle-right icon, not disabled
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

    // Wait for new data to load
    await page.waitForTimeout(3000);
  }

  console.log(`[Scrape] Total scraped: ${allEntries.length} entries across ${pageNum} page(s)`);
  return allEntries;
}

(async () => {
  console.log("=== FMG Blog Deduplicator ===");
  if (dryRun) console.log("MODE: DRY RUN (no deletions)\n");

  const browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    // 1. Fetch Ghost titles as reference
    console.log("--- Fetching Ghost posts as reference ---");
    const ghostTitles = await fetchGhostTitles();
    console.log(`Ghost published posts: ${ghostTitles.length}\n`);

    // 2. Login to FMG
    await login(page);

    // 3. Scrape all blog entries (with pagination)
    console.log("\n--- Scanning FMG blog list ---");
    const allEntries = await loadAllPages(page);

    if (allEntries.length === 0) {
      console.log("\nNo blog entries found. Check the blog list URL and screenshot.");
      console.log(`Blog list URL: ${blogListUrl}`);
      await page.screenshot({ path: path.join(SHOTS, "no-entries.png"), fullPage: true });
      return;
    }

    console.log(`\n--- Total FMG blog entries: ${allEntries.length} ---`);
    allEntries.forEach((e) => console.log(`  [${e.rowIndex}] [${e.status}] ${e.title}`));

    // 4. Find duplicates (only Ghost posts, respect Published status)
    console.log("\n--- Duplicate analysis (Ghost-matched only) ---");
    const { duplicates, kept } = findDuplicates(allEntries, ghostTitles);

    if (duplicates.length === 0) {
      console.log("\nNo duplicates found!");
      return;
    }

    console.log(`\nTotal duplicates to remove: ${duplicates.length}`);

    // 4. Delete (unless dry run)
    if (dryRun) {
      console.log("\n--- DRY RUN: Would delete these entries ---");
      duplicates.forEach((d) => console.log(`  [row ${d.rowIndex}] "${d.title}"`));
      console.log(`\nRun without --dry-run to actually delete.`);
    } else {
      const result = await deleteDuplicates(page, duplicates);
      console.log(`\n--- Results ---`);
      console.log(`  Deleted: ${result.deleted}`);
      console.log(`  Failed:  ${result.failed}`);

      // Take final screenshot
      await page.goto(blogListUrl, { waitUntil: "load", timeout: 15000 });
      await page.screenshot({ path: path.join(SHOTS, "99-after-dedup.png"), fullPage: true });
    }
  } catch (err) {
    console.error("\nFatal error:", err.message);
    await page.screenshot({ path: path.join(SHOTS, "error.png"), fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
