// Public settings for the Owner View page.
// This is NOT a secret. It's only the address of your Cloudflare Worker,
// which holds the Google API key privately and returns read-only data.
// Leave DATA_URL empty to show demo data.
window.HP_CONFIG = {
  DATA_URL: "https://harbor-pine-data.sammypond.workers.dev", // e.g. "https://harbor-pine-data.YOUR-SUBDOMAIN.workers.dev"
  REFRESH_MS: 60000,
};
