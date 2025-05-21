import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch"; // For /token endpoint

import { createClient } from "@supabase/supabase-js";

// --- Environment Variable Checks and Initialization ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("FATAL: Missing Supabase URL or Service Role Key in .env file.");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;
const assistantId = process.env.OPENAI_ASSISTANT_ID;
const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID; // Optional

const fallbackReplyMinLength = parseInt(process.env.FALLBACK_REPLY_MIN_LENGTH || "20", 10);
const speechReplyMinLength = parseInt(process.env.SPEECH_REPLY_MIN_LENGTH || "10", 10);
const fallbackStrategy = process.env.FALLBACK_STRATEGY || "RETRY_NO_ADDITIONAL_PROMPT";
const fallbackClarificationPrompt = process.env.FALLBACK_CLARIFICATION_PROMPT || "The previous answer was not detailed enough. Please try again.";
const voiceModel = process.env.VOICE_MODEL || "tts-1";
const voiceName = process.env.VOICE_NAME || "alloy"; // Changed default to a common one, "verse" may not exist or might be specific.

// For /token endpoint (can be moved to .env)
const realtimeSessionModel = process.env.REALTIME_MODEL || "gpt-4o-mini-realtime-preview";
const realtimeSessionVoice = process.env.REALTIME_VOICE || "alloy";


