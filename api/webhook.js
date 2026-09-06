// webhook.js
// Facebook Messenger Webhook + Gemini AI
// Node.js / Vercel Serverless

// ============================================================
// GEMINI MODELS
// ============================================================

const GEMINI_MODELS_FALLBACK = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];

// ============================================================
// GLOBAL STATE
// NOTE: Serverless instances are temporary.
// These Maps/Sets are NOT permanent database storage.
// ============================================================

let currentKeyIndex = 0;

const processedMessageIds = new Set();
const userPersonasMap = new Map();
const userConversationsMap = new Map();

// ============================================================
// HELPERS
// ============================================================

function getRotatedApiKey(keysList) {
  if (!Array.isArray(keysList) || keysList.length === 0) {
    return null;
  }

  const safeIndex = currentKeyIndex % keysList.length;
  const apiKey = keysList[safeIndex];

  currentKeyIndex =
    (currentKeyIndex + 1) % keysList.length;

  return apiKey;
}

function getApiKeys() {
  const rawKeys =
    process.env.GEMINI_API_KEYS ||
    process.env.GEMINI_API_KEY ||
    "";

  return rawKeys
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

function getPageToken() {
  return process.env.PAGE_ACCESS_TOKEN || "";
}

function getVerifyToken() {
  return process.env.VERIFY_TOKEN || "";
}

function getAdminPsid() {
  return process.env.ADMIN_PSID || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

// ============================================================
// MAIN WEBHOOK HANDLER
// ============================================================

export default async function handler(req, res) {
  const VERIFY_TOKEN = getVerifyToken();
  const PAGE_ACCESS_TOKEN = getPageToken();
  const ADMIN_PSID = getAdminPsid();
  const apiKeys = getApiKeys();

  // ----------------------------------------------------------
  // GET = Facebook Webhook Verification
  // ----------------------------------------------------------

  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    if (
      mode === "subscribe" &&
      token &&
      VERIFY_TOKEN &&
      token === VERIFY_TOKEN
    ) {
      console.log("[WEBHOOK] Verification successful.");
      return res.status(200).send(challenge);
    }

    console.warn("[WEBHOOK] Verification failed.");

    return res
      .status(403)
      .send("Forbidden");
  }

  // ----------------------------------------------------------
  // POST = Facebook Messenger Events
  // ----------------------------------------------------------

  if (req.method === "POST") {
    if (!PAGE_ACCESS_TOKEN) {
      console.error(
        "[CONFIG] PAGE_ACCESS_TOKEN is missing."
      );

      return res
        .status(500)
        .send("Server configuration error.");
    }

    const body = req.body;

    if (!body || body.object !== "page") {
      return res
        .status(404)
        .send("Not Found");
    }

    try {
      const entries = Array.isArray(body.entry)
        ? body.entry
        : [];

      for (const entry of entries) {
        const messagingEvents = Array.isArray(
          entry.messaging
        )
          ? entry.messaging
          : [];

        for (const webhookEvent of messagingEvents) {
          await processWebhookEvent(
            webhookEvent,
            apiKeys,
            PAGE_ACCESS_TOKEN,
            ADMIN_PSID
          );
        }
      }

      return res
        .status(200)
        .send("EVENT_RECEIVED");

    } catch (error) {
      console.error(
        "[WEBHOOK ERROR]",
        error
      );

      // Facebook expects a successful acknowledgement.
      return res
        .status(200)
        .send("EVENT_RECEIVED");
    }
  }

  return res
    .status(405)
    .send("Method Not Allowed");
}

// ============================================================
// PROCESS ONE FACEBOOK EVENT
// ============================================================

async function processWebhookEvent(
  webhookEvent,
  apiKeys,
  pageToken,
  adminPsid
) {
  if (!webhookEvent) {
    return;
  }

  const senderPsid =
    webhookEvent.sender?.id || null;

  if (!senderPsid) {
    return;
  }

  // ----------------------------------------------------------
  // DEDUPLICATION
  // ----------------------------------------------------------

  const messageId =
    webhookEvent.message?.mid ||
    webhookEvent.postback?.mid ||
    null;

  if (messageId) {
    if (processedMessageIds.has(messageId)) {
      console.log(
        `[DEDUPLICATION] Skipped: ${messageId}`
      );

      return;
    }

    processedMessageIds.add(messageId);

    setTimeout(() => {
      processedMessageIds.delete(messageId);
    }, 5 * 60 * 1000);
  }

  // ----------------------------------------------------------
  // POSTBACK
  // ----------------------------------------------------------

  if (webhookEvent.postback) {
    const payload =
      webhookEvent.postback.payload || "";

    await handleCommandAction(
      senderPsid,
      payload,
      apiKeys,
      pageToken,
      adminPsid
    );

    return;
  }

  // ----------------------------------------------------------
  // IGNORE ECHO
  // ----------------------------------------------------------

  if (
    webhookEvent.message?.is_echo
  ) {
    return;
  }

  // ----------------------------------------------------------
  // ATTACHMENTS
  // ----------------------------------------------------------

  const attachments =
    webhookEvent.message?.attachments;

  if (
    Array.isArray(attachments) &&
    attachments.length > 0
  ) {
    for (const attachment of attachments) {
      await processAttachment(
        senderPsid,
        attachment,
        apiKeys,
        pageToken
      );
    }

    return;
  }

  // ----------------------------------------------------------
  // TEXT MESSAGE
  // ----------------------------------------------------------

  const userMessage = safeText(
    webhookEvent.message?.text
  );

  const quickReplyPayload =
    safeText(
      webhookEvent.message?.quick_reply?.payload
    );

  const finalMessage =
    quickReplyPayload ||
    userMessage;

  if (!finalMessage) {
    return;
  }

  // ----------------------------------------------------------
  // PERIODIC TABLE
  // ----------------------------------------------------------

  if (
    finalMessage
      .toLowerCase()
      .includes("periodic table")
  ) {
    await sendTextMessage(
      senderPsid,
      "🧪 Periodic Table of Elements",
      pageToken
    );

    await sendMediaAttachment(
      senderPsid,
      "image",
      "https://upload.wikimedia.org/wikipedia/commons/b/b3/Simple_Periodic_Table_Chart-en.svg",
      pageToken
    );

    return;
  }

  // ----------------------------------------------------------
  // COMMANDS
  // ----------------------------------------------------------

  const handled =
    await handleCommandAction(
      senderPsid,
      finalMessage,
      apiKeys,
      pageToken,
      adminPsid
    );

  if (handled) {
    return;
  }

  // ----------------------------------------------------------
  // URL DETECTION
  // ----------------------------------------------------------

  await sendTypingOn(
    senderPsid,
    pageToken
  );

  try {
    const hasUrl =
      /https?:\/\/[^\s]+/i.test(
        finalMessage
      );

    if (hasUrl) {
      const urlSummary =
        await fetchAndSummarizeUrl(
          finalMessage,
          apiKeys
        );

      await sendLongTextMessage(
        senderPsid,
        urlSummary,
        pageToken
      );

      return;
    }

    // --------------------------------------------------------
    // NORMAL AI CHAT
    // --------------------------------------------------------

    await processDirectAI(
      senderPsid,
      finalMessage,
      apiKeys,
      pageToken
    );

  } finally {
    await sendTypingOff(
      senderPsid,
      pageToken
    );
  }
}

// ============================================================
// ATTACHMENT PROCESSOR
// ============================================================

async function processAttachment(
  senderPsid,
  attachment,
  apiKeys,
  pageToken
) {
  if (!attachment?.type) {
    return;
  }

  const type = attachment.type;
  const url =
    attachment.payload?.url;

  if (!url) {
    await sendTextMessage(
      senderPsid,
      "❌ Hindi ko mabasa ang attachment.",
      pageToken
    );

    return;
  }

  await sendTypingOn(
    senderPsid,
    pageToken
  );

  try {
    if (type === "audio") {
      const reply =
        await processAudioMessage(
          url,
          apiKeys
        );

      await sendLongTextMessage(
        senderPsid,
        reply,
        pageToken
      );

      return;
    }

    if (type === "image") {
      const reply =
        await analyzeHomeworkWithGemini(
          url,
          apiKeys
        );

      await sendLongTextMessage(
        senderPsid,
        reply,
        pageToken
      );

      return;
    }

    if (
      type === "file" ||
      type === "document"
    ) {
      const reply =
        await processDocumentFile(
          url,
          apiKeys
        );

      await sendLongTextMessage(
        senderPsid,
        reply,
        pageToken
      );

      return;
    }

    await sendTextMessage(
      senderPsid,
      `📎 Natanggap ko ang ${type} attachment, pero hindi pa ito supported.`,
      pageToken
    );

  } catch (error) {
    console.error(
      "[ATTACHMENT ERROR]",
      error
    );

    await sendTextMessage(
      senderPsid,
      "❌ Nagkaroon ng problema sa pagproseso ng attachment.",
      pageToken
    );

  } finally {
    await sendTypingOff(
      senderPsid,
      pageToken
    );
  }
}

// ============================================================
// GEMINI API WITH ROTATIONAL FALLBACK
// ============================================================

async function callGeminiApiWithFallback(
  payload,
  apiKeys,
  maxTotalTimeoutMs = 15000
) {
  if (
    !Array.isArray(apiKeys) ||
    apiKeys.length === 0
  ) {
    throw new Error(
      "Walang Gemini API key."
    );
  }

  const startTime = Date.now();

  let lastError = null;

  const maxAttempts = Math.min(
    apiKeys.length *
      GEMINI_MODELS_FALLBACK.length,
    12
  );

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {
    if (
      Date.now() - startTime >=
      maxTotalTimeoutMs
    ) {
      break;
    }

    const modelName =
      GEMINI_MODELS_FALLBACK[
        Math.floor(
          attempt / apiKeys.length
        ) %
          GEMINI_MODELS_FALLBACK.length
      ];

    const apiKey =
      getRotatedApiKey(apiKeys);

    if (!apiKey) {
      break;
    }

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    const controller =
      new AbortController();

    const remainingTime =
      maxTotalTimeoutMs -
      (Date.now() - startTime);

    const requestTimeout = Math.min(
      5000,
      Math.max(1000, remainingTime)
    );

    const timer = setTimeout(
      () => controller.abort(),
      requestTimeout
    );

    try {
      const requestBody =
        JSON.parse(
          JSON.stringify(payload)
        );

      // Google Search grounding.
      requestBody.tools = [
        {
          googleSearch: {}
        }
      ];

      const response =
        await fetch(
          endpoint,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
              "x-goog-api-key":
                apiKey
            },

            body: JSON.stringify(
              requestBody
            ),

            signal: controller.signal
          }
        );

      clearTimeout(timer);

      const data =
        await response.json();

      if (response.ok) {
        const text =
          extractGeminiText(data);

        if (text) {
          console.log(
            `[GEMINI] Success: ${modelName}`
          );

          return text;
        }
      }

      const errorMessage =
        data?.error?.message ||
        `HTTP ${response.status}`;

      lastError =
        new Error(errorMessage);

      console.warn(
        `[GEMINI] Attempt ${
          attempt + 1
        } failed | ${modelName} | ${errorMessage}`
      );

    } catch (error) {
      clearTimeout(timer);

      lastError = error;

      console.warn(
        `[GEMINI] ${modelName} failed:`,
        error?.message ||
          error
      );
    }

    await sleep(150);
  }

  throw (
    lastError ||
    new Error(
      "Kasalukuyang unavailable ang Gemini models."
    )
  );
}

