#!/usr/bin/env node

/**
 * Ghost API Connection Tester
 *
 * Usage:
 *   npm run test:ghost              — list 5 most recent posts
 *   npm run test:ghost -- <postId>  — fetch a specific post by ID
 */

require("dotenv").config();

const apiUrl = (process.env.GHOST_API_URL || "").replace(/\/$/, "");
const apiKey = process.env.GHOST_CONTENT_API_KEY || "";

if (!apiUrl || !apiKey) {
  console.error("Missing GHOST_API_URL or GHOST_CONTENT_API_KEY in .env");
  process.exit(1);
}

const postId = process.argv[2];

async function listRecentPosts() {
  const url = `${apiUrl}/ghost/api/content/posts/?key=${apiKey}&limit=5&fields=id,title,slug,published_at`;
  console.log(`Fetching recent posts from ${apiUrl} ...\n`);

  const res = await fetch(url);
  handleHttpError(res);

  const data = await res.json();

  if (!data.posts || data.posts.length === 0) {
    console.log("No posts found. Your Ghost site may be empty.");
    return;
  }

  console.log("Recent posts:");
  console.log("-".repeat(60));
  for (const post of data.posts) {
    const date = post.published_at
      ? new Date(post.published_at).toLocaleDateString()
      : "draft";
    console.log(`  [${date}]  ${post.title}`);
    console.log(`           id: ${post.id}`);
  }
  console.log("-".repeat(60));
  console.log(`\nGhost API connection OK. ${data.posts.length} post(s) returned.`);
}

async function fetchSinglePost(id) {
  const url = `${apiUrl}/ghost/api/content/posts/${id}/?key=${apiKey}&formats=html`;
  console.log(`Fetching post ${id} from ${apiUrl} ...\n`);

  const res = await fetch(url);
  handleHttpError(res);

  const data = await res.json();
  const post = data.posts && data.posts[0];

  if (!post) {
    console.error(`Post with id "${id}" not found.`);
    process.exit(1);
  }

  console.log(`Title: ${post.title}`);
  console.log(`Slug:  ${post.slug}`);
  console.log(`HTML length: ${(post.html || "").length} chars`);
  console.log(`\nFirst 300 chars of HTML:\n${(post.html || "").slice(0, 300)}`);
  console.log("\nGhost API connection OK. Post fetched successfully.");
}

function handleHttpError(res) {
  if (res.ok) return;

  if (res.status === 401 || res.status === 403) {
    console.error(`ERROR ${res.status}: Authentication failed.`);
    console.error("Hint: Double-check GHOST_CONTENT_API_KEY in your .env file.");
    console.error("      You can find it in Ghost Admin > Settings > Integrations.");
  } else if (res.status === 404) {
    console.error(`ERROR 404: Endpoint not found.`);
    console.error("Hint: Verify GHOST_API_URL is correct (e.g. https://your-site.ghost.io).");
  } else {
    console.error(`ERROR ${res.status}: ${res.statusText}`);
  }
  process.exit(1);
}

(postId ? fetchSinglePost(postId) : listRecentPosts()).catch((err) => {
  if (err.cause && err.cause.code === "ENOTFOUND") {
    console.error(`ERROR: Could not resolve hostname.`);
    console.error(`Hint: Check that GHOST_API_URL (${apiUrl}) is correct and reachable.`);
  } else if (err.cause && err.cause.code === "ECONNREFUSED") {
    console.error(`ERROR: Connection refused at ${apiUrl}.`);
    console.error("Hint: Is your Ghost instance running?");
  } else {
    console.error("Unexpected error:", err.message);
  }
  process.exit(1);
});
