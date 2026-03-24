#!/usr/bin/env node

/**
 * FMG Duplicate Selector — selects duplicates on ALL pages, one page at a time.
 * After selecting on a page, waits for user to delete, then re-run for next page.
 *
 * Pass --page=N to start from a specific page (default: 1).
 * Example: node scripts/select-duplicates.js --page=2
 */

require("dotenv").config();
const { chromium } = require("playwright");

const loginUrl = process.env.FMG_LOGIN_URL;
const username = process.env.FMG_USERNAME;
const password = process.env.FMG_PASSWORD;
const blogListUrl = "https://secure.fmgsuite.com/site/blog/myblogs";
const ghostApiUrl = (process.env.GHOST_API_URL || "").replace(/\/$/, "");
const ghostApiKey = process.env.GHOST_CONTENT_API_KEY || "";

// Parse --page=N argument
const pageArg = process.argv.find((a) => a.startsWith("--page="));
const START_PAGE = pageArg ? parseInt(pageArg.split("=")[1], 10) : 1;

async function fetchGhostTitles() {
  const titles = [];
  let p = 1;
  while (true) {
    const url = `${ghostApiUrl}/ghost/api/content/posts/?key=${ghostApiKey}&limit=50&page=${p}&fields=title&filter=status:published`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Ghost API error ${res.status}`);
    const data = await res.json();
    if (!data.posts || data.posts.length === 0) break;
    titles.push(...data.posts.map((t) => t.title));
    if (p >= data.meta.pagination.pages) break;
    p++;
  }
  return titles;
}

async function login(page) {
  await page.goto(loginUrl, { waitUntil: "load", timeout: 30000 });
  await page.fill(process.env.FMG_USERNAME_SELECTOR || "#txtUsername", username);
  await page.click(process.env.FMG_LOGIN_BUTTON_SELECTOR || "#btnLogin");
  await page.waitForSelector(process.env.FMG_PASSWORD_SELECTOR || "#txtPassword", { state: "visible", timeout: 15000 });
  await page.fill(process.env.FMG_PASSWORD_SELECTOR || "#txtPassword", password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: 30000 }),
    page.click(process.env.FMG_LOGIN_BUTTON_SELECTOR || "#btnLogin"),
  ]);
  console.log("[Login] Done");
}

async function waitForData(page) {
  try {
    await page.waitForFunction(() => !document.querySelector('.MuiCircularProgress-root, [role="progressbar"]'), { timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch { await page.waitForTimeout(5000); }
}

async function setRowsPerPage50(page) {
  try {
    const val = await page.$eval("#demo-simple-select", (el) => el.textContent.trim());
    if (val !== "50") {
      await page.click("#demo-simple-select");
      await page.waitForTimeout(500);
      await page.click('li[data-value="50"], li:has-text("50")');
      await page.waitForTimeout(3000);
      await waitForData(page);
    }
  } catch {}
}

async function clickNextPage(page) {
  return page.evaluate(() => {
    const icon = document.querySelector('button.jss41:not([disabled]) .fa-angle-right');
    if (!icon) return false;
    icon.closest("button").click();
    return true;
  });
}

async function getRows(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("table tr"))
      .filter((r) => r.querySelectorAll("td").length > 0)
      .map((row, i) => {
        const cells = row.querySelectorAll("td");
        return {
          title: (cells[2] || cells[1] || cells[0])?.textContent?.trim() || "",
          status: cells[4]?.textContent?.trim() || "",
          rowIndex: i,
        };
      })
      .filter((e) => e.title.length > 0);
  });
}

(async () => {
  console.log("=== FMG Duplicate Selector ===\n");

  const ghostTitles = await fetchGhostTitles();
  const ghostSet = new Set(ghostTitles.map((t) => t.trim().toLowerCase()));
  console.log(`Ghost posts: ${ghostTitles.length}`);
  console.log(`Starting from page: ${START_PAGE}\n`);

  const browser = await chromium.launch({
    headless: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await login(page);
  await page.goto(blogListUrl, { waitUntil: "load", timeout: 60000 });
  await waitForData(page);
  await setRowsPerPage50(page);

  // Navigate to the target page
  const seenTitles = new Set();
  let currentPage = 1;

  // First pass: scan pages before START_PAGE to build seenTitles
  while (currentPage < START_PAGE) {
    console.log(`Scanning page ${currentPage} (building context)...`);
    const rows = await getRows(page);
    for (const row of rows) {
      const n = row.title.trim().toLowerCase();
      if (!ghostSet.has(n)) continue;
      if (row.status.toLowerCase().includes("published") || !seenTitles.has(n)) {
        seenTitles.add(n);
      }
    }
    const went = await clickNextPage(page);
    if (!went) break;
    currentPage++;
    await page.waitForTimeout(3000);
    await waitForData(page);
  }

  // Now we're on the target page — find and select duplicates
  console.log(`\n--- On page ${currentPage} ---`);
  const rows = await getRows(page);
  console.log(`Rows: ${rows.length}`);

  const toSelect = [];
  for (const row of rows) {
    const n = row.title.trim().toLowerCase();
    if (!ghostSet.has(n)) continue;
    if (row.status.toLowerCase().includes("published")) {
      seenTitles.add(n);
      continue;
    }
    if (!seenTitles.has(n)) {
      seenTitles.add(n);
      continue;
    }
    toSelect.push(row);
  }

  if (toSelect.length === 0) {
    console.log("No duplicates on this page.");
    // Try next pages
    while (true) {
      const went = await clickNextPage(page);
      if (!went) { console.log("No more pages. All clean!"); break; }
      currentPage++;
      await page.waitForTimeout(3000);
      await waitForData(page);

      console.log(`\n--- On page ${currentPage} ---`);
      const nextRows = await getRows(page);
      console.log(`Rows: ${nextRows.length}`);

      const nextSelect = [];
      for (const row of nextRows) {
        const n = row.title.trim().toLowerCase();
        if (!ghostSet.has(n)) continue;
        if (row.status.toLowerCase().includes("published")) { seenTitles.add(n); continue; }
        if (!seenTitles.has(n)) { seenTitles.add(n); continue; }
        nextSelect.push(row);
      }

      if (nextSelect.length > 0) {
        console.log(`\nSelecting ${nextSelect.length} duplicates:\n`);
        nextSelect.forEach((r) => console.log(`  [x] "${r.title}" [${r.status}]`));
        await page.evaluate((idxs) => {
          const trs = Array.from(document.querySelectorAll("table tr")).filter((r) => r.querySelectorAll("td").length > 0);
          for (const i of idxs) { const cb = trs[i]?.querySelector('input[type="checkbox"]'); if (cb && !cb.checked) cb.click(); }
        }, nextSelect.map((r) => r.rowIndex));
        console.log(`\n>>> Selected! Click "Delete Post" in browser.`);
        console.log(`>>> Then re-run: node scripts/select-duplicates.js --page=${currentPage}`);
        break;
      }
    }
  } else {
    console.log(`\nSelecting ${toSelect.length} duplicates:\n`);
    toSelect.forEach((r) => console.log(`  [x] "${r.title}" [${r.status}]`));
    await page.evaluate((idxs) => {
      const trs = Array.from(document.querySelectorAll("table tr")).filter((r) => r.querySelectorAll("td").length > 0);
      for (const i of idxs) { const cb = trs[i]?.querySelector('input[type="checkbox"]'); if (cb && !cb.checked) cb.click(); }
    }, toSelect.map((r) => r.rowIndex));
    console.log(`\n>>> Selected! Click "Delete Post" in browser.`);
    console.log(`>>> Then re-run: node scripts/select-duplicates.js --page=${currentPage}`);
  }

  console.log("\nBrowser stays open. Ctrl+C when done.");
  await new Promise(() => {});
})();
