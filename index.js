import express from "express";
import cors from "cors";
import { config } from "dotenv";
import { OpenAI } from "openai";

config();

const app = express();
const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || "gpt-5-mini";
const backendVersion = "2026-04-17-ai-suggestions-v14";
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
  const questionStarters = lower.match(/\b(what is|what are|how do|how does|why|que es|como|por que)\b/g);
  return Boolean(questionStarters && questionStarters.length > 1);
}

function isLikelyMathExpression(text) {
  return /^[0-9\s+\-*/().,%^=]+$/.test(text.trim());
}

function classifyIntent(prompt) {
  const text = prompt.trim();
  const lower = text.toLowerCase();

  if (/(explain this more clearly|explica esto con palabras|make this answer|haz esta respuesta|turn this answer|convierte esta respuesta|rewrite this answer|reescribe esta respuesta)/i.test(lower)) {
    return "transform";
  }

  if (/(translate|traduce|traduceme|translate this|translate to|al espanol|to spanish|to english|al ingles)/i.test(lower)) {
    return "translate";
  }

  if (/(summari[sz]e|summary|resume|resumen|resumir|tl;dr)/i.test(lower)) {
    return "summarize";
  }

  if (/(rewrite|rewrite this|reescribe|reformular|rephrase|improve this text|mejora este texto)/i.test(lower)) {
    return "rewrite";
  }

  if (/(list|lista|checklist|cosas que debo revisar|things to check|organiza|organizar|tareas|pasos|steps)/i.test(lower)) {
    return "list";
  }

  if (/(write|draft|email|message|professional|profesional|mensaje|correo|redacta|redactar|escribe|solicita|solicitar|pedir|pide|confirmar|request|ask for)/i.test(lower)) {
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
          "When asked to write a message, email, or professional text, produce only a clean ready-to-send draft.",
          "Use a professional, clear, and structured tone.",
          "Include an appropriate greeting, a clear body, and a proper closing.",
          "If details are missing, write a neutral adaptable draft instead of asking questions.",
          "Do not over-explain the draft or add commentary before it."
        ]
      : [
          "Cuando te pidan redactar un mensaje, correo o texto profesional, entrega solo un borrador limpio y listo para usar.",
          "Usa un tono profesional, claro y estructurado.",
          "Incluye saludo adecuado, cuerpo claro y cierre apropiado.",
          "Si faltan detalles, escribe un borrador neutral adaptable en vez de hacer preguntas.",
          "No sobreexpliques el borrador ni agregues comentarios antes del texto."
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
    transform: isEnglish
      ? [
          "The user is asking to improve, simplify, shorten, or reformat a previous answer.",
          "Transform the text after the colon according to the request.",
          "Do not ask for the topic again. Do not explain what you are doing."
        ]
      : [
          "El usuario pide mejorar, simplificar, acortar o cambiar formato de una respuesta anterior.",
          "Transforma el texto despues de los dos puntos segun la solicitud.",
          "No pidas el tema otra vez. No expliques lo que haces."
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
    list: isEnglish
      ? ["Return a short practical list with 3 to 5 bullets.", "Do not write it as an email or formal message."]
      : ["Devuelve una lista corta y practica de 3 a 5 puntos.", "No lo escribas como correo ni mensaje formal."],
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

  if (/\b(que|como|porque|por que|ayuda|ayudame|haz|lista|cosas|tareas|explica|explicame|traduce|traduceme|redacta|redactar|escribe|mensaje|correo|solicita|solicitar|pedir|confirmar|reunion|disculpa|seguimiento|fraccion|factura|ganancia|flujo)\b/.test(text)) {
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

  if (hasAny(text, ["factura", "invoice"])) {
    return isEnglish
      ? "An invoice is a document that shows what was sold, how much it costs, and how much the customer needs to pay. In simple words, it is a formal bill for a product or service."
      : "Una factura es un documento que muestra que se vendio, cuanto cuesta y cuanto debe pagar el cliente. En palabras simples, es una cuenta formal por un producto o servicio.";
  }

  return "";
}

function getTextAfterColon(prompt) {
  const index = String(prompt || "").indexOf(":");
  if (index === -1) {
    return "";
  }

  return String(prompt || "").slice(index + 1).trim();
}

function buildTransformFallback(prompt, locale) {
  const isEnglish = locale === "en";
  const source = getTextAfterColon(prompt);

  if (!source) {
    return isEnglish
      ? "Send the answer you want me to improve and I will make it clearer."
      : "Envia la respuesta que quieres mejorar y la hare mas clara.";
  }

  if (/\b(shorter|mas corta|más corta)\b/i.test(prompt)) {
    return source.split(/[.!?]/).map((part) => part.trim()).filter(Boolean).slice(0, 2).join(". ") + ".";
  }

  if (/\b(bullet|puntos|lista)\b/i.test(prompt)) {
    let parts = source
      .split(/[.!?;]|,|\s+y\s+|\s+and\s+/i)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 3);

    if (parts.length < 2) {
      parts = source.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean).slice(0, 3);
    }

    return parts.map((part) => `- ${part}`).join("\n");
  }

  return isEnglish
    ? `In simpler words: ${source}`
    : `En palabras mas simples: ${source}`;
}

function buildListFallback(prompt, locale) {
  const isEnglish = locale === "en";

  return isEnglish
    ? "- Confirm the main point is clear.\n- Check names, dates, and important details.\n- Make sure the tone is respectful and professional.\n- Remove unnecessary words.\n- Read it once before sending."
    : "- Confirma que la idea principal este clara.\n- Revisa nombres, fechas y detalles importantes.\n- Asegurate de que el tono sea respetuoso y profesional.\n- Quita palabras innecesarias.\n- Leelo una vez antes de enviarlo.";
}

function buildWriteFallback(prompt, locale) {
  const text = normalizePromptText(prompt);
  const isEnglish = locale === "en";

  if (hasAny(text, ["cambio de horario", "cambiar horario", "change schedule", "schedule change"])) {
    return isEnglish
      ? "Hello, I hope you are doing well. I would like to request a schedule change and confirm if it would be possible. Please let me know what options are available or if you need any additional information from me. Thank you."
      : "Hola, espero que se encuentre bien. Queria solicitar un cambio de horario y confirmar si seria posible. Por favor, hagame saber que opciones estan disponibles o si necesita alguna informacion adicional de mi parte. Gracias.";
  }

  if (hasAny(text, ["llegare tarde", "voy a llegar tarde", "llegar tarde", "running late", "be late", "arrive late"])) {
    return isEnglish
      ? "Hello, I hope you are doing well. I wanted to let you know that I may arrive late today. I apologize for the inconvenience and will do my best to arrive as soon as possible. Thank you for your understanding."
      : "Hola, espero que se encuentre bien. Queria avisarle que podria llegar tarde hoy. Disculpe las molestias y hare lo posible por llegar lo antes posible. Gracias por su comprension.";
  }

  if (hasAny(text, ["cancelar una reunion", "cancelar reunion", "cancel meeting", "cancel a meeting"])) {
    return isEnglish
      ? "Hello, I hope you are doing well. I wanted to let you know that I need to cancel our meeting. I apologize for any inconvenience and would be happy to reschedule for another time that works for you. Thank you for your understanding."
      : "Hola, espero que se encuentre bien. Queria avisarle que necesito cancelar nuestra reunion. Disculpe cualquier inconveniente y con gusto podemos reprogramarla para otro momento que le funcione mejor. Gracias por su comprension.";
  }

  if (hasAny(text, ["dia libre", "dia de permiso", "pedir permiso", "day off", "time off"])) {
    return isEnglish
      ? "Hello, I hope you are doing well. I would like to request one day off and confirm if it would be possible. Please let me know if you need me to complete anything before that day. Thank you for your time. I look forward to your confirmation."
      : "Hola, espero que se encuentre bien. Queria solicitar un dia libre y confirmar si seria posible tomarlo. Por favor, hagame saber si necesita que complete algo antes de ese dia. Gracias por su tiempo. Quedo atento a su confirmacion.";
  }

  if (hasAny(text, ["reunion", "meeting", "cita", "appointment"])) {
    return isEnglish
      ? "Hello, I hope you are doing well. I would like to schedule a meeting to discuss this topic in more detail. Please let me know what day and time would work best for you. Thank you."
      : "Hola, espero que se encuentre bien. Queria solicitar una reunion para conversar este tema con mas detalle. Por favor, hagame saber que dia y hora le vendria mejor. Gracias.";
  }

  if (hasAny(text, ["disculpa", "perdon", "sorry", "apology", "apologize"])) {
    return isEnglish
      ? "Hello, I hope you are doing well. I wanted to sincerely apologize for the situation. I understand the inconvenience this may have caused and will make sure to handle it more carefully going forward. Thank you for your understanding."
      : "Hola, espero que se encuentre bien. Queria ofrecerle una disculpa sincera por lo ocurrido. Entiendo las molestias que esto pudo causar y me asegurare de manejarlo con mas cuidado en adelante. Gracias por su comprension.";
  }

  if (hasAny(text, ["seguimiento", "follow up", "respuesta", "reply", "respond", "responder"])) {
    return isEnglish
      ? "Hello, I hope you are doing well. I wanted to follow up on my previous message and check if there are any updates when you have a chance. Thank you for your time. I look forward to your response."
      : "Hola, espero que se encuentre bien. Queria dar seguimiento a mi mensaje anterior y consultar si hay alguna novedad cuando tenga oportunidad. Gracias por su tiempo. Quedo atento a su respuesta.";
  }

  if (hasAny(text, ["aumento", "raise", "salario", "salary", "pago", "payment"])) {
    return isEnglish
      ? "Hello, I hope you are doing well. I would like to discuss a work-related compensation matter when you have a chance. Please let me know a convenient time to talk. Thank you."
      : "Hola, espero que se encuentre bien. Queria conversar sobre un tema relacionado con compensacion laboral cuando tenga oportunidad. Por favor, hagame saber un momento conveniente para hablar. Gracias.";
  }

  return isEnglish
    ? "Hello, I hope you are doing well. I wanted to contact you regarding this request. Please let me know if it would be possible or if you need any additional information from me. Thank you for your time. I look forward to your response."
    : "Hola, espero que se encuentre bien. Queria contactarle respecto a esta solicitud. Por favor, hagame saber si seria posible o si necesita alguna informacion adicional de mi parte. Gracias por su tiempo. Quedo atento a su respuesta.";
}

function isClarifyingWriteAnswer(answer, locale) {
  const text = normalizePromptText(answer);
  if (!text) {
    return true;
  }

  return /\b(a quien|quien va dirigido|cual es|cuál es|motivo|objetivo|plazos|detalles|who is|who should|what is|could you provide|please provide)\b/.test(text);
}

function shouldForceTransformFallback(prompt) {
  const request = normalizePromptText(prompt);
  return /\b(puntos|bullet|bullet points|3 puntos|en puntos)\b/.test(request);
}

function isBadTransformAnswer(prompt, answer) {
  const request = normalizePromptText(prompt);
  const text = String(answer || "").trim();
  const normalizedAnswer = normalizePromptText(answer);

  if (/\b(puntos|bullet|bullet points|3 puntos)\b/.test(request)) {
    return !/^\s*(-|\d+[.)])\s+/m.test(text);
  }

  if (/\b(mas corta|mas corto|shorter)\b/.test(request)) {
    return normalizedAnswer.length > 260;
  }

  return false;
}

