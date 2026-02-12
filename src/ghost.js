const config = require("./config");

async function fetchPost(postId) {
  const url = `${config.ghost.apiUrl}/ghost/api/content/posts/${postId}/?key=${config.ghost.contentApiKey}&formats=html&include=authors`;

  console.log(`[Ghost] Fetching post ${postId}`);

  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ghost API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const post = data.posts[0];

  if (!post) {
    throw new Error(`Post ${postId} not found`);
  }

  console.log(`[Ghost] Fetched: "${post.title}"`);

  const summary = post.meta_description || post.custom_excerpt || "";

  return {
    title: post.title,
    html: post.html,
    featureImage: post.feature_image || null,
    publishedAt: post.published_at || null,
    metaDescription: summary,
  };
}

module.exports = { fetchPost };
