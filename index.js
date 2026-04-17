import express from "express";
import cors from "cors";
import { config } from "dotenv";
import { OpenAI } from "openai";

config();

const app = express();
const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || "gpt-5-mini";
const backendVersion = "2026-04-16-ai-rescue-v3";
const apiKey = process.env.OPENAI_API_KEY;
const dailyAiLimit = Number(process.env.DAILY_AI_LIMIT || 5);
const adminBypassToken = process.env.ADMIN_BYPASS_TOKEN || "";

const openai = apiKey ? new OpenAI({ apiKey }) : null;
const usageByDay = new Map();
let lastOpenAIError = null;

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

function hasMultipleQuestions(prompt) {
  const matches = prompt.match(/[?¿]/g);
  if (matches && matches.length > 1) {
    return true;
  }

  const lower = prompt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const starters = lower.match(/\b(what is|what are|how do|how does|why|can you|explain|define|que es|como|por que|explica|define)\b/g);
  return Boolean(starters && starters.length > 1);
}

function isLikelyMathExpression(text) {
  return /^[0-9\s+\-*/().,%^=]+$/.test(text.trim());
}

function classifyIntent(prompt) {
  const text = prompt.trim();
  const lower = text.toLowerCase();

  if (/(translate|traduce|traduceme|translate this|translate to|al espanol|to spanish|to english|al ingles)/i.test(lower)) {
    return "translate";
  }

  if (/(summari[sz]e|summary|resume|resumen|resumir|tl;dr)/i.test(lower)) {
    return "summarize";
  }

  if (/(rewrite|rewrite this|reescribe|reformular|rephrase|improve this text|mejora este texto)/i.test(lower)) {
    return "rewrite";
  }

  if (/(write|draft|email|message|mensaje|correo|redacta|redactar|escribe)/i.test(lower)) {
    return "write";
  }

  if (hasMultipleQuestions(text)) {
    return "multi";
  }

  if (/(explain|what is|what are|how does|por que|porque|que es|explica|como funciona|difference between|define|define this)/i.test(lower)) {
    return "explain";
  }

  if (
    isLikelyMathExpression(text) ||
    /(solve|calculate|calc|equation|porcentaje|calcula|resuelve|ecuacion|operacion)/i.test(lower)
  ) {
    return "calculate";
  }

  if (/(fraction|fractions|fraccion|fracciones|math concept|mathematical concept|geometr|algebra|decimal|percentage)/i.test(lower)) {
    return "explain";
  }

  return "general";
}

