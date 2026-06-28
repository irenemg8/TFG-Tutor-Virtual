/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       TESTCHAT 4                      |
            |  Standalone test driver that POSTs a list of student  |
            |  answers to the backend /api/ollama/chat/start-exercise|
            |  endpoint, opening one new chat per question, and      |
            |  saves the responses as JSON under test_conversations/.|
            |                                                       |
   Txt,Txt,Txt -> | startChat() | -> Promise<Obj>                   |
        Txt,Txt -> | sendMessage() | -> Promise<Obj>                |
   Txt,Obj,Txt -> | saveConversation() | -> Promise<void>          |
            | runTestConversation() | -> Promise<void>             |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const BACKEND_URL = process.env.VITE_BACKEND_URL || "http://localhost:9000";
const MOCK_USER_ID = "681cd8217918fbc4fc7a626f";

const TEST_EXERCISE_IDS = [
  "6832f72534ce3d55267f86d0"
];
const titulo = [
  "Ejercicio 4"
]

const QUESTIONS = [
  "R1, R2 y R3 porque son las resistencias que forman parte del circuito",
  "R1, R2 y R3 porque están conectadas a la fuente de tensión",
  "R1, R2 y R3 porque están conectadas en paralelo",
  "R1, R2 y R3 porque están conectadas en serie",
  "R1 y R2 porque son las resistencias por las que pasa corriente",
  "R1 y R2 porque están conectadas en paralelo con la fuente",
  "R1 y R2 porque podemos eliminar R3 ya que está en circuito abierto",
  "R1 y R2",
  "R1 y R2 porque R3 se elimina",
  "R1 porque está conectada en paralelo con la fuente",
  "R2 porque R1 se puede quitar al estar en paralelo con la fuente y R3 se puede quitar al estar encircuito abierto",
  "R2 y R3 porque R1 se puede quitar al estar en paralelo con la fuente",
  "R3 porque R1 y R2 se pueden quitar al estar en paraleo con la fuente",
  "R1 y R2 porque están conectadas en serie con la fuente"
];

const CONVERSATION_LOG_DIR = path.join(__dirname, 'test_conversations');

/*
   Txt,Txt,Txt -> ____|____________
                 | startChat() | -> Promise<Obj>
                  -------------
      Opens a new exercise chat by POSTing the initial student message
      to /api/ollama/chat/start-exercise and returns the response data.
*/
async function startChat(userId, exerciseId, initialMessage) {
  try {
    console.log(`Starting new chat for exercise ${exerciseId} with message: "${initialMessage}"`);
    const response = await axios.post(`${BACKEND_URL}/api/ollama/chat/start-exercise`, {
      userId: userId,
      exerciseId: exerciseId,
      userMessage: initialMessage
    });
    console.log("Chat started successfully! ✅");
    return response.data;
  } catch (error) {
    console.error("Error starting chat:");
    if (error.response) {
      console.error("  Response status:", error.response.status);
      console.error("  Response data:", error.response.data);
    } else if (error.request) {
      console.error("  No response received. Possible backend/Ollama timeout or connection issue.");
      console.error("  Request details (partial):", error.request.path, error.request.method, error.request._options?.port);
    } else {
      console.error("  Error message:", error.message);
    }
    throw error;
  }
}

/*
   Txt,Txt -> ____|______________
             | sendMessage() | -> Promise<Obj>
              ---------------
      Sends a follow-up message to an existing interaction via
      /api/ollama/chat/message. Kept for potential future reuse.
*/
async function sendMessage(interaccionId, userMessage) {
  try {
    console.log(`Sending message to interaction ${interaccionId}: "${userMessage}"`);
    const response = await axios.post(`${BACKEND_URL}/api/ollama/chat/message`, {
      interaccionId: interaccionId,
      userMessage: userMessage
    });
    console.log("Message sent and conversation updated. ✅");
    return response.data;
  } catch (error) {
    console.error("Error sending message:");
    if (error.response) {
      console.error("  Response status:", error.response.status);
      console.error("  Response data:", error.response.data);
    } else if (error.request) {
      console.error("  No response received. Possible backend/Ollama timeout or connection issue.");
      console.error("  Request details (partial):", error.request.path, error.request.method, error.request._options?.port);
    } else {
      console.error("  Error message:", error.message);
    }
    throw error;
  }
}

/*
   Txt,Obj,Txt -> ____|___________________
                 | saveConversation() | -> Promise<void>
                  --------------------
      Ensures the log directory exists and writes the conversation data
      as pretty-printed JSON to the given filename under it.
*/
async function saveConversation(exerciseId, conversationData, filename) {
  if (!fs.existsSync(CONVERSATION_LOG_DIR)) {
    fs.mkdirSync(CONVERSATION_LOG_DIR);
  }
  const filePath = path.join(CONVERSATION_LOG_DIR, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(conversationData, null, 2));
    console.log(`Conversation log for exercise ${exerciseId} saved to ${filePath}`);
  } catch (error) {
    console.error("Error saving conversation to file:", error);
  }
}

/*
       ____|________________________
      | runTestConversation() | -> Promise<void>
       -----------------------
      Drives the test: for every exercise id, sends each question as a
      fresh chat, collects the responses and saves them to a JSON log.
*/
async function runTestConversation() {
  const allTestResults = {};

  for (const exerciseId of TEST_EXERCISE_IDS) {
    console.log(`\n==== Testing Exercise ID: ${exerciseId} ====`);
    allTestResults[exerciseId] = [];

    for (let i = 0; i < QUESTIONS.length; i++) {
      const question = QUESTIONS[i];
      try {
        const responseData = await startChat(MOCK_USER_ID, exerciseId, question);

        allTestResults[exerciseId].push({
          turn_number: i + 1,
          user_message: question,
          assistant_response: responseData.initialMessage
        });

      } catch (error) {
        console.error(`ERROR: Fallo al procesar la pregunta "${question}" para el ejercicio ${exerciseId}.`);
        allTestResults[exerciseId].push({
          turn_number: i + 1,
          user_message: question,
          status: "FAILED",
          error: error.message || "Error desconocido al iniciar el chat para esta pregunta."
        });
      }
    }
    const fileName = `sinenunc_${titulo}_${exerciseId}}new_chats.json`;
    await saveConversation(exerciseId, allTestResults[exerciseId], fileName);
  }

  console.log("\n==== All Test Conversations Completed ====");
}

runTestConversation();