// Reliable models for production API calls
const GEMINI_MODELS_FALLBACK = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash'
];

// 🧠 IN-MEMORY DEDUPLICATION CACHE (Walang bayad, ginagamit ang RAM ng serverless instance)
const processedMessageIds = new Set();

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const ADMIN_PSID = process.env.ADMIN_PSID;
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    const body = req.body;

    if (body.object === 'page') {
      // 🚀 1. INSTANT HANDSHAKE (Pinipigilan ang Facebook Retry/Duplicate)
      res.status(200).send('EVENT_RECEIVED');

      // 🔄 2. ASYNC BACKGROUND PROCESS
      (async () => {
        try {
          for (const entry of body.entry) {
            if (!entry.messaging || !entry.messaging[0]) continue;
            
            const webhookEvent = entry.messaging[0];
            const senderPsid = webhookEvent.sender ? webhookEvent.sender.id : null;
            const messageId = webhookEvent.message ? webhookEvent.message.mid : null;

            if (!senderPsid) continue;

            // 🛑 IN-MEMORY DEDUPLICATION CHECK (Inaalis ang parehong message ID)
            if (messageId) {
              if (processedMessageIds.has(messageId)) {
                console.log(`[DEDUPLICATION] Inilagpasan ang duplicate Message ID: ${messageId}`);
                continue;
              }
              processedMessageIds.add(messageId);
              
              // Linisin ang memory paglipas ng ilang sandali para hindi mapuno
              setTimeout(() => processedMessageIds.delete(messageId), 300000);
            }

            // A. Postback Actions
            if (webhookEvent.postback) {
              const payload = webhookEvent.postback.payload;
              await handleCommandAction(senderPsid, payload, apiKeys, PAGE_ACCESS_TOKEN, ADMIN_PSID);
              continue;
            }

            // B. Attachments (Image, Audio/Voice Message, Documents)
            if (webhookEvent.message && webhookEvent.message.attachments) {
              const attachment = webhookEvent.message.attachments[0];

              // 🎙️ Speech-to-Text / Audio Voice Transcriber
              if (attachment.type === 'audio') {
                await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
                await sendTextMessage(senderPsid, "🎙️ **Pinapakinggan at isinalasalin ang boses...** ✨", PAGE_ACCESS_TOKEN);
                const voiceReply = await processAudioMessage(attachment.payload.url, apiKeys, senderPsid);
                await sendLongTextMessage(senderPsid, voiceReply, PAGE_ACCESS_TOKEN);
                await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
                continue;
              }

              // 📖 Image & Vision Analyzer
              if (attachment.type === 'image') {
                await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
                await sendTextMessage(senderPsid, "📖 **Sinu-suri ang iyong larawan...** ✨", PAGE_ACCESS_TOKEN);
                const visionReply = await analyzeHomeworkWithGemini(attachment.payload.url, apiKeys, senderPsid);
                await sendLongTextMessage(senderPsid, visionReply, PAGE_ACCESS_TOKEN);
                await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
                continue;
              }

              // 📑 Document / PDF Summarizer
              if (attachment.type === 'file') {
                await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
                await sendTextMessage(senderPsid, "📑 **Binabasa at pino-process ang dokumento...** ✨", PAGE_ACCESS_TOKEN);
                const docReply = await processDocumentFile(attachment.payload.url, apiKeys, senderPsid);
                await sendLongTextMessage(senderPsid, docReply, PAGE_ACCESS_TOKEN);
                await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
                continue;
              }
            }

            // C. Text Messages / Commands
            if (webhookEvent.message && !webhookEvent.message.is_echo) {
              const userMessage = webhookEvent.message.text ? webhookEvent.message.text.trim() : '';
              const quickReplyPayload = webhookEvent.message.quick_reply ? webhookEvent.message.quick_reply.payload : null;
              const finalMessage = quickReplyPayload || userMessage;

              if (!finalMessage) continue;

              // Periodic Table Command
              if (finalMessage.toLowerCase().includes('periodic table')) {
                await sendTextMessage(senderPsid, "🧪 **Periodic Table of Elements (HD)**", PAGE_ACCESS_TOKEN);
                await sendMediaAttachment(senderPsid, 'image', 'https://upload.wikimedia.org/wikipedia/commons/b/b3/Simple_Periodic_Table_Chart-en.svg', PAGE_ACCESS_TOKEN);
                continue;
              }

              // Command Processor
              const handled = await handleCommandAction(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN, ADMIN_PSID);
              if (handled) continue;

              await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);

              // 🔗 Web URL Auto-Detect Summarizer
              if (/https?:\/\/[^\s]+/i.test(finalMessage)) {
                await sendTextMessage(senderPsid, "🔗 *Binabasa ang nilalaman ng link...*", PAGE_ACCESS_TOKEN);
                await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
                const urlSummary = await fetchAndSummarizeUrl(finalMessage, apiKeys, senderPsid);
                await sendLongTextMessage(senderPsid, urlSummary, PAGE_ACCESS_TOKEN);
                await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
                continue;
              }

              // Live Web Grounding Search Condition
              const isRealtimeQuery = /weather|panahon|balita|news|ngayon|score|presyo|sino si|kailan|update/i.test(finalMessage);

              // Direct AI Processing
              await processDirectAI(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN, isRealtimeQuery);
            }
          }
        } catch (err) {
          console.error("Async Processing Error:", err);
        }
      })();

      return;
    }

    return res.status(404).send('Not Found');
  }

  return res.status(405).send('Method Not Allowed');
}

