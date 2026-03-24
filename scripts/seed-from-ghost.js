#!/usr/bin/env node

/**
 * Seed published.json from Ghost CMS
 *
 * Fetches all published posts from Ghost and writes them to the
 * published articles tracker so they won't be re-submitted to FMG.
 *
 * Usage:
 *   node scripts/seed-from-ghost.js              — seed from Ghost
 *   node scripts/seed-from-ghost.js --dry-run    — preview without writing
 */

require("dotenv").config();

const path = require("path");

// Set DATA_DIR before requiring published module
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = path.join(__dirname, "..", "data");
}

const { seedPublished, getPublished } = require("../src/published");

const apiUrl = (process.env.GHOST_API_URL || "").replace(/\/$/, "");
const apiKey = process.env.GHOST_CONTENT_API_KEY || "";
const dryRun = process.argv.includes("--dry-run");

if (!apiUrl || !apiKey) {
  console.error("Missing GHOST_API_URL or GHOST_CONTENT_API_KEY in .env");
  process.exit(1);
}

async function fetchAllPosts() {
  const posts = [];
  let page = 1;
  const limit = 50;

  while (true) {
    const url = `${apiUrl}/ghost/api/content/posts/?key=${apiKey}&limit=${limit}&page=${page}&fields=id,title,published_at&filter=status:published&order=published_at desc`;
    console.log(`Fetching page ${page}...`);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Ghost API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    if (!data.posts || data.posts.length === 0) break;

    posts.push(...data.posts);
    console.log(`  Got ${data.posts.length} posts (total: ${posts.length})`);

    // Check if there are more pages
    if (data.meta?.pagination?.pages && page >= data.meta.pagination.pages) break;
    page++;
  }

  return posts;
}

(async () => {
  try {
    const existingCount = getPublished().length;
    console.log(`\nCurrent tracked articles: ${existingCount}`);

    const posts = await fetchAllPosts();
    console.log(`\nTotal published posts in Ghost: ${posts.length}`);

    if (posts.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const articles = posts.map((p) => ({
      id: p.id,
      title: p.title,
      publishedAt: p.published_at,
    }));

    if (dryRun) {
      console.log("\n--- DRY RUN (no changes written) ---");
      articles.forEach((a) => console.log(`  [${a.publishedAt?.slice(0, 10) || "?"}] ${a.title}`));
      console.log(`\nWould seed ${articles.length} articles.`);
      return;
    }

    const result = seedPublished(articles);
    console.log(`\nSeeded: ${result.added} new articles added (${result.total} total tracked)`);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
})();
