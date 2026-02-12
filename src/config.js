require("dotenv").config();

const required = [
  "GHOST_API_URL",
  "GHOST_CONTENT_API_KEY",
  "FMG_LOGIN_URL",
  "FMG_USERNAME",
  "FMG_PASSWORD",
  "FMG_TARGET_URL",
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

module.exports = {
  ghost: {
    apiUrl: process.env.GHOST_API_URL.replace(/\/$/, ""),
    contentApiKey: process.env.GHOST_CONTENT_API_KEY,
    webhookSecret: process.env.GHOST_WEBHOOK_SECRET || null,
  },
  fmg: {
    loginUrl: process.env.FMG_LOGIN_URL,
    username: process.env.FMG_USERNAME,
    password: process.env.FMG_PASSWORD,
    targetUrl: process.env.FMG_TARGET_URL,
    selectors: {
      // Login (two-step)
      username: process.env.FMG_USERNAME_SELECTOR || "#txtUsername",
      password: process.env.FMG_PASSWORD_SELECTOR || "#txtPassword",
      loginButton: process.env.FMG_LOGIN_BUTTON_SELECTOR || "#btnLogin",
      // Blog form
      title: process.env.FMG_TITLE_SELECTOR || 'input[name="titleBlog"]',
      displayDate: process.env.FMG_DATE_SELECTOR || 'input[name="displayDate"]',
      summary: process.env.FMG_SUMMARY_SELECTOR || "textarea#summary",
      seoTitle: process.env.FMG_SEO_TITLE_SELECTOR || "input#titleTag",
      seoDescription: process.env.FMG_SEO_DESC_SELECTOR || "textarea#descriptionTag",
      uploadButton: process.env.FMG_UPLOAD_SELECTOR || 'button[data-test="qa-upload-button"]',
      publish: process.env.FMG_PUBLISH_SELECTOR || 'button[data-testid="qa-action-publish-button"]',
    },
    bodyStrategy: process.env.FMG_BODY_STRATEGY || "tinymce",
  },
  port: parseInt(process.env.PORT, 10) || 3000,
  headless: process.env.HEADLESS !== "false",
};
