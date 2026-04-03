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

function getInstructions(locale) {
  if (locale === "en") {
    return [
      "You are KKCalculator AI, a practical, useful, friendly assistant.",
      "Reply in clear, direct English.",
      "Use at most 3 short sentences or 3 short bullet-style steps.",
      "If the user sends a math expression, give the result first and then a very short explanation.",
      "If the user asks for help with text, work, or study, answer simply and usefully.",
      "If the request is incomplete, ask one short clarifying question.",
      "Do not invent numeric results. If information is missing, say so."
    ].join(" ");
  }

  return [
    "Eres KKCalculator AI, un asistente practico, util y cercano.",
    "Responde en espanol claro, directo y breve.",
    "Usa maximo 3 frases cortas o 3 pasos cortos.",
    "Si el usuario hace una operacion matematica, da el resultado primero y una explicacion muy breve despues.",
    "Si el usuario pide ayuda con texto, trabajo o estudio, responde de forma simple, util y breve.",
    "Si la solicitud esta incompleta, haz una sola pregunta breve para aclarar.",
    "No inventes resultados numericos: si falta informacion, dilo."
  ].join(" ");
}

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

function getAdminTokenFromRequest(req) {
  const headerToken = req.get("x-kkc-admin-token");
  const queryToken = typeof req.query?.kkc_admin === "string" ? req.query.kkc_admin : "";
  const bodyToken = typeof req.body?.adminToken === "string" ? req.body.adminToken : "";

  return [headerToken, queryToken, bodyToken]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean) || "";
}

function getUsageInfo(req) {
  const todayUsage = getUsageMapForToday();
  const clientKey = getClientKey(req);
  const usedToday = todayUsage.get(clientKey) || 0;
  const providedAdminToken = getAdminTokenFromRequest(req);
  const adminBypassActive = Boolean(adminBypassToken) && providedAdminToken === adminBypassToken;

  return {
    clientKey,
    usedToday,
    remainingToday: adminBypassActive ? null : Math.max(0, dailyAiLimit - usedToday),
    dailyLimit: dailyAiLimit,
    adminBypassActive,
    adminTokenProvided: Boolean(providedAdminToken)
  };
}

function incrementUsage(req) {
  const usage = getUsageInfo(req);

  if (usage.adminBypassActive) {
    return usage.usedToday;
  }

  const todayUsage = getUsageMapForToday();
  const nextCount = usage.usedToday + 1;
  todayUsage.set(usage.clientKey, nextCount);
  return nextCount;
}

function extractTextFromResponseOutput(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const segments = [];

  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        segments.push(content.text.trim());
      }
      if (typeof content?.output_text === "string" && content.output_text.trim()) {
        segments.push(content.output_text.trim());
      }
    }
  }

  return segments.join("\n").trim();
}

async function requestAnswer(prompt, locale) {
  const instructions = getInstructions(locale);

  if (typeof openai.responses?.create === "function") {
    const response = await openai.responses.create({
      model,
      instructions,
      input: prompt,
      max_output_tokens: 180
    });

    const answer = extractTextFromResponseOutput(response);
    if (answer) {
      return { answer, apiMode: "responses" };
    }
  }

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: prompt }
    ],
    max_completion_tokens: 180
  });

  return {
    answer: completion.choices[0]?.message?.content?.trim() || "",
    apiMode: "chat.completions"
  };
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
    adminTokenProvided: usage.adminTokenProvided,
    lastError: lastOpenAIError
      ? {
          status: lastOpenAIError.status || null,
          code: lastOpenAIError.code || null,
          message: lastOpenAIError.message || "Unknown error"
        }
      : null
  });
});

app.post("/api/ask", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const locale = req.body?.locale === "en" ? "en" : "es";

  if (!prompt) {
    return res.status(400).json({ error: "No prompt provided" });
  }

  if (!openai) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is missing",
      details: locale === "en"
        ? "Define OPENAI_API_KEY before using the AI backend."
        : "Define OPENAI_API_KEY antes de usar el backend de IA.",
      providerStatus: "missing_api_key"
    });
  }

  const usage = getUsageInfo(req);

  if (!usage.adminBypassActive && usage.usedToday >= dailyAiLimit) {
    return res.status(429).json({
      error: "Daily AI limit reached",
      details: locale === "en"
        ? `This public demo allows ${dailyAiLimit} AI requests per day.`
        : `Esta demo publica permite ${dailyAiLimit} consultas de IA por dia.`,
      providerStatus: "daily_limit_reached",
      dailyLimit: dailyAiLimit,
      usedToday: usage.usedToday,
      remainingToday: 0,
      adminBypassActive: false
    });
  }

  incrementUsage(req);

  try {
    const { answer: rawAnswer, apiMode } = await requestAnswer(prompt, locale);
    let answer = rawAnswer;

    lastOpenAIError = null;

    if (!answer) {
      answer = locale === "en"
        ? "I could not produce a useful answer this time. Please try rephrasing your request."
        : "No pude generar una respuesta util esta vez. Intenta reformular tu pregunta.";
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
      adminBypassActive: updatedUsage.adminBypassActive,
      adminTokenProvided: updatedUsage.adminTokenProvided
    });
  } catch (error) {
    lastOpenAIError = {
      status: error?.status || 500,
      code: error?.code || null,
      message: error?.message || String(error)
    };

    console.error("OpenAI backend error:", error);

    return res.status(error?.status || 500).json({
      error: locale === "en" ? "Error while querying OpenAI" : "Error al consultar OpenAI",
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