if (!apiKey || !assistantId) {
  console.error("FATAL: Missing required OpenAI API Key (OPENAI_API_KEY) or Assistant ID (OPENAI_ASSISTANT_ID) in .env file.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey });
const app = express();
app.use(express.json());

// --- Helper Functions ---

/**
 * Retrieves an existing OpenAI thread ID for a user from Supabase,
 * or creates a new thread and stores its ID in Supabase.
 * Assumes a Supabase table 'user_threads' with columns: 'user_id' (text) and 'thread_id' (text).
 */
async function getOrCreateThreadId(userId) {
  const tableName = process.env.SUPABASE_THREAD_TABLE || 'user_threads';
  
  // 1. Check Supabase for an existing thread_id
  const { data: existingThread, error: selectError } = await supabase
    .from(tableName)
    .select('thread_id')
    .eq('user_id', userId)
    .maybeSingle(); // Use .maybeSingle() to handle 0 or 1 row without error for 0 rows

  if (selectError) {
    console.error(`Error fetching thread ID for user ${userId} from Supabase:`, selectError);
    throw new Error('Could not retrieve thread ID from database due to a query error.');
  }

  if (existingThread && existingThread.thread_id) {
    try {
      // Verify thread exists on OpenAI's side before returning
      await openai.beta.threads.retrieve(existingThread.thread_id);
      console.log(`Using existing thread ID for user ${userId}: ${existingThread.thread_id}`);
      return existingThread.thread_id;
    } catch (openAiError) {
      console.warn(`Thread ${existingThread.thread_id} for user ${userId} not found on OpenAI (Error: ${openAiError.message}). A new thread will be created.`);
      // Optionally, delete the stale record from Supabase
      // await supabase.from(tableName).delete().eq('thread_id', existingThread.thread_id);
    }
  }

  // 2. If not found or stale, create a new OpenAI thread
  console.log(`Creating a new OpenAI thread for user ${userId}.`);
  const newThread = await openai.beta.threads.create({
    metadata: { user_id: userId }
  });

  // 3. Store the new thread_id in Supabase
  // Upsert to handle cases where the thread was stale and we want to update it,
  // or if a race condition occurred (though user_id should ideally be unique).
  const { error: upsertError } = await supabase
    .from(tableName)
    .upsert({ user_id: userId, thread_id: newThread.id }, { onConflict: 'user_id' });

  if (upsertError) {
  console.error("❌ Supabase upsert error:", upsertError);
} else {
  console.log("✅ Supabase thread saved:", { user_id: userId, thread_id: newThread.id });
}

  
  console.log(`Created and stored new thread ID for user ${userId}: ${newThread.id}`);
  return newThread.id;
}

/**
 * Waits for an OpenAI run to complete.
 * Handles 'requires_action' by submitting empty tool outputs if no specific tool logic is implemented.
 * WARNING: Submitting empty tool_outputs for functions expecting actual output is problematic.
 * This function should be enhanced if your assistant uses custom tools that require output.
 */
async function waitForRunCompletion(threadId, runId, openaiInstance) {
  let runStatus = await openaiInstance.beta.threads.runs.retrieve(threadId, runId);
  const startTime = Date.now();
  const timeoutMs = 60000; // 60-second timeout for the run

  while (["queued", "in_progress", "requires_action"].includes(runStatus.status)) {
    if (Date.now() - startTime > timeoutMs) {
        console.error(`Run ${runId} timed out after ${timeoutMs / 1000} seconds.`);
        // Attempt to cancel the run
        try {
            await openaiInstance.beta.threads.runs.cancel(threadId, runId);
            console.log(`Attempted to cancel run ${runId}.`);
        } catch (cancelError) {
            console.error(`Failed to cancel run ${runId}:`, cancelError);
        }
        throw new Error(`Run ${runId} timed out.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Poll every 1 second
    runStatus = await openaiInstance.beta.threads.runs.retrieve(threadId, runId);

    if (runStatus.status === "requires_action" && runStatus.required_action?.type === "submit_tool_outputs") {
      const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        //
        // TODO: Implement actual tool call execution here if your assistant uses function tools.
        // Example:
        // const toolOutputs = await Promise.all(toolCalls.map(async (toolCall) => {
        //   if (toolCall.type === 'function') {
        //     const functionName = toolCall.function.name;
        //     const args = JSON.parse(toolCall.function.arguments);
        //     // const output = await yourFunctionHandler(functionName, args);
        //     // return { tool_call_id: toolCall.id, output: JSON.stringify(output) };
        //   }
        //   return { tool_call_id: toolCall.id, output: "" }; // Default empty for unhandled
        // }));
        //
        console.warn(`Run ${runId} in thread ${threadId} requires action for tool calls:`, JSON.stringify(toolCalls));
        console.warn("CRITICAL: Submitting EMPTY tool outputs. This is a placeholder. Implement tool logic if assistant uses function tools.");
        await openaiInstance.beta.threads.runs.submitToolOutputs(threadId, runId, {
          tool_outputs: [] // Replace with actual toolOutputs if you implement them
        });
      } else {
        // No specific tool_calls, but still requires_action. Submit empty as a generic handler.
         await openaiInstance.beta.threads.runs.submitToolOutputs(threadId, runId, { tool_outputs: [] });
      }
    }
  }

  if (["failed", "expired", "cancelled"].includes(runStatus.status)) {
    const errorMessage = runStatus.last_error ? runStatus.last_error.message : `Run ${runStatus.status}`;
    console.error(`Run ${runId} in thread ${threadId} ${runStatus.status}. Error: ${errorMessage}`, runStatus.last_error);
    throw new Error(errorMessage);
  }
  return runStatus;
}

/**
 * Creates an OpenAI run, waits for its completion, and retrieves the latest assistant reply.
 */
async function createRunAndGetReply(threadId, currentAssistantId, currentUserId, openaiInstance, runOptions = {}, isFallbackAttempt = false) {
  console.log(`Creating run for thread ${threadId} with assistant ${currentAssistantId} and options:`, runOptions);
  const run = await openaiInstance.beta.threads.runs.create(threadId, {
    assistant_id: currentAssistantId,
    // user_id: currentUserId, // user_id is not a direct param for runs.create. It's part of assistant or thread metadata.
    ...runOptions, // e.g., tool_choice, tool_resources, instructions
  });

  await waitForRunCompletion(threadId, run.id, openaiInstance);
  
  const messagesResponse = await openaiInstance.beta.threads.messages.list(threadId, { order: 'desc', limit: 1 });
  
  // Ensure messagesResponse.data exists and has at least one message
  if (!messagesResponse.data || messagesResponse.data.length === 0) {
    console.warn(`No messages found in thread ${threadId} after run ${run.id}.`);
    return isFallbackAttempt ? "No fallback reply available." : "";
  }

  const latestMessage = messagesResponse.data[0];
  // Ensure the latest message is from the assistant
  if (latestMessage.role !== 'assistant') {
      console.warn(`Latest message in thread ${threadId} is from role '${latestMessage.role}', not 'assistant'. This might indicate an issue.`);
      // You might want to iterate further or handle this case specifically
      return isFallbackAttempt ? "Could not retrieve an assistant reply." : "";
  }
  
  // Ensure content exists and is of type 'text'
  if (!latestMessage.content || !Array.isArray(latestMessage.content) || latestMessage.content.length === 0) {
    console.warn(`Latest assistant message in thread ${threadId} has no content.`);
    return isFallbackAttempt ? "Assistant provided an empty reply." : "";
  }

  const textContent = latestMessage.content.find(contentBlock => contentBlock.type === 'text');
  if (!textContent || !textContent.text || typeof textContent.text.value !== 'string') {
    console.warn(`Latest assistant message in thread ${threadId} has no valid text content.`);
    return isFallbackAttempt ? "Assistant reply format not recognized." : "";
  }
  
  return textContent.text.value;
}


// --- API Endpoints ---

app.post("/ask", async (req, res) => {
  try {
    const userText = req.body.text;
    const userId = req.body.user_id || "anonymous_user"; // Identify the user

    if (!userText || typeof userText !== 'string' || userText.trim() === "") {
      return res.status(400).json({ error: "Missing or empty text in request body" });
    }

    console.log(`Received /ask request from user ${userId} with text: "${userText.substring(0,100)}..."`);
    const threadId = await getOrCreateThreadId(userId);

    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: userText,
    });

    let reply = "";

    // === PASS 1: Attempt with Vector Store (if configured) ===
    if (vectorStoreId) {
      console.log(`Attempting Pass 1 (Vector Store Search) for thread ${threadId}, user ${userId}.`);
      try {
        reply = await createRunAndGetReply(threadId, assistantId, userId, openai, {
          tool_choice: { type: "file_search" }, // Force file_search if available
          tool_resources: {
            file_search: {
              vector_store_ids: [vectorStoreId],
            },
          },
        });
        console.log(`Pass 1 reply for thread ${threadId} (length ${reply.length}): "${reply.substring(0, 70)}..."`);
      } catch (e) {
        console.warn(`Pass 1 (Vector Store) failed for thread ${threadId}, user ${userId}:`, e.message);
        reply = ""; // Ensure reply is empty to trigger fallback
      }
    } else {
      console.log("No vectorStoreId configured, skipping Pass 1 (Vector Store Search).");
    }

    // === PASS 2: Fallback to general model if Pass 1 reply is too short, or if Pass 1 was skipped/failed ===
    if (!reply || reply.length < fallbackReplyMinLength) {
      if (reply) {
        console.log(`Pass 1 reply for thread ${threadId} was too short (length ${reply.length}). Proceeding to Pass 2 (Fallback).`);
      } else if (vectorStoreId) {
        console.log(`Pass 1 reply for thread ${threadId} was empty or failed. Proceeding to Pass 2 (Fallback).`);
      } else {
        console.log(`Proceeding directly to Pass 2 (General Model) for thread ${threadId}, user ${userId}.`);
      }
      
      let fallbackRunOptions = {
        // You can add assistant-level instructions here if needed for the fallback
        // instructions: "Please provide a more general answer."
      };

      if (fallbackStrategy === "RETRY_WITH_CLARIFICATION_PROMPT" && fallbackClarificationPrompt) {
        console.log(`Adding clarification prompt to thread ${threadId}: "${fallbackClarificationPrompt}"`);
        await openai.beta.threads.messages.create(threadId, {
          role: "user", 
          content: fallbackClarificationPrompt,
        });
        // Potentially add instructions to the run for the clarification
        // fallbackRunOptions.additional_instructions = "Address the clarification: " + fallbackClarificationPrompt;
      }

      try {
        reply = await createRunAndGetReply(threadId, assistantId, userId, openai, fallbackRunOptions, true);
        console.log(`Pass 2 reply for thread ${threadId} (length ${reply.length}): "${reply.substring(0, 70)}..."`);

        // Specific phrase override
        if (reply.includes("Let’s stick to those topics.")) { // This is brittle; consider more robust solutions if this is common
          console.warn("⚠️ Intercepted known off-topic phrase in Pass 2 reply. Overriding.");
          reply = "Let’s focus on your financial goals. What would you like to explore next?";
        }
      } catch (e) {
         console.error(`Pass 2 (Fallback) failed for thread ${threadId}, user ${userId}:`, e.message);
         // Provide a generic error message to the user for this critical failure path
         return res.status(500).json({ 
            error: "Assistant failed to generate a response after fallback.", 
            details: e.message 
         });
      }
      if (!reply) { // If createRunAndGetReply returned its "No fallback reply available"
        reply = "I'm currently unable to provide a detailed response. Please try rephrasing or ask something else.";
      }
    }

    // === Optional: Generate speech ===
    let base64Audio = null;
    if (reply && reply.length >= speechReplyMinLength) {
      try {
        console.log(`Generating speech for reply of length ${reply.length} in thread ${threadId}.`);
        const speechResponse = await openai.audio.speech.create({
          model: voiceModel,
          voice: voiceName,
          input: reply,
        });
        const audioBuffer = await speechResponse.arrayBuffer();
        base64Audio = Buffer.from(audioBuffer).toString("base64");
      } catch (speechErr) {
        console.error(`Speech generation error for thread ${threadId}:`, speechErr);
        // Do not fail the request, just proceed without audio
      }
    }

    res.json({
      text: reply,
      audio: base64Audio ? `data:audio/mp3;base64,${base64Audio}` : null,
      threadId: threadId // Optionally return threadId for client-side debugging or context
    });

  } catch (err) {
    console.error("/ask endpoint error:", err.message, err.stack);
    // Avoid sending detailed internal error messages to the client in production
    const clientErrorMessage = isProd ? "An unexpected error occurred with the assistant." : err.message;
    res.status(500).json({ error: "Assistant request failed", details: clientErrorMessage });
  }
});

app.get("/token", async (req, res) => {
  try {
    const instructions = `
You are Professor Rich — a calm, confident finance professor who’s approachable but professional. Your job is to help people understand smart investing topics like valuation, risk, return, and diversification.

Start every session with a warm greeting like:
"Hey there — great to have you here. I’m Professor Rich. What finance or investing topic can I help you with today?"

If the user says something unrelated, gently guide them back — but avoid repeating the same reminder more than once. Assume positive intent and always be curious, kind, and clear.

Avoid sounding robotic or defensive. Speak naturally with helpful tone and good pacing.
    `.trim();

    const response = await fetch("https://api.openai.com/v1/realtime/sessions", { // Ensure this is the correct and current endpoint
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: realtimeSessionModel, // Use env variable
        voice: realtimeSessionVoice, // Use env variable
        instructions: instructions,
      }),
    });

    if (!response.ok) {
        const errorData = await response.text(); // Try to get error text
        console.error(`/token OpenAI API error: ${response.status} ${response.statusText}`, errorData);
        throw new Error(`OpenAI API failed with status ${response.status}: ${errorData || response.statusText}`);
    }

    const data = await response.json();
    res.json(data); // Important: must return full object so frontend can use client_secret.value
  } catch (err) {
    console.error("/token endpoint error:", err.message, err.stack);
    const clientErrorMessage = isProd ? "Failed to create a realtime session." : err.message;
    res.status(500).json({ error: "Failed to create realtime session", details: clientErrorMessage });
  }
});

// --- Static Site Hosting (Prod vs Dev) ---
if (isProd) {
  const clientDistPath = path.resolve(__dirname, "dist/client");
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.get("*", (req, res) => { // Serve index.html for any other GET request (SPA behavior)
      res.sendFile(path.resolve(clientDistPath, "index.html"));
    });
  } else {
    console.warn(`Production mode: Frontend build not found at ${clientDistPath}. Client-side app will not be served.`);
    app.get("*", (req, res) => {
      res.status(404).send("Frontend application not built or not found. Please check server configuration.");
    });
  }
} else { // Development mode
  (async () => {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "custom", // Important for custom server integration
        root: path.resolve(__dirname, "client"), // Assuming client source is in 'client' folder sibling to this server file
      });

      app.use(vite.middlewares); // Use Vite's middlewares for HMR, etc.
      
      // Fallback for all other requests to serve index.html, transformed by Vite
      app.use("*", async (req, res, next) => {
        const clientIndexHtmlPath = path.resolve(__dirname, "client/index.html"); 
        try {
          if (!fs.existsSync(clientIndexHtmlPath)) {
            console.error(`ERROR: client/index.html not found at ${clientIndexHtmlPath}`);
            return res.status(404).send("Client entry point (index.html) not found. Check your Vite setup and file paths.");
          }
          const htmlTemplate = fs.readFileSync(clientIndexHtmlPath, "utf-8");
          const html = await vite.transformIndexHtml(req.originalUrl, htmlTemplate);
          res.status(200).set({ "Content-Type": "text/html" }).end(html);
        } catch (e) {
          vite.ssrFixStacktrace(e); // Let Vite fix the stack trace
          next(e); // Pass error to Express default error handler
        }
      });
      console.log("Vite dev server middleware configured.");
    } catch (e) {
        console.error("Failed to set up Vite dev server:", e);
        process.exit(1);
    }
  })();
}

// --- Error Handling Middleware (optional, but good practice) ---
app.use((err, req, res, next) => {
  console.error("Unhandled Express error:", err.stack);
  if (res.headersSent) {
    return next(err);
  }
  const statusCode = err.status || err.statusCode || 500;
  const clientErrorMessage = (isProd && statusCode === 500) ? "An unexpected server error occurred." : err.message;
  res.status(statusCode).json({ error: "Server Error", details: clientErrorMessage });
});


app.listen(port, () => {
  console.log(`✅ Server live on http://localhost:${port} (${isProd ? "production" : "development"} mode)`);
  if (!isProd) {
    console.log("   Vite development server is active for frontend.");
  }
  if (!assistantId) console.warn("⚠️ OPENAI_ASSISTANT_ID is not set. /ask endpoint will likely fail.");
  if (!apiKey) console.warn("⚠️ OPENAI_API_KEY is not set. All OpenAI calls will fail.");
  if (!supabaseUrl || !supabaseServiceRoleKey) console.warn("⚠️ Supabase environment variables are not fully set. Thread persistence will fail.");

});
