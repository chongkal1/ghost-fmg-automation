const fs = require("fs");
const path = require("path");
const { fetchAllPublishedPosts } = require("./ghost-batch");
const { submitToFMG } = require("./fmg");
const { isFiled, markFiled, getCompliance } = require("./compliance");
const { markPublished } = require("./published");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const RESULTS_FILE = path.join(DATA_DIR, "batch-results.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveResults(results) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

function getLatestResults() {
  if (!fs.existsSync(RESULTS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function runBatchSubmit({ limit = 15 } = {}) {
  const startedAt = new Date().toISOString();
  console.log(`[Batch] Starting batch submit (limit: ${limit})`);

  // 1. Fetch all published posts from Ghost
  const allPosts = await fetchAllPublishedPosts();

  // 2. Filter out already filed posts
  const unfiled = allPosts.filter((post) => !isFiled(post.id, post.title));

  // 3. Sort by publishedAt ascending (oldest first) and take limit
  unfiled.sort((a, b) => {
    const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return dateA - dateB;
  });
  const batch = unfiled.slice(0, limit);

  console.log(`[Batch] Total Ghost posts: ${allPosts.length}`);
  console.log(`[Batch] Already filed: ${allPosts.length - unfiled.length}`);
  console.log(`[Batch] Unfiled: ${unfiled.length}`);
  console.log(`[Batch] Submitting: ${batch.length}`);

  const submitted = [];
  const failed = [];

  for (let i = 0; i < batch.length; i++) {
    const post = batch[i];
    console.log(`\n[Batch] (${i + 1}/${batch.length}) Submitting: "${post.title}"`);

    try {
      await submitToFMG(post);
      markFiled(post.id, post.title);
      markPublished(post.id, post.title);
      submitted.push({ id: post.id, title: post.title });
      console.log(`[Batch] (${i + 1}/${batch.length}) Success: "${post.title}"`);
    } catch (err) {
      console.error(`[Batch] (${i + 1}/${batch.length}) Failed: "${post.title}" — ${err.message}`);
      failed.push({ id: post.id, title: post.title, error: err.message });
    }

    // Pause between submissions (skip after last)
    if (i < batch.length - 1) {
      console.log("[Batch] Waiting 5 seconds...");
      await sleep(5000);
    }
  }

  const results = {
    startedAt,
    completedAt: new Date().toISOString(),
    total: allPosts.length,
    unfiled: unfiled.length,
    submitted,
    failed,
    status: "completed",
  };

  saveResults(results);
  console.log(`\n[Batch] Done. Submitted: ${submitted.length}, Failed: ${failed.length}`);
  return results;
}

module.exports = { runBatchSubmit, getLatestResults };
