const config = require("./config");

/**
 * Fetch all published posts from Ghost with full content data.
 * Returns array of posts in the shape submitToFMG() expects.
 */
async function fetchAllPublishedPosts() {
  const baseUrl = config.ghost.apiUrl;
  const key = config.ghost.contentApiKey;
  const posts = [];
  let page = 1;

  while (true) {
    const url = `${baseUrl}/ghost/api/content/posts/?key=${key}&limit=50&page=${page}&formats=html&include=authors&filter=status:published`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Ghost API error ${res.status}`);
    const data = await res.json();
    if (!data.posts || data.posts.length === 0) break;

    for (const post of data.posts) {
      posts.push({
        id: post.id,
        title: post.title,
        html: post.html,
        featureImage: post.feature_image || null,
        publishedAt: post.published_at || null,
        metaDescription: post.meta_description || post.custom_excerpt || "",
      });
    }

    if (page >= data.meta.pagination.pages) break;
    page++;
  }

  console.log(`[Ghost-Batch] Fetched ${posts.length} published posts`);
  return posts;
}

module.exports = { fetchAllPublishedPosts };