function getInstructions(locale, intent) {
  const isEnglish = locale === "en";
  const shared = isEnglish
    ? [
        "You are KKCalculator AI, a practical, useful, friendly assistant.",
        "Always return a helpful text response.",
        "Be direct, natural, and concise.",
        "Prefer 2 short paragraphs or up to 3 bullets.",
        "If the request is incomplete, ask one short clarifying question instead of returning empty.",
        "If the user asks multiple questions at once, answer them in a short numbered list.",
        "Do not invent numeric results."
      ]
    : [
        "Eres KKCalculator AI, un asistente practico, util y cercano.",
        "Devuelve siempre una respuesta util.",
        "Responde de forma directa, natural y breve.",
        "Prefiere 2 parrafos cortos o hasta 3 puntos.",
        "Si la solicitud esta incompleta, haz una sola pregunta breve para aclarar en vez de responder vacio.",
        "Si el usuario hace varias preguntas juntas, respondelas en una lista numerada corta.",
        "No inventes resultados numericos."
      ];

  const intentInstructions = {
    calculate: isEnglish
      ? [
          "If the user asks for math help, give the result or method first.",
          "If it is a conceptual math question, explain it simply instead of asking for an expression.",
          "Use one short example if it helps."
        ]
      : [
          "Si el usuario pide ayuda matematica, da primero el resultado o el metodo.",
          "Si es una pregunta conceptual de matematicas, explicala de forma simple en lugar de pedir una expresion.",
          "Usa un ejemplo corto si ayuda."
        ],
    explain: isEnglish
      ? [
          "Explain the concept in simple language.",
          "If helpful, end with one practical or simple example."
        ]
      : [
          "Explica el concepto con lenguaje simple.",
          "Si ayuda, termina con un ejemplo simple o practico."
        ],
    write: isEnglish
      ? [
          "When asked to write, produce a clean ready-to-send draft.",
          "Use a professional but warm tone unless the user asks otherwise.",
          "Do not over-explain the draft."
        ]
      : [
          "Cuando te pidan redactar, entrega un borrador limpio y listo para usar.",
          "Usa un tono profesional pero cercano, salvo que el usuario pida otro.",
          "No sobreexplique el borrador."
        ],
    rewrite: isEnglish
      ? [
          "Rewrite the provided text clearly and naturally.",
          "Preserve the original meaning unless the user asks for a stronger rewrite."
        ]
      : [
          "Reescribe el texto de forma clara y natural.",
          "Conserva el sentido original salvo que el usuario pida un cambio mas fuerte."
        ],
    translate: isEnglish
      ? [
          "Translate the text faithfully into the requested language.",
          "Do not turn the translation into a new draft unless the user explicitly asks for rewriting."
        ]
      : [
          "Traduce el texto con fidelidad al idioma solicitado.",
          "No conviertas la traduccion en un borrador nuevo salvo que el usuario pida reescritura."
        ],
    summarize: isEnglish
      ? [
          "Summaries must be short and easy to scan.",
          "If the user did not include the source text, ask for it clearly."
        ]
      : [
          "Los resumenes deben ser cortos y faciles de leer.",
          "Si el usuario no incluyo el texto fuente, pidelo de forma clara."
        ],
    multi: isEnglish
      ? ["The user asked multiple questions. Answer each one briefly in order."]
      : ["El usuario hizo varias preguntas. Responde cada una brevemente en orden."],
    general: isEnglish
      ? ["Answer as a practical everyday assistant for study, work, and daily tasks."]
      : ["Responde como un asistente practico para estudio, trabajo y tareas del dia a dia."]
  };

  return [...shared, ...(intentInstructions[intent] || intentInstructions.general)].join(" ");
}

function normalizePromptText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getResponseLocale(prompt, locale) {
  const text = normalizePromptText(prompt);

  if (/\b(que|como|porque|por que|ayuda|ayudame|explica|explicame|traduce|traduceme|redacta|redactar|escribe|mensaje|correo|fraccion|ganancia|flujo)\b/.test(text)) {
    return "es";
  }

  if (/\b(what|how|why|explain|translate|write|fraction|profit|cash flow)\b/.test(text)) {
    return "en";
  }

  return locale === "en" ? "en" : "es";
}

function hasAny(text, words) {
  return words.some((word) => text.includes(word));
}

function buildKnownAnswer(prompt, locale) {
  const text = normalizePromptText(prompt);
  const isEnglish = locale === "en";

  if (hasAny(text, ["fraccion equivalente", "equivalent fraction"])) {
    return isEnglish
      ? "An equivalent fraction is a fraction that has the same value as another fraction, even if the numbers look different. Example: 1/2 and 2/4 are equivalent because both represent one half."
      : "Una fraccion equivalente es una fraccion que representa el mismo valor que otra, aunque tenga numeros diferentes. Ejemplo: 1/2 y 2/4 son equivalentes porque ambas representan la mitad.";
  }

  if (hasAny(text, ["cash flow", "flujo de caja", "flujo de efectivo"])) {
    return isEnglish
      ? "Cash flow is the money moving in and out of a business. Positive cash flow means more money comes in than goes out; negative cash flow means more money goes out than comes in."
      : "El cash flow o flujo de caja es el dinero que entra y sale de un negocio. Si entra mas dinero del que sale, el flujo es positivo; si sale mas del que entra, es negativo.";
  }

  if (hasAny(text, ["profit", "ganancia", "beneficio", "utilidad"])) {
    return isEnglish
      ? "Profit is the money left after subtracting costs and expenses from income. Example: if you sell $100 and spend $70, your profit is $30."
      : "La ganancia es el dinero que queda despues de restar costos y gastos a los ingresos. Ejemplo: si vendes $100 y gastas $70, tu ganancia es $30.";
  }

  return "";
}

