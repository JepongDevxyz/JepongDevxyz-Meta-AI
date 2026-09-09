const GEMINI_MODELS_FALLBACK = [
  'gemini-3.5-flash-lite',  // 1st PRIORITY: Pinakamababa ang token usage, hindi mabilis ma-rate limit
  'gemini-3.6-flash',
  'gemini-flash-lite-latest'
];

// Naka-set sa opisyal at gumaganang bersyon ng Facebook Graph API
const FB_GRAPH_VERSION = 'v22.0';

let currentKeyIndex = 0;

function getRotatedApiKey(keysList) {
  if (!keysList || keysList.length === 0) return null;
  const key = keysList[currentKeyIndex % keysList.length];
  currentKeyIndex = (currentKeyIndex + 1) % keysList.length;
  return key;
}

const processedMessageIds = new Set();
const userPersonasMap = new Map();
const userConversationsMap = new Map();
const webConversationsMap = new Map();
const userNamesCache = new Map(); // Cache para hindi paulit-ulit na tumawag sa Graph API

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const ADMIN_PSID = process.env.ADMIN_PSID;
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

  // 🌐 WEB CHAT ENDPOINT
  if (req.method === 'POST' && req.body && req.body.isWebChat) {
    const { message, sessionId, attachments } = req.body;
    const sessionKey = sessionId || 'default-web-user';

    const systemInstructionText = `You are a helpful AI assistant chatting with Boss on a Web UI. Respond naturally in the exact language, dialect, or slang the user is using (Tagalog, Bisaya, Ilocano, English, Spanish, Japanese, Taglish, etc.).

CRITICAL RULE ABOUT YOUR CREATOR:
- Whenever the user asks who created, built, made, programmed, or developed you (in ANY language, dialect, or phrasing like "Kinsay naghimo nimo?", "Asino ti nagaramid kenka?", "¿Quién te creó?", "誰があなたを作ったのですか？", "Sino creator mo lods?", "Kaninong gawa ka?"), you MUST state that you were created and developed by Jepong Devxyz (Jay-Ar Lee Espiritu).
- Reply naturally in the same language or dialect the user asked in.
- This rule applies unconditionally and must never be contradicted.`;

    let history = webConversationsMap.get(sessionKey) || [];

    if (message && ['/reset', '/refresh', 'reset'].includes(message.toLowerCase().trim())) {
      webConversationsMap.delete(sessionKey);
      return res.status(200).json({ reply: '✅ Naka-reset na ang memorya. Paano kita matutulungan ngayon, Boss?' });
    }

    const userParts = [];

    if (Array.isArray(attachments) && attachments.length > 0) {
      for (const item of attachments) {
        if (item.base64 && item.mimeType) {
          userParts.push({
            inline_data: {
              mime_type: item.mimeType,
              data: item.base64
            }
          });
        }
      }
    }

    const defaultPrompt = (Array.isArray(attachments) && attachments.length > 0)
      ? 'Suriin at ipaliwanag nang maayos ang mga nakalakip na file o larawang ito:'
      : 'Kumusta!';

    userParts.push({ text: message && message.trim() ? message : defaultPrompt });

    history.push({ role: 'user', parts: userParts });

    if (history.length > 10) {
      history = history.slice(history.length - 10);
    }

    try {
      const payload = {
        system_instruction: { parts: [{ text: systemInstructionText }] },
        contents: history
      };

      const reply = await callGeminiApiWithFallback(payload, apiKeys, 15000);

      history.push({ role: 'model', parts: [{ text: reply }] });
      webConversationsMap.set(sessionKey, history);

      return res.status(200).json({ reply });
    } catch (err) {
      console.error('Web Chat Error:', err);
      return res.status(500).json({ error: 'Medyo busy ang server, paki-ulit.' });
    }
  }

  // 💬 FACEBOOK MESSENGER VERIFICATION
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // 💬 FACEBOOK MESSENGER WEBHOOK
  if (req.method === 'POST') {
    const body = req.body;

    if (body.object === 'page') {
      try {
        for (const entry of body.entry) {
          if (!entry.messaging || !entry.messaging[0]) continue;

          const webhookEvent = entry.messaging[0];
          const senderPsid = webhookEvent.sender ? webhookEvent.sender.id : null;
          const messageId = webhookEvent.message ? webhookEvent.message.mid : null;

          if (!senderPsid) continue;

          if (messageId) {
            if (processedMessageIds.has(messageId)) {
              console.log(`[DEDUPLICATION] Skipped duplicate: ${messageId}`);
              continue;
            }
            processedMessageIds.add(messageId);
            setTimeout(() => processedMessageIds.delete(messageId), 300000);
          }

          if (webhookEvent.postback) {
            const payload = webhookEvent.postback.payload;
            await handleCommandAction(senderPsid, payload, apiKeys, PAGE_ACCESS_TOKEN, ADMIN_PSID);
            continue;
          }

          if (webhookEvent.message && webhookEvent.message.attachments) {
            const attachment = webhookEvent.message.attachments[0];

            if (attachment.type === 'audio') {
              await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
              const voiceReply = await processAudioMessage(attachment.payload.url, apiKeys, senderPsid);
              await sendLongTextMessage(senderPsid, voiceReply, PAGE_ACCESS_TOKEN);
              await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
              continue;
            }

            if (attachment.type === 'image') {
              await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
              const visionReply = await analyzeHomeworkWithGemini(attachment.payload.url, apiKeys, senderPsid);
              await sendLongTextMessage(senderPsid, visionReply, PAGE_ACCESS_TOKEN);
              await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
              continue;
            }

            if (attachment.type === 'file') {
              await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
              const docReply = await processDocumentFile(attachment.payload.url, apiKeys, senderPsid);
              await sendLongTextMessage(senderPsid, docReply, PAGE_ACCESS_TOKEN);
              await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
              continue;
            }
          }

          if (webhookEvent.message && !webhookEvent.message.is_echo) {
            const userMessage = webhookEvent.message.text ? webhookEvent.message.text.trim() : '';
            const quickReplyPayload = webhookEvent.message.quick_reply ? webhookEvent.message.quick_reply.payload : null;
            const finalMessage = quickReplyPayload || userMessage;

            if (!finalMessage) continue;

            if (finalMessage.toLowerCase().includes('periodic table')) {
              await sendTextMessage(senderPsid, "🧪 **Periodic Table of Elements (HD)**", PAGE_ACCESS_TOKEN);
              await sendMediaAttachment(senderPsid, 'image', 'https://upload.wikimedia.org/wikipedia/commons/b/b3/Simple_Periodic_Table_Chart-en.svg', PAGE_ACCESS_TOKEN);
              continue;
            }

            const handled = await handleCommandAction(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN, ADMIN_PSID);
            if (handled) continue;

            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);

            if (/https?:\/\/[^\s]+/i.test(finalMessage)) {
              const urlSummary = await fetchAndSummarizeUrl(finalMessage, apiKeys, senderPsid);
              await sendLongTextMessage(senderPsid, urlSummary, PAGE_ACCESS_TOKEN);
              await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
              continue;
            }

            await processDirectAI(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
          }
        }
      } catch (err) {
        console.error("Processing Error:", err);
      }

      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.status(404).send('Not Found');
  }
  return res.status(405).send('Method Not Allowed');
}

