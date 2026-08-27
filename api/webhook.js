import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
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
      for (const entry of body.entry) {
        const webhookEvent = entry.messaging[0];
        const senderPsid = webhookEvent.sender.id;

        // 1. Handling Button Clicks (Postbacks)
        if (webhookEvent.postback) {
          const payload = webhookEvent.postback.payload;
          await handleCommandAction(senderPsid, payload, apiKeys, PAGE_ACCESS_TOKEN);
          continue;
        }

        // 2. Handling Attachments (Homework Pictures, Images, Audio)
        if (webhookEvent.message && webhookEvent.message.attachments) {
          const attachment = webhookEvent.message.attachments[0];

          if (attachment.type === 'image') {
            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "📖 Sinu-suri ko ang iyong larawan/homework... Kaya natin 'to! ✨", PAGE_ACCESS_TOKEN);
            
            // Homework & Image Analyzer Logic
            const visionReply = await analyzeHomeworkWithGemini(attachment.payload.url, getRandomApiKey(apiKeys));
            await sendLongTextMessage(senderPsid, visionReply, PAGE_ACCESS_TOKEN);
            await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
            continue;
          }

          if (attachment.type === 'audio') {
            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "🎙️ Pinakikinggan ko ang boses mo...", PAGE_ACCESS_TOKEN);
            const text = await transcribeAudio(attachment.payload.url);
            if (text) {
              await sendTextMessage(senderPsid, `Narinig ko: "${text}"`, PAGE_ACCESS_TOKEN);
              await processAIWithMemory(senderPsid, text, apiKeys, PAGE_ACCESS_TOKEN);
            } else {
              await sendTextMessage(senderPsid, "Pasensya na, hindi ko gaanong naintindihan ang boses sa audio.", PAGE_ACCESS_TOKEN);
            }
            await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
            continue;
          }
        }

        // 3. Handling Text Messages & Special Requests
        if (webhookEvent.message && !webhookEvent.message.is_echo) {
          const userMessage = webhookEvent.message.text ? webhookEvent.message.text.trim() : '';
          const quickReplyPayload = webhookEvent.message.quick_reply ? webhookEvent.message.quick_reply.payload : null;
          
          const finalMessage = quickReplyPayload || userMessage;
          if (!finalMessage) continue;

          // Check kung Command ang nireceive
          const handled = await handleCommandAction(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
          if (handled) continue;

          // Special Keywords Check (e.g. Periodic Table Request)
          const lowerText = finalMessage.toLowerCase();
          if (lowerText.includes('periodic table')) {
            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "🧪 **Narito ang HD Periodic Table of Elements para sa iyong pag-aaral!** ⚛️", PAGE_ACCESS_TOKEN);
            
            // Magpapadala ng malinaw na Periodic Table Image
            const periodicTableImg = "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Periodic_table_large.svg/1920px-Periodic_table_large.svg.png";
            await sendMediaAttachment(senderPsid, 'image', periodicTableImg, PAGE_ACCESS_TOKEN);
            
            const periodicInfo = "💡 **Quick Guide sa Periodic Table:**\n\n" +
                                 "• **Atomic Number (Z):** Dami ng protons sa nucleus.\n" +
                                 "• **Periods (Horizontal Rows):** Nagpapakita ng bilang ng electron shells (1 hanggang 7).\n" +
                                 "• **Groups (Vertical Columns):** Mga elementong may magkakahawig na chemical properties (hal. Group 18 = Noble Gases).\n\n" +
                                 "May partikular ka bang elementong gustong malaman (e.g. Gold, Oxygen, Uranium)? Tanungin mo lang ako! 😊";
            await sendLongTextMessage(senderPsid, periodicInfo, PAGE_ACCESS_TOKEN);
            await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
            continue;
          }

          // Check Active Mode (halimbawa: Image Mode)
          let userMode = null;
          try {
            userMode = await kv.get(`user_mode_${senderPsid}`);
          } catch (e) {
            console.error("KV Mode Read Error:", e);
          }

          if (userMode === 'IMAGE_MODE') {
            await kv.del(`user_mode_${senderPsid}`);
            await generateAndSendImage(senderPsid, finalMessage, PAGE_ACCESS_TOKEN);
            continue;
          }

          // Default: Student-Friendly AI Tutor Response
          await processAIWithMemory(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.status(404).send();
  }

  res.status(405).send('Method Not Allowed');
}