/**
 * ⚡ FAST GEMINI FALLBACK ENGINE (WITH CORRECT SEARCH GROUNDING SYNTAX)
 */
async function callGeminiApiWithFallback(payload, apiKeys, enableSearch = false, timeoutMs = 4500) {
  if (!apiKeys || apiKeys.length === 0) throw new Error('Walang API Key na ma-detect.');

  const requestBody = JSON.parse(JSON.stringify(payload));
  
  if (enableSearch) {
    requestBody.tools = [{ googleSearch: {} }];
  }

  let lastError = null;

  for (const modelName of GEMINI_MODELS_FALLBACK) {
    const apiKey = getRandomApiKey(apiKeys);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timer);
      const data = await response.json();

      if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }

  throw lastError || new Error('Lahat ng AI models ay busy.');
}

async function handleCommandAction(senderPsid, input, apiKeys, pageToken, adminPsid) {
  const lowerText = input.toLowerCase().trim();

  // Admin Dashboard Command
  if (['/stats', '/admin'].includes(lowerText)) {
    if (senderPsid !== adminPsid) {
      await sendTextMessage(senderPsid, "🚫 **Access Denied!** Para sa Admin lamang ang command na ito.", pageToken);
      return true;
    }
    const statsMsg = `📊 **JepongDevxyz AI Status**\n\n` +
                     `• Active Gemini Keys: **${apiKeys.length}**\n` +
                     `• Deduplication Memory: **Active 🟢**\n` +
                     `• System Status: **Operational 🟢**`;
    await sendTextMessage(senderPsid, statsMsg, pageToken);
    return true;
  }

  // Media Commands
  if (lowerText.startsWith('/imagen ')) {
    const prompt = input.replace(/^\/imagen\s*/i, '').trim();
    if (prompt) await generateAndSendImage(senderPsid, prompt, pageToken);
    return true;
  }

  // Academic Tools
  if (lowerText.startsWith('/math ')) {
    await sendTypingOn(senderPsid, pageToken);
    const mathProblem = input.replace(/^\/math\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Solve step-by-step: ${mathProblem}`, apiKeys, senderPsid);
    await sendLongTextMessage(senderPsid, `🧮 **Math Solution:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  if (lowerText.startsWith('/code ')) {
    await sendTypingOn(senderPsid, pageToken);
    const codeQuery = input.replace(/^\/code\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Help with code: ${codeQuery}`, apiKeys, senderPsid);
    await sendLongTextMessage(senderPsid, `💻 **Code Solution:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Interactive Quiz Game
  if (lowerText.startsWith('/quiz ')) {
    await sendTypingOn(senderPsid, pageToken);
    const topic = input.replace(/^\/quiz\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Create 1 multiple-choice review question about "${topic}" with 3 options labeled A, B, and C. State the question clearly.`, apiKeys, senderPsid);
    
    const quickReplies = [
      { content_type: "text", title: "Option A", payload: "Answered A" },
      { content_type: "text", title: "Option B", payload: "Answered B" },
      { content_type: "text", title: "Option C", payload: "Answered C" }
    ];
    await sendQuickReplyMessage(senderPsid, `❓ **Pop Quiz: ${topic}**\n\n${reply}`, quickReplies, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Help Menu
  if (['/commands', '/help', 'cmd_help'].includes(lowerText)) {
    await sendTypingOn(senderPsid, pageToken);
    const helpMsg = 
      "📚 **JepongDevxyz AI Help & Features**\n\n" +
      "🎨 **Media:** `/imagen [prompt]`, Voice Input, Image OCR\n" +
      "🎓 **Study:** `/math [prob]`, `/code [task]`, `/quiz [topic]`, PDF Files\n" +
      "🔗 **Web Links:** Mag-send ng URL link para i-summarize\n" +
      "⚡ **Status:** Direct & Instant AI Responses";
    await sendTextMessage(senderPsid, helpMsg, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  return false;
}

// Process Voice Messages
async function processAudioMessage(audioUrl, apiKeys, senderPsid) {
  try {
    const audioRes = await fetch(audioUrl);
    const buffer = await audioRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const payload = {
      system_instruction: { parts: [{ text: "You are JepongDevxyz AI created by Jay-Ar Lee Espiritu. Listen to this audio carefully, transcribe what was said, and then answer the user directly in Tagalog or English." }] },
      contents: [{
        parts: [
          { text: "Listen and respond:" },
          { inline_data: { mime_type: "audio/mp3", data: base64Data } }
        ]
      }]
    };

    return await callGeminiApiWithFallback(payload, apiKeys, false, 6000);
  } catch (e) {
    return '❌ Error sa pagproseso ng boses. Siguraduhing malinaw ang recording.';
  }
}

// Process PDF / Document Files
async function processDocumentFile(fileUrl, apiKeys, senderPsid) {
  try {
    const fileRes = await fetch(fileUrl);
    const buffer = await fileRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const payload = {
      system_instruction: { parts: [{ text: "You are JepongDevxyz AI created by Jay-Ar Lee Espiritu. Read and analyze this document file." }] },
      contents: [{
        parts: [
          { text: "Read and summarize this document:" },
          { inline_data: { mime_type: "application/pdf", data: base64Data } }
        ]
      }]
    };

    return await callGeminiApiWithFallback(payload, apiKeys, false, 8000);
  } catch (e) {
    return '❌ Error sa pagbasa ng file. Mas mainam kung PDF o Text file ang ipapadala.';
  }
}

// Summarize Webpage Content
async function fetchAndSummarizeUrl(url, apiKeys, senderPsid) {
  try {
    const payload = {
      system_instruction: { parts: [{ text: "You are JepongDevxyz AI created by Jay-Ar Lee Espiritu." }] },
      contents: [{ parts: [{ text: `Read and summarize the key facts from this webpage link: ${url}` }] }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, true, 5000);
  } catch (e) {
    return '❌ Hindi nabasa ang link. Maaaring pribado o protektado ang website.';
  }
}

async function generateAndSendImage(senderPsid, prompt, pageToken) {
  await sendTextMessage(senderPsid, `🖼️ **Ginagawa ang larawan para sa:**\n"${prompt}"...`, pageToken);
  const seed = Math.floor(Math.random() * 1000000);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}/image.jpg?width=1024&height=1024&nologo=true&seed=${seed}`;

  try {
    await sendMediaAttachment(senderPsid, 'image', imageUrl, pageToken);
  } catch (error) {
    await sendTextMessage(senderPsid, "❌ Paumanhin, nagka-error sa pag-load ng larawan.", pageToken);
  }
}

async function getDirectGeminiResponse(promptText, apiKeys, senderPsid) {
  try {
    const payload = {
      system_instruction: { parts: [{ text: "You are JepongDevxyz AI created by Jay-Ar Lee Espiritu. Helpful student tutor." }] },
      contents: [{ parts: [{ text: promptText }] }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, false, 3500);
  } catch (err) {
    return 'Pasensya na, may kaunting delay sa pagproseso.';
  }
}

async function analyzeHomeworkWithGemini(imageUrl, apiKeys, senderPsid) {
  try {
    const imgRes = await fetch(imageUrl);
    const buffer = await imgRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const payload = {
      system_instruction: { parts: [{ text: "You are JepongDevxyz AI created by Jay-Ar Lee Espiritu." }] },
      contents: [{
        parts: [
          { text: "Analyze this image in detail:" },
          { inline_data: { mime_type: "image/jpeg", data: base64Data } }
        ]
      }]
    };

    return await callGeminiApiWithFallback(payload, apiKeys, false, 5000);
  } catch (e) {
    return 'Error sa pag-analyze ng larawan.';
  }
}

async function processDirectAI(senderPsid, userMessage, apiKeys, pageToken, enableSearch = false) {
  try {
    const payload = {
      system_instruction: { parts: [{ text: "You are JepongDevxyz AI created by Jay-Ar Lee Espiritu. Helpful student tutor. Respond dynamically in the same language as the user (Tagalog/English)." }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }]
    };

    const aiReply = await callGeminiApiWithFallback(payload, apiKeys, enableSearch, 4500);
    await sendLongTextMessage(senderPsid, aiReply, pageToken);
    await sendTypingOff(senderPsid, pageToken);
  } catch (error) {
    await sendTextMessage(senderPsid, "Medyo matagal sumagot ang AI server. Paki-subukan ulit sa sandali.", pageToken);
    await sendTypingOff(senderPsid, pageToken);
  }
}

function getRandomApiKey(keysList) {
  if (!keysList || keysList.length === 0) return null;
  return keysList[Math.floor(Math.random() * keysList.length)];
}

async function sendTypingOn(senderPsid, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderPsid }, sender_action: "typing_on" })
  });
}

async function sendTypingOff(senderPsid, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderPsid }, sender_action: "typing_off" })
  });
}

async function sendQuickReplyMessage(senderPsid, text, quickReplies, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: senderPsid },
      message: { text: text, quick_replies: quickReplies }
    })
  });
}

async function sendMediaAttachment(senderPsid, type, url, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderPsid }, message: { attachment: { type: type, payload: { url: url, is_reusable: true } } } })
  });
}

async function sendLongTextMessage(senderPsid, responseText, pageToken) {
  const MAX_LIMIT = 1900;
  if (responseText.length <= MAX_LIMIT) {
    await sendTextMessage(senderPsid, responseText, pageToken);
  } else {
    const chunks = responseText.match(new RegExp(`.{1,${MAX_LIMIT}}`, 'g')) || [];
    for (const chunk of chunks) {
      await sendTextMessage(senderPsid, chunk, pageToken);
    }
  }
}

async function sendTextMessage(senderPsid, responseText, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderPsid }, message: { text: responseText } })
  });
}
