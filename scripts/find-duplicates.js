#!/usr/bin/env node

/**
 * Find duplicate posts in Ghost by title.
 */
require("dotenv").config();

const apiUrl = (process.env.GHOST_API_URL || "").replace(/\/$/, "");
const apiKey = process.env.GHOST_CONTENT_API_KEY || "";

async function fetchAllPosts() {
  const posts = [];
  let page = 1;

  while (true) {
    const url = `${apiUrl}/ghost/api/content/posts/?key=${apiKey}&limit=50&page=${page}&fields=id,title,slug,published_at,status&filter=status:published&order=published_at desc`;
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
  const posts = await fetchAllPosts();
  console.log(`Total published posts: ${posts.length}\n`);

  // Group by title
  const byTitle = new Map();
  for (const p of posts) {
    const key = p.title.trim();
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(p);
  }

  // Find duplicates
  const dupes = [...byTitle.entries()].filter(([, group]) => group.length > 1);

  if (dupes.length === 0) {
    console.log("No duplicates found.");
    return;
  }

  console.log(`=== ${dupes.length} DUPLICATE TITLES ===\n`);

  let totalExtra = 0;
  for (const [title, group] of dupes) {
    console.log(`"${title}" — ${group.length} copies:`);
    group.forEach((p, i) => {
      const date = p.published_at?.slice(0, 10) || "?";
      const label = i === group.length - 1 ? "KEEP (oldest)" : "DELETE";
      console.log(`  [${date}] id=${p.id} slug=${p.slug} → ${label}`);
    });
    totalExtra += group.length - 1;
    console.log();
  }

  console.log(`--- Summary ---`);
  console.log(`Unique posts: ${byTitle.size}`);
  console.log(`Duplicate copies to remove: ${totalExtra}`);
  console.log(`Posts after cleanup: ${posts.length - totalExtra}`);
})();
