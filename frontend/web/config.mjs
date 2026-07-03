const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://syntheticsciences.ai" : `https://${stage}.syntheticsciences.ai`,
  console: stage === "production" ? "https://syntheticsciences.ai/auth" : `https://${stage}.syntheticsciences.ai/auth`,
  email: "contact@syntheticsciences.ai",
  socialCard: "https://syntheticsciences.ai/social-cards",
  github: "https://github.com/synthetic-sciences/OpenScience",
  discord: "https://syntheticsciences.ai/discord",
  headerLinks: [
    { name: "Home", url: "/" },
    { name: "Docs", url: "/docs/" },
  ],
}