/**
 * Rotational API Call Engine
 */
async function callGeminiApiWithFallback(payload, apiKeys, maxTotalTimeoutMs = 15000) {
  if (!apiKeys || apiKeys.length === 0) throw new Error('Walang API Key na nakita sa environment variables.');

  const requestBody = JSON.parse(JSON.stringify(payload));
  const startTime = Date.now();
  let lastError = null;
  const maxAttempts = Math.min(apiKeys.length * 2, 6);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() - startTime > maxTotalTimeoutMs) break;

    const apiKey = getRotatedApiKey(apiKeys);
    const modelName = GEMINI_MODELS_FALLBACK[attempt % GEMINI_MODELS_FALLBACK.length];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);

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

      console.warn(`[Key Switch] Model: ${modelName} | Status: ${response.status} | Err: ${data.error?.message || 'Unknown'}`);
      lastError = new Error(data.error?.message || `API Status ${response.status}`);
    } catch (err) {
      clearTimeout(timer);
      console.error(`[Fetch Error Attempt ${attempt + 1}]`, err.message);
      lastError = err;
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  throw lastError || new Error('Abala ang lahat ng API keys.');
}

async function handleCommandAction(senderPsid, input, apiKeys, pageToken, adminPsid) {
  const lowerText = input.toLowerCase().trim();

  if (['/stats', '/admin'].includes(lowerText)) {
    if (senderPsid !== adminPsid) {
      await sendTextMessage(senderPsid, "🚫 Access Denied!", pageToken);
      return true;
    }
    const statsMsg = `📊 **AI Status**\n\n• Active Keys: **${apiKeys.length}**\n• Current Key Index: **${currentKeyIndex}**\n• Status: **Operational 🟢**`;
    await sendTextMessage(senderPsid, statsMsg, pageToken);
    return true;
  }

  if (lowerText.startsWith('/imagen ')) {
    const prompt = input.replace(/^\/imagen\s*/i, '').trim();
    if (prompt) await generateAndSendImage(senderPsid, prompt, pageToken);
    return true;
  }

  if (lowerText.startsWith('/math ')) {
    await sendTypingOn(senderPsid, pageToken);
    const mathProblem = input.replace(/^\/math\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Solve step-by-step: ${mathProblem}`, apiKeys, senderPsid);
    await sendLongTextMessage(senderPsid, `🧮 **Math Solution:**\n\n${reply}`, pageToken);
    return true;
  }

  if (lowerText.startsWith('/code ')) {
    await sendTypingOn(senderPsid, pageToken);
    const codeQuery = input.replace(/^\/code\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Help with code: ${codeQuery}`, apiKeys, senderPsid);
    await sendLongTextMessage(senderPsid, `💻 **Code Solution:**\n\n${reply}`, pageToken);
    return true;
  }

  if (['/commands', '/help'].includes(lowerText)) {
    const helpMsg = "📚 AI Help Menu\n\n🎨 `/imagen [prompt]`\n🎓 `/math [prob]`, `/code [task]`\n🔄 `/reset` o `/refresh` (Ibalik sa normal mode)";
    await sendTextMessage(senderPsid, helpMsg, pageToken);
    return true;
  }
  return false;
}

