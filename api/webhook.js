// Mga tunay at opisyal na Gemini models para maiwasan ang error
const GEMINI_MODELS_FALLBACK = [
  'gemini-3.5-flash-lite',  // 1st PRIORITY: Pinakamababa ang token usage, hindi mabilis ma-rate limit
  'gemini-flash-latest',    // 2nd Option: Stable Standard Flash kung busy o may downtime ang Lite
  'gemini-3.7-flash',       // 3rd Option: Fallback kung talagang kailangan
  'gemini-3.8-flash'
];

// 🔄 GLOBAL ROTATIONAL INDEX FOR KEYS
let currentKeyIndex = 0;

function getRotatedApiKey(keysList) {
  if (!keysList || keysList.length === 0) return null;
  // Kumuha ng key base sa kasalukuyang index nang hindi muna ito pinalalaki rito upang maiwasan ang race condition
  return keysList[currentKeyIndex % keysList.length];
}

function moveToNextKey(keysList) {
  if (!keysList || keysList.length <= 1) return;
  currentKeyIndex = (currentKeyIndex + 1) % keysList.length;
  console.log(`[KEY ROTATION] Inilipat ang active key sa index: ${currentKeyIndex}`);
}

// 🧠 IN-MEMORY Caches (Deduplication, User Custom Personas, & Chat History)
const processedMessageIds = new Set();
const userPersonasMap = new Map(); // Persona bawat user
const userConversationsMap = new Map(); // Chat history para sa continuous conversation

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
 * ⚡ SAFE ROTATIONAL FALLBACK ENGINE WITH GOOGLE SEARCH GROUNDING
 */
async function callGeminiApiWithFallback(payload, apiKeys, maxTotalTimeoutMs = 15000) {
  if (!apiKeys || apiKeys.length === 0) throw new Error('Walang API Key.');
  
  const requestBody = JSON.parse(JSON.stringify(payload));
  requestBody.tools = [{ googleSearch: {} }];

  const startTime = Date.now();
  let lastError = null;
  
  // Nilimitahan sa 5 maximum attempts bawat event para hindi ma-ban ang IP address ng server mo
  const maxAttempts = 5; 
  let attemptCount = 0;

  while (attemptCount < maxAttempts) {
    if (Date.now() - startTime > maxTotalTimeoutMs) break;

    const modelName = GEMINI_MODELS_FALLBACK[attemptCount % GEMINI_MODELS_FALLBACK.length];
    const apiKey = getRotatedApiKey(apiKeys);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000); // 6 na segundo bawat request limit

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
      
      console.warn(`[Attempt ${attemptCount + 1}] Model ${modelName} failed with status ${response.status}`);
      
      // KUNG RESOURCE EXHAUSTED O RATE LIMIT, LILIPAT SA SUSUNOD NA API KEY
      if (response.status === 429 || data.error?.status === "RESOURCE_EXHAUSTED") {
        console.warn(`🚨 Quota Limit na ang key na ito! Nililipat ang active key...`);
        moveToNextKey(apiKeys);
      } else if (response.status === 400) {
        // Kapag Bad Request (400), may mali sa system instruction o inline_data structure mo.
        // Hindi ito maaayos ng pagpapalit ng susi, kaya ihinto na agad ang loop para hindi masunog ang ibang keys.
        throw new Error(`Bad Request (400): ${data.error?.message || 'Suriin ang payload format.'}`);
      }

      lastError = new Error(data.error?.message || `API Error Status: ${response.status}`);
    } catch (err) {
      clearTimeout(timer);
      console.error(`[Fetch Exception]`, err.message);
      lastError = err;
      
      // Kung nagka-network timeout o crash, lumipat na rin ng susi para makasiguro
      moveToNextKey(apiKeys);
    }

    attemptCount++;
    // Sandaling magpahinga para hindi magmukhang DDoS attack sa server
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw lastError || new Error('Kasalukuyang abala ang lahat ng modelo, subukan muli sandali.');
}

async function handleCommandAction(senderPsid, input, apiKeys, pageToken, adminPsid) {
  const lowerText = input.toLowerCase().trim();

  if (['/stats', '/admin'].includes(lowerText)) {
    if (senderPsid !== adminPsid) {
      await sendTextMessage(senderPsid, "🚫 Access Denied!", pageToken);
      return true;
    }
    const statsMsg = `📊 **AI Status**

• Active Keys: **${apiKeys.length}**
• Current Key Index: **${currentKeyIndex}**
• Status: **Operational 🟢**`;
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
    await sendLongTextMessage(senderPsid, `🧮 **Math Solution:**\n\n\${reply}`, pageToken);
    return true;
  }

  if (lowerText.startsWith('/code ')) {
    await sendTypingOn(senderPsid, pageToken);
    const codeQuery = input.replace(/^\/code\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Help with code: ${codeQuery}`, apiKeys, senderPsid);
    await sendLongTextMessage(senderPsid, `💻 **Code Solution:**\n\n\${reply}`, pageToken);
    return true;
  }

  if (['/commands', '/help'].includes(lowerText)) {
    const helpMsg = "📚 AI Help Menu\n\n🎨 \`/imagen [prompt]\` \n🎓 \`/math [prob]\`, \`/code [task]\`\n🔄 \`/reset\` o \`/refresh\` (Ibalik sa normal mode)";
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
      system_instruction: { parts: [{ text: "You are an AI Assistant. Listen to this audio, transcribe, and answer in Tagalog/English." }] },
      contents: [{
        parts: [
          { text: "Respond to this speech:" },
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
      system_instruction: { parts: [{ text: "Read and analyze this document." }] },
      contents: [{
        parts: [
          { text: "Summarize this:" },
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
      contents: [{ parts: [{ text: `Read and summarize this link: \${url}` }] }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 8000);
  } catch (e) {
    return '❌ Hindi nabasa ang link.';
  }
}

async function generateAndSendImage(senderPsid, prompt, pageToken) {
  await sendTextMessage(senderPsid, "🖼️ Ginagawa ang larawan...", pageToken);
  const seed = Math.floor(Math.random() * 1000000);
  const imageUrl = `https://image.pollinations.ai/prompt/\${encodeURIComponent(prompt)}/image.jpg?width=1024&height=1024&nologo=true&seed=\${seed}`;
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
          { text: "Analyze this image:" },
          { inline_data: { mime_type: "image/jpeg", data: base64Data } }
        ]
      }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 9000);
  } catch (e) {
    return 'Error sa pag-analyze ng larawan.';
  }
}

