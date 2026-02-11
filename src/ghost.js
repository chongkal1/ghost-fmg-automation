const config = require("./config");

async function fetchPost(postId) {
  const url = `${config.ghost.apiUrl}/ghost/api/content/posts/${postId}/?key=${config.ghost.contentApiKey}&formats=html`;

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

  return { title: post.title, html: post.html };
}

module.exports = { fetchPost };
