const GEMINI_MODELS_FALLBACK = [
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.7-flash',
  'gemini-3.8-flash'
];

const FB_GRAPH_VERSION = 'v26.0';

let currentKeyIndex = 0;

function getApiKeysList() {
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return rawKeys
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);
}

function getRotatedApiKey(keysList) {
  if (!keysList || keysList.length === 0) return null;
  const key = keysList[currentKeyIndex % keysList.length];
  currentKeyIndex = (currentKeyIndex + 1) % keysList.length;
  return key;
}

/**
 * 🕒 Exact Real-Time Clock para sa Pilipinas (Asia/Manila, UTC+8)
 */
function getPhilippineDateTime() {
  const now = new Date();
  return now.toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * 🌐 Advanced Multi-Engine Real-Time Search & Live Weather
 */
async function performFreeWebSearch(query) {
  const cleanQuery = query
    .replace(/^(search|mag-search|hanapin|ano ang balita sa|updates sa|anong|ano ang)\s+/i, '')
    .trim();

  if (!cleanQuery) return null;

  // 1. Live Weather Integration (Open-Meteo)
  if (/weather|panahon|ulan|init|bagyo|temperatura/i.test(query)) {
    try {
      const placeMatch = query.replace(/(anong|ano ang|kumusta|panahon|weather|sa|ngayon|dito|temperatura)\b/gi, '').trim();
      const place = placeMatch || 'Guimba';
      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
      const geoData = await geoRes.json();
      if (geoData.results && geoData.results[0]) {
        const { latitude, longitude, name, admin1, country } = geoData.results[0];
        const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m&timezone=auto`);
        const wData = await wRes.json();
        if (wData.current) {
          const c = wData.current;
          return `Live Weather Report (${name}, ${admin1 || ''}, ${country}): Temp: ${c.temperature_2m}°C (Feels like: ${c.apparent_temperature}°C), Humidity: ${c.relative_humidity_2m}%, Precipitation: ${c.precipitation}mm, Wind: ${c.wind_speed_10m}km/h`;
        }
      }
    } catch (e) {
      console.warn('[Weather API Error]:', e.message);
    }
  }

  // 2. Tavily Search API (Kung may TAVILY_API_KEY sa Environment Variables)
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: `${cleanQuery} 2026`,
          search_depth: 'basic',
          max_results: 3
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          return data.results.map(r => `• ${r.title}: ${r.content}`).join('\n\n');
        }
      }
    } catch (e) {
      console.warn('[Tavily Search Failed]:', e.message);
    }
  }

  // 3. Open Public SearXNG Instances (Libre, Real-time Web)
  const instances = [
    'https://search.ononoki.org',
    'https://searx.be',
    'https://baresearch.org'
  ];

  for (const instance of instances) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);

      const searchUrl = `${instance}/search?q=${encodeURIComponent(cleanQuery + ' 2026')}&format=json&language=tl,en`;
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          const topResults = data.results
            .slice(0, 3)
            .map(r => `• ${r.title}: ${r.content || ''}`)
            .filter(Boolean);
          if (topResults.length > 0) {
            return topResults.join('\n\n');
          }
        }
      }
    } catch (e) {
      continue;
    }
  }

  // 4. Wikipedia Summary Fallback
  try {
    const wikiRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanQuery)}`, {
      headers: { 'User-Agent': 'JepongDevxyzBot/1.0' }
    });
    if (wikiRes.ok) {
      const w = await wikiRes.json();
      if (w.extract) return w.extract;
    }
  } catch (e) {}

  return null;
}

const processedMessageIds = new Set();
const userPersonasMap = new Map();
const userConversationsMap = new Map();
const webConversationsMap = new Map();

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const ADMIN_PSID = process.env.ADMIN_PSID;
  const apiKeys = getApiKeysList();
  const currentDateTimePH = getPhilippineDateTime();

  // 🌐 WEB CHAT ENDPOINT
  if (req.method === 'POST' && req.body && req.body.isWebChat) {
    const { message, sessionId, attachments } = req.body;
    const sessionKey = sessionId || 'default-web-user';

    const systemInstructionText = `You are JepongDevxyz AI, a state-of-the-art, hyper-intelligent, and analytical AI assistant chatting with Boss.

TEMPORAL GROUND TRUTH (CRITICAL):
- Exact Philippine Date & Time: ${currentDateTimePH} (PST, UTC+8).
- The current year is 2026.
- If the user asks for the current time, date, day, or year, ALWAYS use this exact Philippine time. NEVER guess, estimate, or hallucinate different timestamps.

AI IDENTITY & CREATOR:
- AI Name: JepongDevxyz (or JepongDevxyz AI).
- When asked who you are or your name: "Ako ay si JepongDevxyz" (or "JepongDevxyz AI"). Never say you have no name.
- When asked who created you: Always state that you were built and programmed by Jepong Devxyz (Jay-Ar Lee Espiritu).

REASONING & WRITING STANDARDS:
- Provide highly accurate, sharp, logical, and insightful answers.
- Use 100% correct spelling, grammar, and natural tone (e.g., write "maitutulong", never "maitalong").
- Adapt automatically to the user's language (Tagalog, Bisaya, Ilocano, English, Taglish, etc.).`;

    let history = webConversationsMap.get(sessionKey) || [];

    if (message && ['/reset', '/refresh', 'reset'].includes(message.toLowerCase().trim())) {
      webConversationsMap.delete(sessionKey);
      return res.status(200).json({ reply: '✅ Naka-reset na ang memorya. Paano kita maitutulungan ngayon, Boss?' });
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

    let finalPrompt = message && message.trim() ? message : 'Kumusta!';

    if (/(balita|sino si|ano ang|kailan|update|presyo|weather|panahon|search|score|oras)/i.test(finalPrompt)) {
      try {
        const searchResults = await performFreeWebSearch(finalPrompt);
        if (searchResults) {
          finalPrompt += `\n\n[Live Real-Time Web Data]:\n${searchResults}`;
        }
      } catch (err) {}
    }

    userParts.push({ text: finalPrompt });
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
            if (processedMessageIds.has(messageId)) continue;
            processedMessageIds.add(messageId);
            setTimeout(() => processedMessageIds.delete(messageId), 300000);
          }

          if (webhookEvent.postback) {
            const payload = webhookEvent.postback.payload;
            await handleCommandAction(senderPsid, payload, apiKeys, PAGE_ACCESS_TOKEN, ADMIN_PSID, currentDateTimePH);
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

            const handled = await handleCommandAction(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN, ADMIN_PSID, currentDateTimePH);
            if (handled) continue;

            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);

            if (/https?:\/\/[^\s]+/i.test(finalMessage)) {
              const urlSummary = await fetchAndSummarizeUrl(finalMessage, apiKeys, senderPsid);
              await sendLongTextMessage(senderPsid, urlSummary, PAGE_ACCESS_TOKEN);
              await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
              continue;
            }

            await processDirectAI(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN, currentDateTimePH);
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
 * High-Speed Rotational Engine
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
    const timer = setTimeout(() => controller.abort(), 9000);

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

      console.warn(`[Key Rotate Attempt ${attempt + 1}] Model: ${modelName} | Status: ${response.status} | Err: ${data.error?.message || 'Unknown'}`);
      lastError = new Error(data.error?.message || `API Status ${response.status}`);
    } catch (err) {
      clearTimeout(timer);
      console.error(`[Fetch Error Attempt ${attempt + 1}]`, err.message);
      lastError = err;
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  throw lastError || new Error('Abala o ubos na ang lahat ng API keys.');
}

async function handleCommandAction(senderPsid, input, apiKeys, pageToken, adminPsid, currentDateTimePH) {
  const lowerText = input.toLowerCase().trim();

  if (['/stats', '/admin'].includes(lowerText)) {
    if (senderPsid !== adminPsid) {
      await sendTextMessage(senderPsid, "🚫 Access Denied!", pageToken);
      return true;
    }
    const statsMsg = `📊 **AI Status**\n\n• Active Keys: **${apiKeys.length}**\n• Current Key Index: **${currentKeyIndex}**\n• Philippine Time: **${currentDateTimePH}**\n• Status: **Operational 🟢**`;
    await sendTextMessage(senderPsid, statsMsg, pageToken);
    return true;
  }

  if (lowerText.startsWith('/search ')) {
    await sendTypingOn(senderPsid, pageToken);
    const query = input.replace(/^\/search\s*/i, '').trim();
    const results = await performFreeWebSearch(query);
    const reply = await getDirectGeminiResponse(`Oras ngayon: ${currentDateTimePH}. Sagutin nang may mataas na katumpakan batay sa search data:\n\n${results || 'Walang nahanap.'}\n\nTanong: ${query}`, apiKeys, senderPsid);
    await sendLongTextMessage(senderPsid, `🌐 **Web Search Result:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
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
    const reply = await getDirectGeminiResponse(`Solve step-by-step with rigorous proof: ${mathProblem}`, apiKeys, senderPsid);
    await sendLongTextMessage(senderPsid, `🧮 **Math Solution:**\n\n${reply}`, pageToken);
    return true;
  }

  if (lowerText.startsWith('/code ')) {
    await sendTypingOn(senderPsid, pageToken);
    const codeQuery = input.replace(/^\/code\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Provide clean, modern, fully functional code: ${codeQuery}`, apiKeys, senderPsid);
    await sendLongTextMessage(senderPsid, `💻 **Code Solution:**\n\n${reply}`, pageToken);
    return true;
  }

  if (['/commands', '/help'].includes(lowerText)) {
    const helpMsg = "📚 AI Help Menu\n\n🔍 `/search [topic]` (Live Web Search)\n🎨 `/imagen [prompt]`\n🎓 `/math [prob]`, `/code [task]`\n🔄 `/reset` o `/refresh` (Ibalik sa normal mode)";
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
          { text: "Transcribe and respond accurately with perfect grammar and spelling:" },
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
          { text: "Analyze and summarize this document thoroughly and clearly:" },
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
      contents: [{ parts: [{ text: `Extract, analyze, and summarize the key insights from this link clearly: ${url}` }] }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 9000);
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
      contents: [{ parts: [{ text: `${promptText}. Siguraduhing 100% tama ang factual data, spelling, at grammar.` }] }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 9000);
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
          { text: "Analyze this image in detail and provide clear, step-by-step academic explanations:" },
          { inline_data: { mime_type: "image/jpeg", data: base64Data } }
        ]
      }]
    };
    return await callGeminiApiWithFallback(payload, apiKeys, 9000);
  } catch (e) {
    return 'Error sa pag-analyze ng larawan.';
  }
}

