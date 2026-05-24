// JSON Lines logging for RAG evaluation

const fs = require("fs");
const path = require("path");
const config = require("./config");

// Make sure the log directory exists
function ensureLogDir() {
  if (!fs.existsSync(config.LOG_DIR)) {
    fs.mkdirSync(config.LOG_DIR, { recursive: true });
  }
}

// Get today's log file path (one file per day)
function getLogPath() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const fileName = year + "-" + month + "-" + day + ".jsonl";
  return path.join(config.LOG_DIR, fileName);
}

// Log one RAG interaction as a JSON line
function logInteraction(data) {
  try {
    ensureLogDir();

    const entry = {
      timestamp: new Date().toISOString(),
      exerciseNum: data.exerciseNum,
      userId: data.userId,
      classification: data.classification,
      decision: data.decision,
      query: data.query,
      retrievedDocs: data.retrievedDocs || [],
      augmentation: data.augmentation || "",
      response: data.response || "",
      guardrailTriggered: data.guardrailTriggered || false,
      correctAnswer: data.correctAnswer || [],
      timing: data.timing || {},
    };

    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(getLogPath(), line, "utf-8");
  } catch (err) {
    console.error("RAG logger error:", err.message);
  }
}

module.exports = { logInteraction };
