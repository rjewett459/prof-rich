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

// AI Assistant Route with Vector Store First, Fallback Second
app.post("/ask", async (req, res) => {
  try {
    const userText = req.body.text;
    if (!userText) return res.status(400).json({ error: "Missing text" });

    const thread = await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userText,
    });

    // === PASS 1: Vector Store Only ===
    let run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: "asst_EuIboyHjDFMN7HiHAMXF2pgO",
      tool_choice: { type: "file_search" },
      tool_resources: {
        file_search: {
          vector_store_ids: ["vs_68265a0e70b081918938e8df5060d328"],
        },
      },
    });

    // Wait for completion
    let runStatus = run;
    while (runStatus.status !== "completed") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (["failed", "expired", "cancelled"].includes(runStatus.status)) {
        throw new Error(`Run ${runStatus.status}`);
      }
    }

    let messages = await openai.beta.threads.messages.list(thread.id);
    let reply = messages.data[0]?.content[0]?.text?.value || "";

    console.log("🔍 Vector reply:", reply);

    // === PASS 2: Fallback to Model if reply too short or generic ===
    if (!reply || reply.length < 20) {
      console.log("⚠️ Vector store insufficient. Retrying with model knowledge...");

      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: userText,
      });

      run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: "asst_EuIboyHjDFMN7HiHAMXF2pgO",
        tool_choice: "auto", // Let it use model if vector fails
      });

      runStatus = run;
      while (runStatus.status !== "completed") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        if (["failed", "expired", "cancelled"].includes(runStatus.status)) {
          throw new Error(`Run ${runStatus.status}`);
        }
      }

      messages = await openai.beta.threads.messages.list(thread.id);
      reply = messages.data[0]?.content[0]?.text?.value || "No useful answer from fallback.";
    }

    // === Optional: Generate speech (only if meaningful reply)
    let base64Audio = null;
    if (reply && reply.length > 10) {
      const speechResponse = await openai.audio.speech.create({
        model: "tts-1",
        voice: "sage",
        input: reply,
      });

      const audioBuffer = await speechResponse.arrayBuffer();
      base64Audio = Buffer.from(audioBuffer).toString("base64");
    }

    res.json({
      text: reply,
      audio: base64Audio ? `data:audio/mp3;base64,${base64Audio}` : null,
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

// Serve static site
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
