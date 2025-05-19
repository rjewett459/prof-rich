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

// Realtime assistant response route with full guardrails
app.post("/ask", async (req, res) => {
  try {
    const userText = req.body.text;
    if (!userText) return res.status(400).json({ error: "Missing text" });

    // === 🔒 INPUT FILTERS (Professor Rich Scope Lock) ===
    const allowedKeywords = [
      "stock", "valuation", "portfolio", "risk", "diversification",
      "investment", "return", "asset", "market", "volatility", "hedge",
      "interest", "dividend", "capital", "DCF", "P/E", "equity", "bond"
    ];

    const forbiddenKeywords = [
      // Music & entertainment
      "rap", "hip hop", "lyrics", "music", "song", "album", "artist", "concert", "dj", "singer", "celebrity",

      // Politics
      "politics", "election", "democrat", "republican", "biden", "trump", "congress", "senate", "government", "policy", "president",

      // Religion
      "religion", "church", "bible", "jesus", "god", "pray", "faith", "spiritual", "pastor", "sermon",

      // Health
      "doctor", "medical", "medicine", "mental health", "hospital", "vaccine", "covid", "fitness", "diet", "therapy", "sick", "disease",

      // Crypto
      "crypto", "bitcoin", "ethereum", "blockchain", "nft", "web3", "token", "wallet", "mining",

      // Tech
      "coding", "python", "software", "hardware", "ai", "chatgpt",

      // Pop culture
      "tiktok", "instagram", "youtube", "movie", "netflix", "tv", "actor", "streaming", "celebrity",

      // Sports
      "football", "basketball", "nba", "nfl", "soccer", "mlb", "hockey", "team", "athlete", "match",

      // Other
      "dating", "relationships", "love", "astrology", "horoscope", "alien", "ufo", "dream", "conspiracy"
    ];

    const input = userText.toLowerCase();

    const isAllowed = allowedKeywords.some((word) => input.includes(word));
    const isForbidden = forbiddenKeywords.some((word) => input.includes(word));

    if (!isAllowed || isForbidden) {
      return res.json({
        text: "Professor Rich only answers finance-related questions like Stock Valuation, Risk Management, or Portfolio Construction. Please ask a question on those topics.",
        audio: null,
      });
    }

    // === 🧠 Create Assistant Run ===
    const thread = await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userText,
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: "asst_EuIboyHjDFMN7HiHAMXF2pgO", // <-- Use your Assistant ID
      tool_choice: "auto",
      tool_resources: {
        file_search: {
          vector_store_ids: ["vs_68265a0e70b081918938e8df5060d328"], // <-- Use your Vector Store ID
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

    // === 🔒 OUTPUT FILTER (Failsafe Catch) ===
    const isOffTopic = forbiddenKeywords.some((word) =>
      reply.toLowerCase().includes(word)
    );

    if (isOffTopic) {
      return res.json({
        text: "That response was off-topic. Professor Rich only discusses financial education. Please stay within the approved curriculum.",
        audio: null,
      });
    }

    // === 🎧 Generate Audio ===
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

// === 🎙 Realtime Token Endpoint ===
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

// === 🖥️ Serve Static Client Build ===
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
