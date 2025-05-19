import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";

const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey });

app.use(express.json());

// Realtime assistant response route with topic guardrails
app.post("/ask", async (req, res) => {
  try {
    const userText = req.body.text;
    if (!userText) return res.status(400).json({ error: "Missing text" });

    // === ✅ TOPIC FILTERING (Professor Rich guardrail) ===
    const allowedKeywords = [
      "stock", "valuation", "portfolio", "risk", "diversification",
      "beta", "DCF", "P/E", "investment", "hedge", "volatility", "asset"
    ];
    const isInScope = allowedKeywords.some((word) =>
      userText.toLowerCase().includes(word)
    );

    if (!isInScope) {
      return res.json({
        text: "You may only answer questions related to Stock Valuation, Risk Management, or Portfolio Construction. Do not engage with unrelated questions or speculate. If asked anything outside of scope, politely decline and guide the user back to the lesson.",
        audio: null,
      });
    }

    // === CONTINUE WITH OPENAI THREAD & RUN ===
    const thread = await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userText,
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: "asst_EuIboyHjDFMN7HiHAMXF2pgO", // <-- Replace with your actual Assistant ID
      tool_choice: "auto",
      tool_resources: {
        file_search: {
          vector_store_ids: ["vs_68265a0e70b081918938e8df5060d328"], // <-- Replace with your vector store ID
        },
      },
    });

    let runStatus = run;
    while (runStatus.status !== "completed") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (["failed", "expired", "cancelled"].includes(runStatus.status)) {
        throw new Error(`Run ${runStatus.status}`);
      }
    }

    const messages = await openai.beta.threads.messages.list(thread.id);
    const reply = messages.data[0]?.content[0]?.text?.value || "No response available.";

// === ✅ OUTPUT FILTER: Block Off-Topic Replies ===
const disallowedWords = ["politics", "religion", "health", "crypto"];
const isOffTopic = disallowedWords.some(word =>
  reply.toLowerCase().includes(word)
);

if (isOffTopic) {
  return res.json({
    text: "Professor Rich is limited to financial topics like Stock Valuation, Risk Management, or Portfolio Construction.",
    audio: null,
  });
}

    const speechResponse = await openai.audio.speech.create({
      model: "tts-1",
      voice: "sage",
      input: reply,
    });

    const audioBuffer = await speechResponse.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString("base64");

    res.json({
      text: reply,
      audio: `data:audio/mp3;base64,${base64Audio}`,
    });
  } catch (err) {
    console.error("Assistant /ask route error:", err);
    res.status(500).json({ error: "Failed to process assistant response" });
  }
});

// Token endpoint for realtime voice
app.get("/token", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2024-12-17",
          voice: "verse",
        }),
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// Serve static client build in production
if (isProd) {
  app.use(express.static(path.resolve(__dirname, "dist/client")));

  app.get("*", (req, res) => {
    res.sendFile(path.resolve(__dirname, "dist/client/index.html"));
  });
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "custom",
  });

  app.use(vite.middlewares);

  app.use("*", async (req, res, next) => {
    try {
      const html = await vite.transformIndexHtml(
        req.originalUrl,
        fs.readFileSync("./client/index.html", "utf-8")
      );
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}

app.listen(port, () => {
  console.log(`✅ Express server running on http://localhost:${port}`);
});
