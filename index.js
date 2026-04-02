import express from "express";
import cors from "cors";
import { config } from "dotenv";
import { OpenAI } from "openai";

config();

const app = express();
const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || "gpt-5-mini";
const apiKey = process.env.OPENAI_API_KEY;
const dailyAiLimit = Number(process.env.DAILY_AI_LIMIT || 5);
const adminBypassToken = process.env.ADMIN_BYPASS_TOKEN || "";

const openai = apiKey ? new OpenAI({ apiKey }) : null;
const usageByDay = new Map();
let lastOpenAIError = null;

const assistantInstructions = [
  "Eres KKCalculator AI, un asistente util y cercano.",
  "Responde en espanol claro, directo y breve.",
  "Usa maximo 3 frases cortas o 3 pasos cortos.",
  "Si el usuario hace una operacion matematica, da el resultado primero y una explicacion muy breve despues.",
  "Si el usuario pide una explicacion, prioriza la idea principal sin rodeos.",
  "No inventes resultados numericos: si falta informacion, dilo."
].join(" ");

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getClientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)[0];

  return forwarded || req.ip || "unknown";
}

function getUsageMapForToday() {
  const todayKey = getTodayKey();

  for (const key of usageByDay.keys()) {
    if (key !== todayKey) {
      usageByDay.delete(key);
    }
  }

  if (!usageByDay.has(todayKey)) {
    usageByDay.set(todayKey, new Map());
  }

  return usageByDay.get(todayKey);
}

function getUsageInfo(req) {
  const todayUsage = getUsageMapForToday();
  const clientKey = getClientKey(req);
  const usedToday = todayUsage.get(clientKey) || 0;
  const adminBypassActive = Boolean(adminBypassToken) && req.get("x-kkc-admin-token") === adminBypassToken;

  return {
    clientKey,
    usedToday,
    remainingToday: adminBypassActive ? null : Math.max(0, dailyAiLimit - usedToday),
    dailyLimit: dailyAiLimit,
    adminBypassActive
  };
}

function incrementUsage(req) {
  const todayUsage = getUsageMapForToday();
  const clientKey = getClientKey(req);
  const nextCount = (todayUsage.get(clientKey) || 0) + 1;
  todayUsage.set(clientKey, nextCount);
  return nextCount;
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  const configured = Boolean(apiKey);
  const usage = getUsageInfo(req);
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
    dailyLimit: usage.dailyLimit,
    usedToday: usage.usedToday,
    remainingToday: usage.remainingToday,
    adminBypassActive: usage.adminBypassActive,
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

  const usage = getUsageInfo(req);

  if (!usage.adminBypassActive && usage.usedToday >= dailyAiLimit) {
    return res.status(429).json({
      error: "Daily AI limit reached",
      details: `Esta demo publica permite ${dailyAiLimit} consultas de IA por dia.`,
      providerStatus: "daily_limit_reached",
      dailyLimit: dailyAiLimit,
      usedToday: usage.usedToday,
      remainingToday: 0
    });
  }

  incrementUsage(req);

  try {
    let answer = "";
    let apiMode = "chat.completions";

    if (typeof openai.responses?.create === "function") {
      apiMode = "responses";

      const response = await openai.responses.create({
        model,
        instructions: assistantInstructions,
        input: prompt,
        max_output_tokens: 180
      });

      answer = response.output_text?.trim() || "";
    } else {
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: assistantInstructions },
          { role: "user", content: prompt }
        ],
        max_tokens: 180
      });

      answer = completion.choices[0]?.message?.content?.trim() || "";
    }

    lastOpenAIError = null;

    if (!answer) {
      answer = "No se recibio una respuesta util del modelo.";
    }

    const updatedUsage = getUsageInfo(req);

    return res.json({
      answer,
      model,
      apiMode,
      providerStatus: "ok",
      dailyLimit: updatedUsage.dailyLimit,
      usedToday: updatedUsage.usedToday,
      remainingToday: updatedUsage.remainingToday,
      adminBypassActive: updatedUsage.adminBypassActive
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
  console.log(`Daily AI limit: ${dailyAiLimit}`);
});
