import { kv } from '@vercel/kv';

// Reliable models for fallback
const GEMINI_MODELS_FALLBACK = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite'
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b'
];

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const ADMIN_PSID = process.env.ADMIN_PSID; // Ang iyong Facebook Sender ID
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
      // 🚀 1. FAST HANDSHAKE (Sumagot agad sa FB sa loob ng 1s)
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

            // 🛑 3. MESSAGE DEDUPLICATION CHECK
            if (messageId) {
              try {
                const isProcessed = await kv.get(`processed_msg_${messageId}`);
                if (isProcessed) continue;
                await kv.set(`processed_msg_${messageId}`, 'true', { ex: 600 });
              } catch (kvErr) {
                console.error("KV Deduplication Error:", kvErr);
              }
            }

            // Track Total Messages for Admin Analytics (/stats)
            try { await kv.incr('analytics_total_messages'); } catch (e) {}

            // A. Postback Actions
            if (webhookEvent.postback) {
              const payload = webhookEvent.postback.payload;
              await handleCommandAction(senderPsid, payload, apiKeys, PAGE_ACCESS_TOKEN, ADMIN_PSID);
              continue;
            }

            // B. Attachments (Image, Audio/Voice Message, Documents)
            if (webhookEvent.message && webhookEvent.message.attachments) {
              const attachment = webhookEvent.message.attachments[0];

              // 🎙️ Feature 1: Speech-to-Text / Audio Voice Transcriber
              if (attachment.type === 'audio') {
                await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
                await sendTextMessage(senderPsid, "🎙️ **Pinapakinggan at isinalasalin ang boses...** ✨", PAGE_ACCESS_TOKEN);
                const voiceReply = await processAudioMessage(attachment.payload.url, apiKeys, senderPsid);
                await sendLongTextMessage(senderPsid, voiceReply, PAGE_ACCESS_TOKEN);
                await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
                continue;
              }

              // 📖 Feature 2: Image & Vision Analyzer
              if (attachment.type === 'image') {
                await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
                await sendTextMessage(senderPsid, "📖 **Sinu-suri ang iyong larawan...** ✨", PAGE_ACCESS_TOKEN);
                const visionReply = await analyzeHomeworkWithGemini(attachment.payload.url, apiKeys, senderPsid);
                await sendLongTextMessage(senderPsid, visionReply, PAGE_ACCESS_TOKEN);
                await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
                continue;
              }

              // 📑 Feature 3: Document / PDF Summarizer
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

              // Smart Periodic Table Command
              if (finalMessage.toLowerCase().includes('periodic table')) {
                await sendTextMessage(senderPsid, "🧪 **Periodic Table of Elements (HD)**", PAGE_ACCESS_TOKEN);
                await sendMediaAttachment(senderPsid, 'image', 'https://upload.wikimedia.org/wikipedia/commons/b/b3/Simple_Periodic_Table_Chart-en.svg', PAGE_ACCESS_TOKEN);
                continue;
              }

              let userMode = null;
              try { userMode = await kv.get(`user_mode_${senderPsid}`); } catch (e) {}

              // Image Generator Input Mode
              if (userMode === 'IMAGE_MODE') {
                await kv.del(`user_mode_${senderPsid}`);
                await generateAndSendImage(senderPsid, finalMessage, PAGE_ACCESS_TOKEN);
                continue;
              }

              // Command Processor
              const handled = await handleCommandAction(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN, ADMIN_PSID);
              if (handled) continue;

              if (userMode === 'TALK_MODE') {
                await handleEnglishTalkMode(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
                continue;
              }

              // 💡 INSTANT INDICATOR: Smart Status Notice
              await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);

              // 🔗 Feature 4: Web URL Auto-Detect Summarizer
              if (/https?:\/\/[^\s]+/i.test(finalMessage)) {
                await sendTextMessage(senderPsid, "🔗 *Binabasa ang nilalaman ng link...*", PAGE_ACCESS_TOKEN);
                await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
                const urlSummary = await fetchAndSummarizeUrl(finalMessage, apiKeys, senderPsid);
                await sendLongTextMessage(senderPsid, urlSummary, PAGE_ACCESS_TOKEN);
                await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
                continue;
              }

              // Google Search Grounding Check
              const isRealtimeQuery = /weather|panahon|balita|news|ngayon|score|presyo|sino si|kailan|update/i.test(finalMessage);
              if (isRealtimeQuery) {
                await sendTextMessage(senderPsid, "🔍 *Naghahanap ng live update sa web...*", PAGE_ACCESS_TOKEN);
                await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
              }

              // Default AI Memory Chat
              await processAIWithMemory(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN, isRealtimeQuery);
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
 * ⚡ FAST GEMINI FALLBACK ENGINE
 */
async function callGeminiApiWithFallback(payload, apiKeys, enableSearch = false, timeoutMs = 3500) {
  if (!apiKeys || apiKeys.length === 0) throw new Error('Walang API Key na ma-detect.');

  const requestBody = { ...payload };
  if (enableSearch) {
    requestBody.tools = [{ google_search: {} }];
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

  // 📊 Feature 5: Admin Dashboard Commands
  if (['/stats', '/admin'].includes(lowerText)) {
    if (senderPsid !== adminPsid) {
      await sendTextMessage(senderPsid, "🚫 **Access Denied!** Para sa Admin lamang ang command na ito.", pageToken);
      return true;
    }
    const totalMsgs = (await kv.get('analytics_total_messages')) || 0;
    const statsMsg = `📊 **JepongDevxyz AI Dashboard**\n\n` +
                     `• Total Messages Processed: **${totalMsgs}**\n` +
                     `• Active Gemini Keys: **${apiKeys.length}**\n` +
                     `• System Status: **Operational 🟢**`;
    await sendTextMessage(senderPsid, statsMsg, pageToken);
    return true;
  }

  // Language Commands
  if (['/english', '/eng'].includes(lowerText)) {
    try { await kv.set(`user_lang_${senderPsid}`, 'ENGLISH'); } catch (e) {}
    await sendTextMessage(senderPsid, "🔤 **Language set to English!**", pageToken);
    return true;
  }

  if (['/tagalog', '/filipino', '/tag'].includes(lowerText)) {
    try { await kv.set(`user_lang_${senderPsid}`, 'TAGALOG'); } catch (e) {}
    await sendTextMessage(senderPsid, "🇵🇭 **Naka-set na sa Tagalog/Filipino!**", pageToken);
    return true;
  }

  if (['/auto', '/autolang'].includes(lowerText)) {
    try { await kv.del(`user_lang_${senderPsid}`); } catch (e) {}
    await sendTextMessage(senderPsid, "🤖 **Smart Auto-Detect Enabled!**", pageToken);
    return true;
  }

  // Media Commands
  if (['/imagen', 'cmd_imagen'].includes(lowerText)) {
    try { await kv.set(`user_mode_${senderPsid}`, 'IMAGE_MODE', { ex: 600 }); } catch (e) {}
    await sendTextMessage(senderPsid, "🎨 **Image Generator Mode!** I-type ang i-ge-generate na larawan.", pageToken);
    return true;
  }

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

  // 🎮 Feature 6: Interactive Quiz Game with Quick Replies
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
      "🌐 **Languages:** `/english`, `/tagalog`, `/auto`\n" +
      "🎨 **Media:** `/imagen [prompt]`, Voice Input, Image OCR\n" +
      "🎓 **Study:** `/math [prob]`, `/code [task]`, `/quiz [topic]`, PDF Files\n" +
      "🔗 **Web Links:** Mag-send ng URL link para i-summarize\n" +
      "🗣️ **Practice:** `/talk` English tutor mode\n" +
      "🧹 **System:** `/clear` to reset memory";
    await sendTextMessage(senderPsid, helpMsg, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  if (['/stop', '/clear', '/delete', '/refresh', 'cmd_clear'].includes(lowerText)) {
    try {
      await kv.del(`chat_history_${senderPsid}`);
      await kv.del(`user_mode_${senderPsid}`);
      await kv.del(`user_lang_${senderPsid}`);
    } catch (e) {}
    await sendTextMessage(senderPsid, "✅ **Reset Done!** Malinis na ang conversation history.", pageToken);
    return true;
  }

  return false;
}

// 🎙️ Process Voice Messages using Gemini Multimodal
async function processAudioMessage(audioUrl, apiKeys, senderPsid) {
  try {
    const audioRes = await fetch(audioUrl);
    const buffer = await audioRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");
    const systemInstructionText = await getSystemInstructionForUser(senderPsid);

    const payload = {
      system_instruction: { parts: [{ text: systemInstructionText }] },
      contents: [{
        parts: [
          { text: "Listen to this audio carefully, transcribe what was said, and then answer the user's request directly:" },
          { inline_data: { mime_type: "audio/mp3", data: base64Data } }
        ]
      }]
    };

    return await callGeminiApiWithFallback(payload, apiKeys, false, 6000);
  } catch (e) {
    return '❌ Error sa pagproseso ng boses. Siguraduhing malinaw ang recording.';
  }
}

// 📑 Process PDF / Document Files
async function processDocumentFile(fileUrl, apiKeys, senderPsid) {
  try {
    const fileRes = await fetch(fileUrl);
    const buffer = await fileRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");
    const systemInstructionText = await getSystemInstructionForUser(senderPsid);

    const payload = {
      system_instruction: { parts: [{ text: systemInstructionText }] },
      contents: [{
        parts: [
          { text: "Read and analyze this document file. Give a detailed breakdown and key takeaways:" },
          { inline_data: { mime_type: "application/pdf", data: base64Data } }
        ]
      }]
    };

    return await callGeminiApiWithFallback(payload, apiKeys, false, 8000);
  } catch (e) {
    return '❌ Error sa pagbasa ng file. Mas mainam kung PDF o Text file ang ipapadala.';
  }
}

// 🔗 Summarize Webpage Content
async function fetchAndSummarizeUrl(url, apiKeys, senderPsid) {
  try {
    const systemInstructionText = await getSystemInstructionForUser(senderPsid);
    const payload = {
      system_instruction: { parts: [{ text: systemInstructionText }] },
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

async function handleEnglishTalkMode(senderPsid, userMessage, apiKeys, pageToken) {
  await sendTypingOn(senderPsid, pageToken);
  const prompt = `Act as an English tutor. Reply to: "${userMessage}". Gently fix grammar mistakes if any.`;
  const tutorReply = await getDirectGeminiResponse(prompt, apiKeys, senderPsid);
  await sendLongTextMessage(senderPsid, tutorReply, pageToken);
  await sendTypingOff(senderPsid, pageToken);
}

async function getDirectGeminiResponse(promptText, apiKeys, senderPsid) {
  try {
    const systemInstructionText = await getSystemInstructionForUser(senderPsid);
    const payload = {
      system_instruction: { parts: [{ text: systemInstructionText }] },
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
    const systemInstructionText = await getSystemInstructionForUser(senderPsid);

    const payload = {
      system_instruction: { parts: [{ text: systemInstructionText }] },
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

async function processAIWithMemory(senderPsid, userMessage, apiKeys, pageToken, enableSearch = false) {
  let history = [];
  try { history = (await kv.get(`chat_history_${senderPsid}`)) || []; } catch (e) {}

  history.push({ role: 'user', parts: [{ text: userMessage }] });
  if (history.length > 4) history = history.slice(-4);

  const aiReply = await getGeminiResponseWithHistory(history, apiKeys, senderPsid, enableSearch);

  history.push({ role: 'model', parts: [{ text: aiReply }] });
  try { await kv.set(`chat_history_${senderPsid}`, history, { ex: 86400 }); } catch (e) {}

  await sendLongTextMessage(senderPsid, aiReply, pageToken);
  await sendTypingOff(senderPsid, pageToken);
}

function getRandomApiKey(keysList) {
  if (!keysList || keysList.length === 0) return null;
  return keysList[Math.floor(Math.random() * keysList.length)];
}

async function getSystemInstructionForUser(senderPsid) {
  let userLang = null;
  try { userLang = await kv.get(`user_lang_${senderPsid}`); } catch (e) {}

  let baseInstruction = "You are JepongDevxyz AI created by Jay-Ar Lee Espiritu. Helpful student tutor. ";

  if (userLang === 'ENGLISH') {
    return baseInstruction + "Respond strictly in English language.";
  } else if (userLang === 'TAGALOG') {
    return baseInstruction + "Respond strictly in Tagalog/Taglish.";
  } else {
    return baseInstruction + "Detect and respond in the same language as the user.";
  }
}

async function getGeminiResponseWithHistory(history, apiKeys, senderPsid, enableSearch = false) {
  try {
    const systemInstructionText = await getSystemInstructionForUser(senderPsid);
    const payload = {
      system_instruction: { parts: [{ text: systemInstructionText }] },
      contents: history
    };
    return await callGeminiApiWithFallback(payload, apiKeys, enableSearch, 3500);
  } catch (error) {
    return 'Medyo matagal sumagot ang AI server. Paki-subukan ulit sa sandali.';
  }
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
