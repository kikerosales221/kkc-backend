import express from "express";
import cors from "cors";
import { config } from "dotenv";
import { OpenAI } from "openai";

config();

const app = express();
const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || "gpt-5-mini";
const apiKey = process.env.OPENAI_API_KEY;

const openai = apiKey ? new OpenAI({ apiKey }) : null;
let lastOpenAIError = null;

const assistantInstructions = [
  "Eres KKCalculator AI, un asistente util y cercano.",
  "Ayudas con matematicas, ciencia, explicaciones generales, estudio y dudas cotidianas.",
  "Si el usuario hace una operacion matematica, responde con el resultado y una explicacion breve.",
  "Si el usuario pide ayuda general, responde en espanol claro, practico y directo.",
  "Cuando sea util, organiza la respuesta en pasos cortos.",
  "No inventes resultados numericos: si falta informacion, dilo."
].join(" ");

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  const configured = Boolean(apiKey);
  const providerStatus = !configured
    ? "missing_api_key"
    : lastOpenAIError?.status === 429
      ? "quota_exceeded"
      : lastOpenAIError?.status === 401
        ? "invalid_api_key"
        : lastOpenAIError
          ? "degraded"
          : "configured";

  res.json({
    ok: configured && !lastOpenAIError,
    configured,
    providerStatus,
    model,
    hasApiKey: configured,
    mode: openai?.responses?.create ? "responses" : "chat.completions",
    lastError: lastOpenAIError
      ? {
          status: lastOpenAIError.status || null,
          code: lastOpenAIError.code || null,
          message: lastOpenAIError.message || "Error desconocido"
        }
      : null
  });
});

app.post("/api/ask", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";

  if (!prompt) {
    return res.status(400).json({ error: "No prompt provided" });
  }

  if (!openai) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is missing",
      details: "Define OPENAI_API_KEY in kkc-backend/.env before using the AI backend.",
      providerStatus: "missing_api_key"
    });
  }

  try {
    let answer = "";
    let apiMode = "chat.completions";

    if (typeof openai.responses?.create === "function") {
      apiMode = "responses";

      const response = await openai.responses.create({
        model,
        instructions: assistantInstructions,
        input: prompt,
        max_output_tokens: 500
      });

      answer = response.output_text?.trim() || "";
    } else {
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: assistantInstructions },
          { role: "user", content: prompt }
        ],
        max_tokens: 500
      });

      answer = completion.choices[0]?.message?.content?.trim() || "";
    }

    lastOpenAIError = null;

    if (!answer) {
      answer = "No se recibio una respuesta util del modelo.";
    }

    return res.json({
      answer,
      model,
      apiMode,
      providerStatus: "ok"
    });
  } catch (error) {
    lastOpenAIError = {
      status: error?.status || 500,
      code: error?.code || null,
      message: error?.message || String(error)
    };

    console.error("OpenAI backend error:", error);

    return res.status(error?.status || 500).json({
      error: "Error al consultar OpenAI",
      details: error?.message || String(error),
      model,
      providerStatus:
        error?.status === 429
          ? "quota_exceeded"
          : error?.status === 401
            ? "invalid_api_key"
            : "error"
    });
  }
});

app.listen(port, () => {
  console.log(`KKC Backend running on http://localhost:${port}`);
  console.log(`Model: ${model}`);
});
