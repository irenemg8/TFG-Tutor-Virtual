"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                        SETUP ENV                      |
            |  Safe defaults for the unit tests. Does not read the   |
            |  real .env; every variable the code consults gets a    |
            |  minimal value here so tests run in isolation.         |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
process.env.NODE_ENV = "test";
process.env.DATABASE_TYPE = process.env.DATABASE_TYPE || "postgresql";
process.env.LLM_MODE = process.env.LLM_MODE || "local";
process.env.OLLAMA_API_URL_LOCAL = process.env.OLLAMA_API_URL_LOCAL || "http://127.0.0.1:11434";
process.env.OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:latest";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-do-not-use";
