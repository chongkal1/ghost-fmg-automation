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
      username: process.env.FMG_USERNAME_SELECTOR || "#username",
      password: process.env.FMG_PASSWORD_SELECTOR || "#password",
      loginButton: process.env.FMG_LOGIN_BUTTON_SELECTOR || 'button[type="submit"]',
      title: process.env.FMG_TITLE_SELECTOR || "#title",
      body: process.env.FMG_BODY_SELECTOR || "#body",
      submit: process.env.FMG_SUBMIT_SELECTOR || 'button[type="submit"]',
      success: process.env.FMG_SUCCESS_SELECTOR || "",
      error: process.env.FMG_ERROR_SELECTOR || "",
    },
    bodyStrategy: process.env.FMG_BODY_STRATEGY || "auto",
  },
  port: parseInt(process.env.PORT, 10) || 3000,
  headless: process.env.HEADLESS !== "false",
};
