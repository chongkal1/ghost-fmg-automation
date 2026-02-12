require("dotenv").config();

const env = (key) => (process.env[key] || "").trim();

const required = [
  "GHOST_API_URL",
  "GHOST_CONTENT_API_KEY",
  "FMG_LOGIN_URL",
  "FMG_USERNAME",
  "FMG_PASSWORD",
  "FMG_TARGET_URL",
];

for (const key of required) {
  if (!env(key)) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

module.exports = {
  ghost: {
    apiUrl: env("GHOST_API_URL").replace(/\/$/, ""),
    contentApiKey: env("GHOST_CONTENT_API_KEY"),
    webhookSecret: env("GHOST_WEBHOOK_SECRET") || null,
  },
  fmg: {
    loginUrl: env("FMG_LOGIN_URL"),
    username: env("FMG_USERNAME"),
    password: env("FMG_PASSWORD"),
    targetUrl: env("FMG_TARGET_URL"),
    selectors: {
      // Login (two-step)
      username: env("FMG_USERNAME_SELECTOR") || "#txtUsername",
      password: env("FMG_PASSWORD_SELECTOR") || "#txtPassword",
      loginButton: env("FMG_LOGIN_BUTTON_SELECTOR") || "#btnLogin",
      // Blog form
      title: env("FMG_TITLE_SELECTOR") || 'input[name="titleBlog"]',
      displayDate: env("FMG_DATE_SELECTOR") || 'input[name="displayDate"]',
      summary: env("FMG_SUMMARY_SELECTOR") || "textarea#summary",
      seoTitle: env("FMG_SEO_TITLE_SELECTOR") || "input#titleTag",
      seoDescription: env("FMG_SEO_DESC_SELECTOR") || "textarea#descriptionTag",
      uploadButton: env("FMG_UPLOAD_SELECTOR") || 'button[data-test="qa-upload-button"]',
      authorSelect: env("FMG_AUTHOR_SELECTOR") || 'input[name="authorSelectedValue"]',
      publish: env("FMG_PUBLISH_SELECTOR") || 'button[data-testid="qa-action-publish-button"]',
    },
    authorValue: env("FMG_AUTHOR_VALUE") || "9cdb8806-f99d-473f-bc77-96e27fb2da64",
    bodyStrategy: env("FMG_BODY_STRATEGY") || "tinymce",
  },
  port: parseInt(env("PORT"), 10) || 3000,
  headless: env("HEADLESS") !== "false",
};
