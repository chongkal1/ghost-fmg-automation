const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const COMPLIANCE_FILE = path.join(DATA_DIR, "compliance.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getCompliance() {
  ensureDataDir();
  if (!fs.existsSync(COMPLIANCE_FILE)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(COMPLIANCE_FILE, "utf-8"));
  } catch {
    console.warn("[Compliance] Corrupted compliance.json — starting fresh");
    return [];
  }
}

function saveCompliance(entries) {
  ensureDataDir();
  fs.writeFileSync(COMPLIANCE_FILE, JSON.stringify(entries, null, 2));
}

function isFiled(postId, title) {
  const compliance = getCompliance();
  return compliance.some((p) => p.id === postId || p.title === title);
}

function markFiled(postId, title) {
  const compliance = getCompliance();
  if (compliance.some((p) => p.id === postId)) {
    return; // already tracked by ID
  }
  compliance.push({
    id: postId,
    title,
    filedAt: new Date().toISOString(),
  });
  saveCompliance(compliance);
  console.log(`[Compliance] Tracked: "${title}" (${postId})`);
}

function seedCompliance(articles) {
  const existing = getCompliance();
  const existingIds = new Set(existing.map((p) => p.id));
  const existingTitles = new Set(existing.map((p) => p.title?.toLowerCase()));
  let added = 0;

  for (const article of articles) {
    const isDupeId = article.id && existingIds.has(article.id);
    const isDupeTitle = article.title && existingTitles.has(article.title.toLowerCase());
    if (!isDupeId && !isDupeTitle) {
      existing.push({
        id: article.id || null,
        title: article.title,
        filedAt: article.filedAt || new Date().toISOString(),
      });
      if (article.id) existingIds.add(article.id);
      if (article.title) existingTitles.add(article.title.toLowerCase());
      added++;
    }
  }

  saveCompliance(existing);
  return { total: existing.length, added };
}

module.exports = { getCompliance, isFiled, markFiled, seedCompliance };
