const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const PUBLISHED_FILE = path.join(DATA_DIR, "published.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getPublished() {
  ensureDataDir();
  if (!fs.existsSync(PUBLISHED_FILE)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(PUBLISHED_FILE, "utf-8"));
  } catch {
    console.warn("[Published] Corrupted published.json — starting fresh");
    return [];
  }
}

function savePublished(entries) {
  ensureDataDir();
  fs.writeFileSync(PUBLISHED_FILE, JSON.stringify(entries, null, 2));
}

function isPublished(postId, title) {
  const published = getPublished();
  return published.some((p) => p.id === postId || p.title === title);
}

function markPublished(postId, title) {
  const published = getPublished();
  if (published.some((p) => p.id === postId)) {
    return; // already tracked by ID
  }
  published.push({
    id: postId,
    title,
    publishedAt: new Date().toISOString(),
  });
  savePublished(published);
  console.log(`[Published] Tracked: "${title}" (${postId})`);
}

function seedPublished(articles) {
  const existing = getPublished();
  const existingIds = new Set(existing.map((p) => p.id));
  let added = 0;

  for (const article of articles) {
    if (!existingIds.has(article.id)) {
      existing.push({
        id: article.id,
        title: article.title,
        publishedAt: article.publishedAt || new Date().toISOString(),
      });
      added++;
    }
  }

  savePublished(existing);
  return { total: existing.length, added };
}

module.exports = { isPublished, markPublished, seedPublished, getPublished };