// ============================================================
// EXTRACT GEMINI TEXT
// ============================================================

function extractGeminiText(data) {
  const candidates =
    data?.candidates;

  if (
    !Array.isArray(candidates) ||
    candidates.length === 0
  ) {
    return "";
  }

  const parts =
    candidates[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .filter(
      (part) =>
        typeof part?.text ===
        "string"
    )
    .map(
      (part) => part.text
    )
    .join("\n")
    .trim();
}

// ============================================================
// COMMAND HANDLER
// ============================================================

async function handleCommandAction(
  senderPsid,
  input,
  apiKeys,
  pageToken,
  adminPsid
) {
  const text =
    safeText(input);

  const lowerText =
    text.toLowerCase();

  // ----------------------------------------------------------
  // ADMIN / STATS
  // ----------------------------------------------------------

  if (
    ["/stats", "/admin"].includes(
      lowerText
    )
  ) {
    if (
      !adminPsid ||
      senderPsid !== adminPsid
    ) {
      await sendTextMessage(
        senderPsid,
        "🚫 Access Denied!",
        pageToken
      );

      return true;
    }

    await sendTextMessage(
      senderPsid,
      [
        "📊 AI Status",
        "",
        `• Active Keys: ${apiKeys.length}`,
        "• Gemini: Operational 🟢",
        "• Search: Enabled",
        "• Continuous Chat: Enabled"
      ].join("\n"),
      pageToken
    );

    return true;
  }

  // ----------------------------------------------------------
  // IMAGE COMMAND
  // ----------------------------------------------------------

  if (
    lowerText.startsWith(
      "/imagen "
    )
  ) {
    const prompt =
      text
        .replace(
          /^\/imagen\s+/i,
          ""
        )
        .trim();

    if (!prompt) {
      await sendTextMessage(
        senderPsid,
        "Gamitin: /imagen [description]",
        pageToken
      );

      return true;
    }

    await generateAndSendImage(
      senderPsid,
      prompt,
      pageToken
    );

    return true;
  }

  // ----------------------------------------------------------
  // MATH
  // ----------------------------------------------------------

  if (
    lowerText.startsWith(
      "/math "
    )
  ) {
    const problem =
      text
        .replace(
          /^\/math\s+/i,
          ""
        )
        .trim();

    if (!problem) {
      await sendTextMessage(
        senderPsid,
        "Gamitin: /math [problem]",
        pageToken
      );

      return true;
    }

    await sendTypingOn(
      senderPsid,
      pageToken
    );

    try {
      const reply =
        await getDirectGeminiResponse(
          `Solve this math problem step-by-step. Explain clearly and verify the final answer:\n\n${problem}`,
          apiKeys
        );

      await sendLongTextMessage(
        senderPsid,
        `🧮 Math Solution\n\n${reply}`,
        pageToken
      );
    } finally {
      await sendTypingOff(
        senderPsid,
        pageToken
      );
    }

    return true;
  }

  // ----------------------------------------------------------
  // CODE
  // ----------------------------------------------------------

  if (
    lowerText.startsWith(
      "/code "
    )
  ) {
    const codeQuery =
      text
        .replace(
          /^\/code\s+/i,
          ""
        )
        .trim();

    if (!codeQuery) {
      await sendTextMessage(
        senderPsid,
        "Gamitin: /code [task]",
        pageToken
      );

      return true;
    }

    await sendTypingOn(
      senderPsid,
      pageToken
    );

    try {
      const reply =
        await getDirectGeminiResponse(
          `Help with this programming task. Provide a correct, clean and complete solution:\n\n${codeQuery}`,
          apiKeys
        );

      await sendLongTextMessage(
        senderPsid,
        `💻 Code Solution\n\n${reply}`,
        pageToken
      );
    } finally {
      await sendTypingOff(
        senderPsid,
        pageToken
      );
    }

    return true;
  }

  // ----------------------------------------------------------
  // HELP
  // ----------------------------------------------------------

  if (
    ["/commands", "/help"].includes(
      lowerText
    )
  ) {
    await sendTextMessage(
      senderPsid,
      [
        "📚 AI Help Menu",
        "",
        "🎨 /imagen [prompt]",
        "🧮 /math [problem]",
        "💻 /code [task]",
        "🔄 /reset",
        "🔄 /refresh"
      ].join("\n"),
      pageToken
    );

    return true;
  }

  return false;
}

// ============================================================
// AUDIO
// ============================================================

async function processAudioMessage(
  audioUrl,
  apiKeys
) {
  try {
    const response =
      await fetch(audioUrl);

    if (!response.ok) {
      throw new Error(
        `Audio download failed: ${response.status}`
      );
    }

    const arrayBuffer =
      await response.arrayBuffer();

    const base64Data =
      Buffer.from(
        arrayBuffer
      ).toString("base64");

    const mimeType =
      response.headers.get(
        "content-type"
      ) ||
      "audio/mpeg";

    const payload = {
      systemInstruction: {
        parts: [
          {
            text:
              "You are an AI assistant. Transcribe and understand the user's audio. Respond in clear Tagalog or English."
          }
        ]
      },

      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Listen to this audio and answer the user's request."
            },
            {
              inlineData: {
                mimeType,
                data: base64Data
              }
            }
          ]
        }
      ]
    };

    return await callGeminiApiWithFallback(
      payload,
      apiKeys,
      10000
    );

  } catch (error) {
    console.error(
      "[AUDIO ERROR]",
      error
    );

    return (
      "❌ Hindi ko ma-process ang audio ngayon."
    );
  }
}

