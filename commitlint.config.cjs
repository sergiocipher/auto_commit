// "solutions" is deliberately absent: that scope is reserved for the commits
// the extension writes into the user's solutions repo, never for this project.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "shared",
        "core",
        "extension",
        "adapter-leetcode",
        "adapter-codeforces",
        "adapter-codechef",
        "popup",
        "worker",
        "api",
        "db",
        "queue",
        "docker",
        "github",
        "dedup",
        "security",
        "docs",
        "deps",
        "repo",
      ],
    ],
    "header-max-length": [2, "always", 72],
    "subject-case": [2, "always", "lower-case"],
  },
};