async function getFacebookUserName(senderPsid, pageToken) {
  try {
    const response = await fetch(`https://graph.facebook.com/v19.0/\${senderPsid}?fields=first_name&access_token=\${pageToken}`);
    const data = await response.json();
    if (data && data.first_name) {
      return data.first_name;
    }
  } catch (err) {
    console.error("Error fetching Facebook user first name:", err);
  }
  return 'Boss';
}

async function processDirectAI(senderPsid, userMessage, apiKeys, pageToken) {
  try {
    const firstName = await getFacebookUserName(senderPsid, pageToken);
    const lowerMsg = userMessage.toLowerCase();

    if (['/reset', '/refresh', '/normal', 'ibalik sa dati', 'normal mode', 'tama na ang akting'].some(cmd => lowerMsg.includes(cmd))) {
      userPersonasMap.delete(senderPsid);
      userConversationsMap.delete(senderPsid);
      await sendTextMessage(senderPsid, `✅ Naka-reset na ang aking mode at memory. Bumalik na ako sa pagiging normal na AI assistant mo, \${firstName}!`, pageToken);
      await sendTypingOff(senderPsid, pageToken);
      return;
    }

    let currentPersona = userPersonasMap.get(senderPsid) || null;
    const isPersonaTrigger = /umakting ka|maging|gayahin mo|ikaw si|parang|gawin mo akong|acting|pretend/i.test(userMessage);

    if (isPersonaTrigger && !currentPersona) {
      currentPersona = userMessage;
      userPersonasMap.set(senderPsid, currentPersona);
    }

    let history = userConversationsMap.get(senderPsid) || [];
    history.push({ role: 'user', parts: [{ text: userMessage }] });

    if (history.length > 10) {
      history = history.slice(history.length - 10);
    }
    userConversationsMap.set(senderPsid, history);

    let systemInstructionText = `You are an AI Assistant chatting with \${firstName} on Facebook Messenger. Respond dynamically in the same language as the user (Tagalog/English). ` +
      `Always display the user's original question cleanly at the very top using a modern bold style and clean divider (no overlapping lines), ` +
      `adhering strictly to this layout:\n\n` +
      `.ᐟ \${firstName} : ' \${userMessage} '\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `[Your direct, professional, and well-spaced answer here, addressing the user as \${firstName} when appropriate]`;

    if (currentPersona) {
      systemInstructionText += `\n\nCRITICAL ROLEPLAY RULE: You must strictly adopt this persona/behavior requested by the user: "\${currentPersona}". Maintain this roleplay consistently in all your responses until the user commands you to reset or return to normal mode.`;
    }

    const payload = {
      system_instruction: { parts: [{ text: systemInstructionText }] },
      contents: history
    };

    const aiReply = await callGeminiApiWithFallback(payload, apiKeys, 10000);
    
    history.push({ role: 'model', parts: [{ text: aiReply }] });
    userConversationsMap.set(senderPsid, history);

    await sendLongTextMessage(senderPsid, aiReply, pageToken);
    await sendTypingOff(senderPsid, pageToken);

  } catch (error) {
    console.error("AI Processing Error:", error);
    await sendTextMessage(senderPsid, "Medyo busy ang server, paki-ulit.", pageToken);
    await sendTypingOff(senderPsid, pageToken);
  }
}

async function sendTypingOn(senderPsid, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=\${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderPsid }, sender_action: "typing_on" })
  });
}

async function sendTypingOff(senderPsid, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=\${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderPsid }, sender_action: "typing_off" })
  });
}

async function sendMediaAttachment(senderPsid, type, url, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=\${pageToken}`, {
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
    const chunks = responseText.match(new RegExp(`.{1,\${MAX_LIMIT}}`, 'g')) || [];
    for (const chunk of chunks) {
      await sendTextMessage(senderPsid, chunk, pageToken);
    }
  }
}

async function sendTextMessage(senderPsid, responseText, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=\${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderPsid }, message: { text: responseText } })
  });
}