function buildRescueAnswer(prompt, locale, intent) {
  const isEnglish = locale === "en";
  const knownAnswer = buildKnownAnswer(prompt, locale);

  if (knownAnswer) {
    return knownAnswer;
  }

  if (intent === "write") {
    return isEnglish
      ? "Sure. Try this: Hello [Name], I hope you are doing well. I am writing to ask [your request]. Please let me know if this works for you. Thank you."
      : "Claro. Prueba esto: Hola [Nombre], espero que estes bien. Te escribo para solicitar [tu pedido]. Quedo atento a tu confirmacion. Gracias.";
  }

  if (intent === "translate") {
    return isEnglish
      ? "Paste the exact text you want translated and tell me the target language if it is not clear."
      : "Pega el texto exacto que quieres traducir y dime el idioma de destino si no esta claro.";
  }

  if (intent === "rewrite") {
    return isEnglish
      ? "Paste the exact text you want rewritten and I will make it clearer."
      : "Pega el texto exacto que quieres reescribir y lo hare mas claro.";
  }

  if (intent === "summarize") {
    return isEnglish
      ? "I can do that. Paste the full text you want summarized and I will return a short version."
      : "Puedo hacerlo. Pega el texto completo que quieres resumir y te devuelvo una version corta.";
  }

  if (intent === "explain") {
    return isEnglish
      ? "In simple terms, this is asking for an explanation of a concept. I can help: send the exact topic or add one example, and I will explain it clearly with a short example."
      : "En palabras simples, esta pregunta pide explicar un concepto. Puedo ayudarte: envia el tema exacto o agrega un ejemplo y lo explico claro con un ejemplo corto.";
  }

  if (intent === "calculate") {
    return isEnglish
      ? "I can help with that. Send the full expression or the exact math question and I will solve it step by step."
      : "Puedo ayudarte con eso. Enviame la expresion completa o la pregunta matematica exacta y la resuelvo paso a paso.";
  }

  if (intent === "multi") {
    return isEnglish
      ? "I can answer multiple questions. If the AI response is unavailable, try sending each question separately so I can give a cleaner answer."
      : "Puedo responder varias preguntas. Si la respuesta de IA no esta disponible, envia cada pregunta por separado para darte una respuesta mas limpia.";
  }

  return isEnglish
    ? "I can help with that. Please add one specific detail so I can answer clearly."
    : "Puedo ayudarte con eso. Agrega un detalle especifico para responderte con mas claridad.";
}

async function requestAnswer(prompt, locale, intent) {
  const instructions = getInstructions(locale, intent);

  if (typeof openai.responses?.create === "function") {
    const response = await openai.responses.create({
      model,
      instructions,
      input: prompt,
      max_output_tokens: 220
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
    max_completion_tokens: 220
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
    backendVersion,
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
    const intent = classifyIntent(prompt);
    const responseLocale = getResponseLocale(prompt, locale);
    const { answer: rawAnswer, apiMode } = await requestAnswer(prompt, responseLocale, intent);
    let answer = rawAnswer;

    lastOpenAIError = null;

    if (!answer) {
      answer = buildRescueAnswer(prompt, responseLocale, intent);
    }

    const updatedUsage = getUsageInfo(req);

    return res.json({
      answer,
      model,
      apiMode,
      providerStatus: "ok",
      intent,
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
  console.log(`Backend version: ${backendVersion}`);
  console.log(`Daily AI limit: ${dailyAiLimit}`);
});