// ============================================================
// DOCUMENT / PDF
// ============================================================

async function processDocumentFile(
  fileUrl,
  apiKeys
) {
  try {
    const response =
      await fetch(fileUrl);

    if (!response.ok) {
      throw new Error(
        `File download failed: ${response.status}`
      );
    }

    const arrayBuffer =
      await response.arrayBuffer();

    const base64Data =
      Buffer.from(
        arrayBuffer
      ).toString("base64");

    const mimeType =
      response.headers.get(
        "content-type"
      ) ||
      "application/pdf";

    const payload = {
      systemInstruction: {
        parts: [
          {
            text:
              "You are an AI assistant that reads and explains documents clearly."
          }
        ]
      },

      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Read this document and summarize the important information. If it is a school document, explain it in a student-friendly way."
            },
            {
              inlineData: {
                mimeType,
                data: base64Data
              }
            }
          ]
        }
      ]
    };

    return await callGeminiApiWithFallback(
      payload,
      apiKeys,
      10000
    );

  } catch (error) {
    console.error(
      "[DOCUMENT ERROR]",
      error
    );

    return (
      "❌ Hindi ko mabasa ang file ngayon."
    );
  }
}

// ============================================================
// URL SUMMARY
// ============================================================

async function fetchAndSummarizeUrl(
  url,
  apiKeys
) {
  try {
    const payload = {
      systemInstruction: {
        parts: [
          {
            text:
              "You are a helpful assistant. When web search is available, use it to provide accurate information. Be transparent if the supplied URL cannot be directly accessed."
          }
        ]
      },

      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `Analyze the following URL/topic and provide a useful summary:\n\n${url}`
            }
          ]
        }
      ]
    };

    return await callGeminiApiWithFallback(
      payload,
      apiKeys,
      10000
    );

  } catch (error) {
    console.error(
      "[URL ERROR]",
      error
    );

    return (
      "❌ Hindi ko ma-process ang link ngayon."
    );
  }
}