function isGenericExplainFallback(answer) {
  const text = normalizePromptText(answer);
  return /\b(esta pregunta pide explicar un concepto|this is asking for an explanation of a concept|send the exact topic|envia el tema exacto)\b/.test(text);
}

function isFormalDraftAnswer(answer) {
  const text = normalizePromptText(answer);
  return /\b(hola, espero que se encuentre bien|hello, i hope you are doing well|quedo atento|i look forward)\b/.test(text);
}

function buildRescueAnswer(prompt, locale, intent) {
  const isEnglish = locale === "en";
  const knownAnswer = buildKnownAnswer(prompt, locale);

  if (knownAnswer) {
    return knownAnswer;
  }

  if (intent === "write") {
    return buildWriteFallback(prompt, locale);
  }

  if (intent === "list") {
    return buildListFallback(prompt, locale);
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

  if (intent === "transform") {
    return buildTransformFallback(prompt, locale);
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

    if (intent === "transform" && shouldForceTransformFallback(prompt)) {
      answer = buildRescueAnswer(prompt, responseLocale, intent);
    } else if (!answer || (intent === "write" && isClarifyingWriteAnswer(answer, responseLocale)) || (intent === "list" && isFormalDraftAnswer(answer)) || (intent === "transform" && (isGenericExplainFallback(answer) || isBadTransformAnswer(prompt, answer)))) {
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
























