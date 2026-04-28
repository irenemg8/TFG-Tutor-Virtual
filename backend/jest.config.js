"use strict";

module.exports = {
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/tests/unit/**/*.test.js",
    "<rootDir>/tests/integration/**/*.test.js",
  ],
  // Smoke + diagnose son scripts CLI antiguos que no son tests Jest.
  testPathIgnorePatterns: ["/node_modules/", "/tests/smoke/", "/tests/diagnose"],
  collectCoverageFrom: [
    "src/domain/**/*.js",
    "!src/domain/**/*.spec.js",
  ],
  coverageDirectory: "<rootDir>/coverage",
  verbose: false,
  // Cargar variables de entorno mínimas para tests que toquen config.
  setupFiles: ["<rootDir>/tests/setupEnv.js"],
};
