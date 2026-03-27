const express = require("express");
const config = require("./config");
const { fetchPost } = require("./ghost");
const { submitToFMG } = require("./fmg");
const { isPublished, markPublished, seedPublished, getPublished } = require("./published");
const { getCompliance, seedCompliance } = require("./compliance");
const { runBatchSubmit, getLatestResults } = require("./batch-submit");

const app = express();
app.use(express.json({ limit: "10mb" }));

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// List all published articles
app.get("/published", (_req, res) => {
  const published = getPublished();
  res.json({ total: published.length, articles: published });
});

// Seed published articles (for recovery after data loss)
app.post("/published/seed", (req, res) => {
  const articles = req.body?.articles;
  if (!Array.isArray(articles)) {
    return res.status(400).json({ error: "Body must contain an 'articles' array" });
  }
  const result = seedPublished(articles);
  log(`Seeded published list: ${result.added} new, ${result.total} total`);
  res.json(result);
});

// --- Compliance tracking ---
app.get("/compliance", (_req, res) => {
  const compliance = getCompliance();
  res.json({ total: compliance.length, articles: compliance });
});

app.post("/compliance/seed", (req, res) => {
  const articles = req.body?.articles;
  if (!Array.isArray(articles)) {
    return res.status(400).json({ error: "Body must contain an 'articles' array" });
  }
  const result = seedCompliance(articles);
  log(`Seeded compliance list: ${result.added} new, ${result.total} total`);
  res.json(result);
});

// --- Batch submission ---
app.post("/batch-submit", (req, res) => {
  const limit = parseInt(req.query.limit) || 15;
  log(`Batch submit triggered (limit: ${limit})`);

  // Respond immediately, run in background
  res.status(202).json({ status: "started", limit });

  runBatchSubmit({ limit })
    .then((result) => {
      log(`Batch complete: ${result.submitted.length} submitted, ${result.failed.length} failed`);
    })
    .catch((err) => {
      log(`Batch error: ${err.message}`);
      console.error(err);
    });
});

app.get("/batch-status", (_req, res) => {
  const results = getLatestResults();
  if (!results) {
    return res.json({ status: "no_runs" });
  }
  res.json(results);
});

// --- Ghost webhook ---
app.post("/webhook/ghost", async (req, res) => {
  log("Received Ghost webhook");

  try {
    const postId = req.body?.post?.current?.id;

    if (!postId) {
      log("No post ID found in webhook payload");
      return res.status(400).json({ error: "Missing post ID in payload" });
    }

    const postTitle = req.body?.post?.current?.title || "";

    // Duplicate check: by ID or by title
    if (isPublished(postId, postTitle)) {
      log(`SKIP duplicate: "${postTitle}" (${postId})`);
      return res.json({ success: true, skipped: true, reason: "duplicate", title: postTitle });
    }

    log(`Processing post ${postId}`);

    const post = await fetchPost(postId);

    // Second duplicate check after fetch (title might differ from webhook payload)
    if (isPublished(postId, post.title)) {
      log(`SKIP duplicate (post-fetch): "${post.title}" (${postId})`);
      return res.json({ success: true, skipped: true, reason: "duplicate", title: post.title });
    }

    await submitToFMG(post);
    markPublished(postId, post.title);

    log(`Successfully submitted "${post.title}" to FMG Suite`);
    res.json({ success: true, title: post.title });
  } catch (err) {
    log(`Error: ${err.message}`);
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  log(`Server listening on port ${config.port}`);
  log(`Webhook endpoint: POST http://localhost:${config.port}/webhook/ghost`);
  log(`Health check:     GET  http://localhost:${config.port}/health`);
  const published = getPublished();
  log(`Tracked published articles: ${published.length}`);
});