async function processAudioMessage(audioUrl, apiKeys, senderPsid) {
  try {
    const audioRes = await fetch(audioUrl);
    const buffer = await audioRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const payload = {
      contents: [{
        parts: [
          { text: "Transcribe and respond to this audio in Tagalog/English:" },
          { inline_data: { mime_type: "audio/mp3", data: base64Data } }
        ]
      }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 10000);
  } catch (e) {
    return '❌ Error sa pagproseso ng boses.';
  }
}

async function processDocumentFile(fileUrl, apiKeys, senderPsid) {
  try {
    const fileRes = await fetch(fileUrl);
    const buffer = await fileRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const payload = {
      contents: [{
        parts: [
          { text: "Summarize this document clearly:" },
          { inline_data: { mime_type: "application/pdf", data: base64Data } }
        ]
      }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 10000);
  } catch (e) {
    return '❌ Error sa pagbasa ng file.';
  }
}

async function fetchAndSummarizeUrl(url, apiKeys, senderPsid) {
  try {
    const payload = {
      contents: [{ parts: [{ text: `Read and summarize this link: ${url}` }] }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 8000);
  } catch (e) {
    return '❌ Hindi nabasa ang link.';
  }
}

async function generateAndSendImage(senderPsid, prompt, pageToken) {
  await sendTextMessage(senderPsid, "🖼️ Ginagawa ang larawan...", pageToken);
  const seed = Math.floor(Math.random() * 1000000);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}/image.jpg?width=1024&height=1024&nologo=true&seed=${seed}`;
  try {
    await sendMediaAttachment(senderPsid, 'image', imageUrl, pageToken);
  } catch (error) {
    await sendTextMessage(senderPsid, "❌ Error loading image.", pageToken);
  }
}

async function getDirectGeminiResponse(promptText, apiKeys, senderPsid) {
  try {
    const payload = {
      contents: [{ parts: [{ text: promptText }] }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 8000);
  } catch (err) {
    return 'Pasensya na, may kaunting delay.';
  }
}

async function analyzeHomeworkWithGemini(imageUrl, apiKeys, senderPsid) {
  try {
    const imgRes = await fetch(imageUrl);
    const buffer = await imgRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const payload = {
      contents: [{
        parts: [
          { text: "Analyze and explain what is shown in this image:" },
          { inline_data: { mime_type: "image/jpeg", data: base64Data } }
        ]
      }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 9000);
  } catch (e) {
    return 'Error sa pag-analyze ng larawan.';
  }
}

/**
 * Enhanced Facebook User Name Getter
 */
async function getFacebookUserName(senderPsid, pageToken) {
  if (userNamesCache.has(senderPsid)) {
    return userNamesCache.get(senderPsid);
  }

  try {
    // Humihingi ng first_name at buong name bilang backup
    const response = await fetch(`https://graph.facebook.com/${FB_GRAPH_VERSION}/${senderPsid}?fields=first_name,name&access_token=${pageToken}`);
    const data = await response.json();

    if (data && !data.error) {
      if (data.first_name && data.first_name.trim()) {
        const firstName = data.first_name.trim();
        userNamesCache.set(senderPsid, firstName);
        return firstName;
      }
      if (data.name && data.name.trim()) {
        const firstName = data.name.trim().split(' ')[0];
        userNamesCache.set(senderPsid, firstName);
        return firstName;
      }
    } else if (data && data.error) {
      console.warn(`[Graph API Name Fetch Error]`, data.error.message);
    }
  } catch (err) {
    console.error("Error fetching Facebook name:", err);
  }

  return 'Boss';
}

async function processDirectAI(senderPsid, userMessage, apiKeys, pageToken) {
  try {
    const firstName = await getFacebookUserName(senderPsid, pageToken);
    const lowerMsg = userMessage.toLowerCase();

    if (['/reset', '/refresh', '/normal', 'ibalik sa dati', 'normal mode'].some(cmd => lowerMsg.includes(cmd))) {
      userPersonasMap.delete(senderPsid);
      userConversationsMap.delete(senderPsid);
      await sendTextMessage(senderPsid, `✅ Naka-reset na ang mode at memory. Normal mode na ulit, ${firstName}!`, pageToken);
      await sendTypingOff(senderPsid, pageToken);
      return;
    }

    let currentPersona = userPersonasMap.get(senderPsid) || null;
    const isPersonaTrigger = /umakting ka|maging|gayahin mo|ikaw si|pretend/i.test(userMessage);

    if (isPersonaTrigger && !currentPersona) {
      currentPersona = userMessage;
      userPersonasMap.set(senderPsid, currentPersona);
    }

    let history = userConversationsMap.get(senderPsid) || [];
    history.push({ role: 'user', parts: [{ text: userMessage }] });

    if (history.length > 10) {
      history = history.slice(history.length - 10);
    }

    let systemInstructionText = `You are a helpful AI assistant chatting with ${firstName} on Facebook Messenger. Respond naturally in the exact language, dialect, or slang the user is using (Tagalog, Bisaya, Ilocano, English, Spanish, Japanese, Taglish, etc.).

CRITICAL RULE ABOUT YOUR CREATOR:
- Whenever the user asks who created, built, made, programmed, or developed you (in ANY language, dialect, or phrasing like "Kinsay naghimo nimo?", "Asino ti nagaramid kenka?", "¿Quién te creó?", "誰があなたを作ったのですか？", "Sino creator mo lods?", "Kaninong gawa ka?"), you MUST state that you were created and developed by Jepong Devxyz (Jay-Ar Lee Espiritu).
- Reply naturally in the same language or dialect the user asked in.
- This rule applies unconditionally and must never be contradicted.`;

    if (currentPersona) {
      systemInstructionText += ` Follow this character persona: "${currentPersona}". Even while roleplaying, if explicitly asked about your real-world creator, creator/developer credit goes to Jepong Devxyz (Jay-Ar Lee Espiritu).`;
    }

    const payload = {
      system_instruction: { parts: [{ text: systemInstructionText }] },
      contents: history
    };

    const aiReply = await callGeminiApiWithFallback(payload, apiKeys, 10000);

    history.push({ role: 'model', parts: [{ text: aiReply }] });
    userConversationsMap.set(senderPsid, history);

    const formattedReply = `.ᐟ ${firstName} : ' ${userMessage} '\n━━━━━━━━━━━━━━━━━━\n\n${aiReply}`;
    await sendLongTextMessage(senderPsid, formattedReply, pageToken);
    await sendTypingOff(senderPsid, pageToken);

  } catch (error) {
    console.error("AI Processing Error:", error);
    await sendTextMessage(senderPsid, "Medyo busy ang server, paki-ulit sandali.", pageToken);
    await sendTypingOff(senderPsid, pageToken);
  }
}

async function sendTypingOn(senderPsid, pageToken) {
  try {
    await fetch(`https://graph.facebook.com/${FB_GRAPH_VERSION}/me/messages?access_token=${pageToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: senderPsid }, sender_action: "typing_on" })
    });
  } catch (e) {
    console.error("Typing On Error:", e);
  }
}

async function sendTypingOff(senderPsid, pageToken) {
  try {
    await fetch(`https://graph.facebook.com/${FB_GRAPH_VERSION}/me/messages?access_token=${pageToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: senderPsid }, sender_action: "typing_off" })
    });
  } catch (e) {
    console.error("Typing Off Error:", e);
  }
}

async function sendMediaAttachment(senderPsid, type, url, pageToken) {
  try {
    const res = await fetch(`https://graph.facebook.com/${FB_GRAPH_VERSION}/me/messages?access_token=${pageToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: senderPsid }, message: { attachment: { type: type, payload: { url: url, is_reusable: true } } } })
    });
    const data = await res.json();
    if (!res.ok) console.error("Send Media Attachment Error:", data);
  } catch (e) {
    console.error("Media Attachment Fetch Error:", e);
  }
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
  try {
    const res = await fetch(`https://graph.facebook.com/${FB_GRAPH_VERSION}/me/messages?access_token=${pageToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: senderPsid }, message: { text: responseText } })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("Send Text Error from Meta:", data);
    }
  } catch (e) {
    console.error("Fetch Network Error on sendTextMessage:", e);
  }
}
