const express = require("express");
const config = require("./config");
const { fetchPost } = require("./ghost");
const { submitToFMG } = require("./fmg");

const app = express();
app.use(express.json());

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/webhook/ghost", async (req, res) => {
  log("Received Ghost webhook");

  try {
    const postId = req.body?.post?.current?.id;

    if (!postId) {
      log("No post ID found in webhook payload");
      return res.status(400).json({ error: "Missing post ID in payload" });
    }

    log(`Processing post ${postId}`);

    const post = await fetchPost(postId);
    await submitToFMG(post);

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
});