// ============================================================
// IMAGE GENERATION
// ============================================================

async function generateAndSendImage(
  senderPsid,
  prompt,
  pageToken
) {
  await sendTextMessage(
    senderPsid,
    "🖼️ Ginagawa ang larawan...",
    pageToken
  );

  const seed =
    Math.floor(
      Math.random() * 1000000
    );

  const imageUrl =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(
      prompt
    )}/image.jpg?width=1024&height=1024&nologo=true&seed=${seed}`;

  try {
    await sendMediaAttachment(
      senderPsid,
      "image",
      imageUrl,
      pageToken
    );
  } catch (error) {
    console.error(
      "[IMAGE ERROR]",
      error
    );

    await sendTextMessage(
      senderPsid,
      "❌ Hindi ma-load ang generated image.",
      pageToken
    );
  }
}

// ============================================================
// DIRECT GEMINI RESPONSE
// ============================================================

async function getDirectGeminiResponse(
  promptText,
  apiKeys
) {
  try {
    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: promptText
            }
          ]
        }
      ]
    };

    return await callGeminiApiWithFallback(
      payload,
      apiKeys,
      10000
    );

  } catch (error) {
    console.error(
      "[DIRECT AI ERROR]",
      error
    );

    return (
      "Pasensya na, may problema sa AI service. Pakisubukan muli."
    );
  }
}

// ============================================================
// IMAGE ANALYSIS / HOMEWORK
// ============================================================

async function analyzeHomeworkWithGemini(
  imageUrl,
  apiKeys
) {
  try {
    const response =
      await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(
        `Image download failed: ${response.status}`
      );
    }

    const arrayBuffer =
      await response.arrayBuffer();

    const base64Data =
      Buffer.from(
        arrayBuffer
      ).toString("base64");

    const mimeType =
      response.headers.get(
        "content-type"
      ) ||
      "image/jpeg";

    const payload = {
      systemInstruction: {
        parts: [
          {
            text:
              "You are a helpful school assistant. Analyze images of homework, notes, worksheets, diagrams, and educational materials. Explain the answer clearly and show steps when appropriate."
          }
        ]
      },

      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Analyze this image and help the student understand or solve what is shown."
            },
            {
              inlineData: {
                mimeType,
                data: base64Data
              }
            }
          ]
        }
      ]
    };

    return await callGeminiApiWithFallback(
      payload,
      apiKeys,
      10000
    );

  } catch (error) {
    console.error(
      "[VISION ERROR]",
      error
    );

    return (
      "❌ Hindi ko ma-analyze ang image ngayon."
    );
  }
}

// ============================================================
// FACEBOOK USER NAME
// ============================================================

async function getFacebookUserName(
  senderPsid,
  pageToken
) {
  try {
    const url =
      new URL(
        `https://graph.facebook.com/v19.0/${encodeURIComponent(
          senderPsid
        )}`
      );

    url.searchParams.set(
      "fields",
      "first_name"
    );

    url.searchParams.set(
      "access_token",
      pageToken
    );

    const response =
      await fetch(
        url.toString()
      );

    const data =
      await response.json();

    if (
      response.ok &&
      data?.first_name
    ) {
      return data.first_name;
    }

  } catch (error) {
    console.error(
      "[FACEBOOK USER ERROR]",
      error
    );
  }

  return "Boss";
}

// ============================================================
// MAIN AI CHAT
// ============================================================

async function processDirectAI(
  senderPsid,
  userMessage,
  apiKeys,
  pageToken
) {
  try {
    const firstName =
      await getFacebookUserName(
        senderPsid,
        pageToken
      );

    const lowerMsg =
      userMessage.toLowerCase();

    // --------------------------------------------------------
    // RESET
    // --------------------------------------------------------

    const resetCommands = [
      "/reset",
      "/refresh",
      "/normal",
      "ibalik sa dati",
      "normal mode",
      "tama na ang akting"
    ];

    if (
      resetCommands.some(
        (command) =>
          lowerMsg === command ||
          lowerMsg.includes(
            command
          )
      )
    ) {
      userPersonasMap.delete(
        senderPsid
      );

      userConversationsMap.delete(
        senderPsid
      );

      await sendTextMessage(
        senderPsid,
        `✅ Na-reset na ang mode at conversation memory. Bumalik na ako sa normal AI assistant mode, ${firstName}!`,
        pageToken
      );

      return;
    }

    // --------------------------------------------------------
    // PERSONA
    // --------------------------------------------------------

    let currentPersona =
      userPersonasMap.get(
        senderPsid
      ) || null;

    const isPersonaTrigger =
      /umakting ka|maging|gayahin mo|ikaw si|parang|gawin mo akong|acting|pretend/i.test(
        userMessage
      );

    if (
      isPersonaTrigger &&
      !currentPersona
    ) {
      currentPersona =
        userMessage;

      userPersonasMap.set(
        senderPsid,
        currentPersona
      );
    }

    // --------------------------------------------------------
    // CONVERSATION HISTORY
    // --------------------------------------------------------

    let history =
      userConversationsMap.get(
        senderPsid
      ) || [];

    history.push({
      role: "user",
      parts: [
        {
          text: userMessage
        }
      ]
    });

    // Keep latest 10 turns.
    if (history.length > 10) {
      history =
        history.slice(
          history.length - 10
        );
    }

    let systemInstructionText = `
