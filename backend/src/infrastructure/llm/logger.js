const fs = require("fs");
const path = require("path");
const config = require("./config");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                         LOGGER                        |
            |  JSON Lines logging for RAG evaluation. Appends one    |
            |  interaction per line to a daily log file.            |
            |                                                       |
            |          -> | ensureLogDir() | -> void                |
            |          -> | getLogPath()   | -> Txt                 |
            |   Obj -> | logInteraction()  | -> void                |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
       ____|________________
      | ensureLogDir() | -> void
       -----------------
      Creates the configured log directory (recursively) if it does
      not already exist.
*/
function ensureLogDir() {
  if (!fs.existsSync(config.LOG_DIR)) {
    fs.mkdirSync(config.LOG_DIR, { recursive: true });
  }
}

/*
       ____|______________
      | getLogPath() | -> Txt
       ---------------
      Returns today's log file path, one "YYYY-MM-DD.jsonl" file per day
      inside the configured log directory.
*/
function getLogPath() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const fileName = year + "-" + month + "-" + day + ".jsonl";
  return path.join(config.LOG_DIR, fileName);
}

/*
   Obj -> ____|__________________
         | logInteraction() | -> void
          -------------------
      Appends one RAG interaction as a JSON line to today's log file.
      Failures are caught and logged to the console, never thrown.
*/
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