// Commands & Interactive Options
async function handleCommandAction(senderPsid, input, apiKeys, pageToken) {
  const lowerText = input.toLowerCase().trim();

  await sendTypingOn(senderPsid, pageToken);

  // Command: /commands o /help
  if (lowerText === '/commands' || lowerText === '/help' || lowerText === 'CMD_HELP') {
    const buttons = [
      { type: "postback", title: "🎨 Draw / Image", payload: "CMD_IMAGEN" },
      { type: "postback", title: "🧪 Periodic Table", payload: "Periodic Table" },
      { type: "postback", title: "🧹 Reset Memory", payload: "CMD_CLEAR" }
    ];

    await sendButtonTemplate(
      senderPsid,
      "📚 **JepongDevxyz AI - Your Study Buddy** 🤖✨\n\n" +
      "Kaya kong sagutan ang iyong homework (I-send lang ang picture!), ipaliwanag ang mga aralin, o maghanap ng kanta!\n\n" +
      "Pumili sa mga buttons o i-type ang commands:\n" +
      "• **/imagen [prompt]** - Magpa-draw ng image\n" +
      "• **/music [title]** - Maghanap ng kanta\n" +
      "• **/voice [text]** - Text to speech",
      buttons,
      pageToken
    );
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Command: /imagen
  if (lowerText === '/imagen' || lowerText === 'CMD_IMAGEN') {
    await kv.set(`user_mode_${senderPsid}`, 'IMAGE_MODE', { ex: 300 });
    await sendTextMessage(senderPsid, "🎨 **Image Generator Mode!**\n\nI-type lang ang larawang gusto mong likhain (e.g., *diagram of a plant cell* o *solar system illustration*).", pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  if (lowerText.startsWith('/imagen ')) {
    const prompt = input.replace(/^\/imagen\s*/i, '').trim();
    if (prompt) {
      await generateAndSendImage(senderPsid, prompt, pageToken);
      await sendTypingOff(senderPsid, pageToken);
      return true;
    }
  }

  // Command: /clear /refresh /stop
  if (['/stop', '/clear', '/delete', '/refresh', 'CMD_CLEAR', 'CMD_REFRESH'].includes(lowerText)) {
    await kv.del(`chat_history_${senderPsid}`);
    await kv.del(`user_mode_${senderPsid}`);

    let replyText = "✅ **Refreshed!** Handa na uli akong tumulong sa iyong mga bagong aralin!";
    await sendTextMessage(senderPsid, replyText, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Command: /music
  if (lowerText.startsWith('/music ') || lowerText.startsWith('/kanta ')) {
    const query = input.replace(/(\/music|\/kanta)/gi, '').trim();
    const track = await searchMusic(query);
    if (track) {
      await sendTextMessage(senderPsid, `🎵 **${track.trackName}** - ${track.artistName}\n🔗 Link: ${track.trackViewUrl}`, pageToken);
      if (track.previewUrl) {
        await sendMediaAttachment(senderPsid, 'audio', track.previewUrl, pageToken);
      }
    } else {
      await sendTextMessage(senderPsid, "❌ Pasensya na, walang nahanap na kanta.", pageToken);
    }
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Command: /voice
  if (lowerText.startsWith('/voice ') || lowerText.startsWith('/speak ')) {
    const textToSpeak = input.replace(/(\/voice|\/speak)/gi, '').trim();
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(textToSpeak)}&tl=tl&client=tw-ob`;
    await sendMediaAttachment(senderPsid, 'audio', ttsUrl, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  await sendTypingOff(senderPsid, pageToken);
  return false;
}

// Student & Homework Analyzer (Vision AI)
async function analyzeHomeworkWithGemini(imageUrl, apiKey) {
  try {
    const imgRes = await fetch(imageUrl);
    const buffer = await imgRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const prompt = "You are an encouraging, expert student AI tutor like Dola. " +
                   "Analyze the uploaded photo carefully. If it contains a homework question, math problem, worksheet, or assignment: " +
                   "1. Provide the correct answer clearly. " +
                   "2. Explain the step-by-step solution in simple, student-friendly terms so the user actually understands the concept. " +
                   "3. Use warm emojis and tone. Reply in Tagalog/Filipino or English depending on the language of the prompt.";

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: base64Data } }
          ]
        }]
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Pasensya na, hindi ko masyadong mabasa ang nakasulat sa larawan. Pwedeng paki-picture uli nang mas malinaw? 😊';
  } catch (e) {
    return 'Nagkaroon ng konting problema sa pagproseso ng larawan. Paki-try ulit!';
  }
}

// AI Companion with Student Personality
async function processAIWithMemory(senderPsid, userMessage, apiKeys, pageToken) {
  let history = [];
  try {
    history = (await kv.get(`chat_history_${senderPsid}`)) || [];
  } catch (e) {
    console.error("KV Memory error:", e);
  }

  history.push({ role: 'user', parts: [{ text: userMessage }] });
  if (history.length > 10) history = history.slice(-10);

  const selectedApiKey = getRandomApiKey(apiKeys);
  const aiReply = await getGeminiResponseWithHistory(history, selectedApiKey);

  history.push({ role: 'model', parts: [{ text: aiReply }] });

  try {
    await kv.set(`chat_history_${senderPsid}`, history, { ex: 86400 });
  } catch (e) {
    console.error("KV Save error:", e);
  }

  await sendLongTextMessage(senderPsid, aiReply, pageToken);
}

function getRandomApiKey(keysList) {
  if (!keysList || keysList.length === 0) return null;
  return keysList[Math.floor(Math.random() * keysList.length)];
}

async function getGeminiResponseWithHistory(history, apiKey) {
  if (!apiKey) return 'Error: Walang na-detect na Gemini API Key.';

  try {
    const systemInstruction = 
      "You are 'JepongDevxyz AI', a friendly, intelligent, and highly supportive student AI assistant (similar to Dola AI), created by Jay-Ar Lee Espiritu. " +
      "PERSONALITY & BEHAVIOR: " +
      "1. Be approachable, encouraging, and clear. Use relatable, student-friendly tone with emojis. " +
      "2. HOMEWORK & ACADEMICS: If the user asks an academic question, math equation, essay topic, or problem, explain the solution step-by-step so they can learn. " +
      "3. LANGUAGE: Automatically match the user's language (Tagalog, Taglish, or English). " +
      "4. IDENTITY: Always introduce or refer to yourself as JepongDevxyz AI created by Jay-Ar Lee Espiritu.";

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemInstruction }]
        },
        contents: history
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Pasensya na, nagkaroon ako ng saglit na problema sa pag-isip. Paki-tanong ulit! 😊';
  } catch (error) {
    return 'Nagkaroon ng problema sa pagproseso ng AI response.';
  }
}

// Image Generator
async function generateAndSendImage(senderPsid, prompt, pageToken) {
  await sendTextMessage(senderPsid, `🖼️ **Ginagawa ko na ang larawan para sa:**\n"${prompt}"...\n\nSandali lang po! ✨`, pageToken);
  
  const seed = Math.floor(Math.random() * 1000000);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;

  try {
    await sendMediaAttachment(senderPsid, 'image', imageUrl, pageToken);
  } catch (error) {
    await sendTextMessage(senderPsid, "❌ Pasensya na, nagkaroon ng error sa pag-generate ng image.", pageToken);
  }
}

// Helpers for API Calls
async function searchMusic(query) {
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=1&media=music`);
    const data = await res.json();
    return data.results?.[0] || null;
  } catch (e) {
    return null;
  }
}

async function transcribeAudio(audioUrl) {
  try {
    const audioRes = await fetch(audioUrl);
    const audioBuffer = await audioRes.arrayBuffer();
    const response = await fetch("https://api-inference.huggingface.co/models/openai/whisper-small", {
      method: "POST",
      body: audioBuffer
    });
    const result = await response.json();
    return result.text || null;
  } catch (err) {
    return null;
  }
}

async function sendButtonTemplate(senderPsid, text, buttons, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: senderPsid },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "button", text: text, buttons: buttons }
        }
      }
    })
  });
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

async function sendMediaAttachment(senderPsid, type, url, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: senderPsid },
      message: { attachment: { type: type, payload: { url: url, is_reusable: true } } }
    })
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
    body: JSON.stringify({
      recipient: { id: senderPsid },
      message: { text: responseText }
    })
  });
}
