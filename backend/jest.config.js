"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                      JEST CONFIG                      |
            |  Jest configuration for the backend test suite. Runs   |
            |  unit and integration tests under tests/, ignores the  |
            |  legacy smoke/diagnose CLI scripts, collects coverage  |
            |  from the domain layer, and loads minimal env vars     |
            |  via tests/setupEnv.js.                                |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
module.exports = {
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/tests/unit/**/*.test.js",
    "<rootDir>/tests/integration/**/*.test.js",
  ],
  testPathIgnorePatterns: ["/node_modules/", "/tests/smoke/", "/tests/diagnose"],
  collectCoverageFrom: [
    "src/domain/**/*.js",
    "!src/domain/**/*.spec.js",
  ],
  coverageDirectory: "<rootDir>/coverage",
  verbose: false,
  setupFiles: ["<rootDir>/tests/setupEnv.js"],
};