async function processDirectAI(senderPsid, userMessage, apiKeys, pageToken, currentDateTimePH) {
  try {
    const firstName = 'Boss';
    const lowerMsg = userMessage.toLowerCase();

    if (['/reset', '/refresh', '/normal', 'ibalik sa dati', 'normal mode'].some(cmd => lowerMsg.includes(cmd))) {
      userPersonasMap.delete(senderPsid);
      userConversationsMap.delete(senderPsid);
      await sendTextMessage(senderPsid, `✓ Naka-reset na ang mode at memory. Normal mode na ulit, ${firstName}!`, pageToken);
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
    let messageToSend = userMessage;

    // Real-Time Trigger para sa Balita, Weather, at Live Topics
    const isSearchQuery = /kailan|sino si|ano ang balita|latest|updates|search|presyo|petsa|panahon|weather|score|sino ang|ano ang nangyari|balita ngayon/i.test(userMessage);
    if (isSearchQuery) {
      try {
        const searchData = await performFreeWebSearch(userMessage);
        if (searchData) {
          messageToSend = `${userMessage}\n\n[Live Real-Time Web Data]:\n${searchData}`;
        }
      } catch (err) {
        console.warn("Search fetch failed:", err.message);
      }
    }

    history.push({ role: 'user', parts: [{ text: messageToSend }] });

    if (history.length > 10) {
      history = history.slice(history.length - 10);
    }

    let systemInstructionText = `You are JepongDevxyz AI, a state-of-the-art, hyper-intelligent, and analytical AI assistant chatting with ${firstName} on Facebook Messenger.

TEMPORAL GROUND TRUTH (CRITICAL):
- Exact Philippine Date & Time: ${currentDateTimePH} (PST, UTC+8).
- The current year is 2026.
- If the user asks for the current time, date, day, or year (halimbawa: "ano oras na ngayon sa Guimba?", "anong petsa ngayon?"), ALWAYS refer directly to this exact Philippine time. Never fabricate or extrapolate a different time.

AI NAME & IDENTITY:
- Official Name: JepongDevxyz (or JepongDevxyz AI).
- Kapag tinanong ka kung sino ka o ano ang pangalan mo: "Ako ay si JepongDevxyz" (o "JepongDevxyz AI"). Huwag na huwag mong sasabihing wala kang opisyal na pangalan.

LANGUAGE, REASONING & SPELLING:
- If [Live Real-Time Web Data] is provided, prioritize it for accurate, up-to-date facts.
- Always use correct spelling, proper grammar, and natural flow (e.g., use "maitutulong", never "maitalong").
- Respond naturally and concisely in the exact language or dialect the user is using.

CRITICAL RULE ABOUT YOUR CREATOR:
- Kapag tinanong kung sino ang lumikha o nag-program sa iyo, laging sabihin na ikaw ay nilikha at binuo ni Jepong Devxyz (Jay-Ar Lee Espiritu).`;

    if (currentPersona) {
      systemInstructionText += ` Follow this character persona: "${currentPersona}". Even while roleplaying, creator credit goes to Jepong Devxyz (Jay-Ar Lee Espiritu), and your core identity remains JepongDevxyz AI.`;
    }

    const payload = {
      system_instruction: { parts: [{ text: systemInstructionText }] },
      contents: history
    };

    const aiReply = await callGeminiApiWithFallback(payload, apiKeys, 10000);

    history[history.length - 1] = { role: 'user', parts: [{ text: userMessage }] };
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