You are an AI assistant chatting with ${firstName} through Facebook Messenger.

Respond naturally in the same language used by the user, primarily Tagalog or English.

You are especially helpful for students:
- Explain concepts clearly.
- Show steps when solving problems.
- Help with programming and school work.
- Do not pretend to know something when uncertain.
- Keep responses organized and readable.
- Avoid unnecessary repetition.

When appropriate, address the user as ${firstName}.
`.trim();

    // --------------------------------------------------------
    // PERSONA
    // --------------------------------------------------------

    if (currentPersona) {
      systemInstructionText += `

The user requested this persona/style:

"${currentPersona}"

Follow the requested style while remaining helpful, safe, and truthful.
The persona remains active until the user asks to reset or return to normal mode.
`;
    }

    const payload = {
      systemInstruction: {
        parts: [
          {
            text:
              systemInstructionText
          }
        ]
      },

      contents: history
    };

    const aiReply =
      await callGeminiApiWithFallback(
        payload,
        apiKeys,
        10000
      );

    // --------------------------------------------------------
    // SAVE AI RESPONSE
    // --------------------------------------------------------

    history.push({
      role: "model",
      parts: [
        {
          text: aiReply
        }
      ]
    });

    if (history.length > 10) {
      history =
        history.slice(
          history.length - 10
        );
    }

    userConversationsMap.set(
      senderPsid,
      history
    );

    await sendLongTextMessage(
      senderPsid,
      aiReply,
      pageToken
    );

  } catch (error) {
    console.error(
      "[AI PROCESSING ERROR]",
      error
    );

    await sendTextMessage(
      senderPsid,
      "⚠️ Medyo busy ang AI server ngayon. Pakisubukan muli.",
      pageToken
    );
  }
}

// ============================================================
// FACEBOOK GRAPH API
// ============================================================

async function facebookSend(
  payload,
  pageToken
) {
  if (!pageToken) {
    throw new Error(
      "PAGE_ACCESS_TOKEN is missing."
    );
  }

  const url =
    new URL(
      "https://graph.facebook.com/v19.0/me/messages"
    );

  url.searchParams.set(
    "access_token",
    pageToken
  );

  const response =
    await fetch(
      url.toString(),
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify(
          payload
        )
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    console.error(
      "[FACEBOOK API ERROR]",
      data
    );

    throw new Error(
      data?.error?.message ||
        `Facebook API error: ${response.status}`
    );
  }

  return data;
}

// ============================================================
// TYPING ON
// ============================================================

async function sendTypingOn(
  senderPsid,
  pageToken
) {
  try {
    await facebookSend(
      {
        recipient: {
          id: senderPsid
        },
        sender_action:
          "typing_on"
      },
      pageToken
    );
  } catch (error) {
    console.error(
      "[TYPING ON ERROR]",
      error?.message
    );
  }
}

// ============================================================
// TYPING OFF
// ============================================================

async function sendTypingOff(
  senderPsid,
  pageToken
) {
  try {
    await facebookSend(
      {
        recipient: {
          id: senderPsid
        },
        sender_action:
          "typing_off"
      },
      pageToken
    );
  } catch (error) {
    console.error(
      "[TYPING OFF ERROR]",
      error?.message
    );
  }
}

// ============================================================
// MEDIA
// ============================================================

async function sendMediaAttachment(
  senderPsid,
  type,
  url,
  pageToken
) {
  return facebookSend(
    {
      recipient: {
        id: senderPsid
      },

      message: {
        attachment: {
          type,

          payload: {
            url,
            is_reusable: true
          }
        }
      }
    },
    pageToken
  );
}

// ============================================================
// LONG TEXT
// ============================================================

async function sendLongTextMessage(
  senderPsid,
  responseText,
  pageToken
) {
  const text =
    safeText(responseText);

  if (!text) {
    return;
  }

  // Facebook Messenger safe chunk size.
  const MAX_LIMIT = 1900;

  if (
    text.length <=
    MAX_LIMIT
  ) {
    await sendTextMessage(
      senderPsid,
      text,
      pageToken
    );

    return;
  }

  let remaining = text;

  while (
    remaining.length >
    MAX_LIMIT
  ) {
    let splitIndex =
      remaining.lastIndexOf(
        "\n",
        MAX_LIMIT
      );

    if (
      splitIndex < 500
    ) {
      splitIndex =
        remaining.lastIndexOf(
          " ",
          MAX_LIMIT
        );
    }

    if (
      splitIndex <= 0
    ) {
      splitIndex =
        MAX_LIMIT;
    }

    const chunk =
      remaining
        .slice(
          0,
          splitIndex
        )
        .trim();

    remaining =
      remaining
        .slice(
          splitIndex
        )
        .trim();

    if (chunk) {
      await sendTextMessage(
        senderPsid,
        chunk,
        pageToken
      );
    }
  }

  if (remaining) {
    await sendTextMessage(
      senderPsid,
      remaining,
      pageToken
    );
  }
}

// ============================================================
// TEXT MESSAGE
// ============================================================

async function sendTextMessage(
  senderPsid,
  responseText,
  pageToken
) {
  return facebookSend(
    {
      recipient: {
        id: senderPsid
      },

      message: {
        text:
          safeText(responseText)
      }
    },
    pageToken
  );
}
