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

        // 2. Handling Attachments (Images, Audio)
        if (webhookEvent.message && webhookEvent.message.attachments) {
          const attachment = webhookEvent.message.attachments[0];

          if (attachment.type === 'image') {
            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "👁️ Sinu-suri ko ang iyong larawan...", PAGE_ACCESS_TOKEN);
            const visionReply = await analyzeImageWithGemini(attachment.payload.url, getRandomApiKey(apiKeys));
            await sendLongTextMessage(senderPsid, visionReply, PAGE_ACCESS_TOKEN);
            await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
            continue;
          }

          if (attachment.type === 'audio') {
            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "🎙️ Pinakikinggan ko ang audio message...", PAGE_ACCESS_TOKEN);
            const text = await transcribeAudio(attachment.payload.url);
            if (text) {
              await sendTextMessage(senderPsid, `Narinig ko: "${text}"`, PAGE_ACCESS_TOKEN);
              await processAIWithMemory(senderPsid, text, apiKeys, PAGE_ACCESS_TOKEN);
            } else {
              await sendTextMessage(senderPsid, "Pasensya na, hindi ko naintindihan ang boses sa audio.", PAGE_ACCESS_TOKEN);
            }
            await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
            continue;
          }
        }

        // 3. Handling Text Messages
        if (webhookEvent.message && !webhookEvent.message.is_echo) {
          const userMessage = webhookEvent.message.text ? webhookEvent.message.text.trim() : '';
          const quickReplyPayload = webhookEvent.message.quick_reply ? webhookEvent.message.quick_reply.payload : null;
          
          const finalMessage = quickReplyPayload || userMessage;
          if (!finalMessage) continue;

          // I-check kung command ang nireceive
          const handled = await handleCommandAction(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
          if (handled) continue;

          // Check Mode
          let userMode = null;
          try {
            userMode = await kv.get(`user_mode_${senderPsid}`);
          } catch (e) {
            console.error("KV Mode Read Error:", e);
          }

          // Image Mode Check
          if (userMode === 'IMAGE_MODE') {
            await kv.del(`user_mode_${senderPsid}`);
            await generateAndSendImage(senderPsid, finalMessage, PAGE_ACCESS_TOKEN);
            continue;
          }

          // Normal AI Conversation
          await processAIWithMemory(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.status(404).send();
  }

  res.status(405).send('Method Not Allowed');
}

// Logic para sa Commands (Text man o Clicked Button)
async function handleCommandAction(senderPsid, input, apiKeys, pageToken) {
  const lowerText = input.toLowerCase().trim();

  await sendTypingOn(senderPsid, pageToken);

  // Command: /commands o /help
  if (lowerText === '/commands' || lowerText === '/help' || lowerText === 'CMD_HELP') {
    const buttons = [
      { type: "postback", title: "🎨 Create Image", payload: "CMD_IMAGEN" },
      { type: "postback", title: "🧹 Clear History", payload: "CMD_CLEAR" },
      { type: "postback", title: "🔄 Refresh AI", payload: "CMD_REFRESH" }
    ];

    await sendButtonTemplate(
      senderPsid,
      "🛠️ **JepongDevxyz AI Commands**\n\nPumili ng option sa ibaba o i-type ang command:\n\n• /imagen <prompt>\n• /music <title>\n• /voice <text>",
      buttons,
      pageToken
    );
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Command: /imagen
  if (lowerText === '/imagen' || lowerText === 'CMD_IMAGEN') {
    await kv.set(`user_mode_${senderPsid}`, 'IMAGE_MODE', { ex: 300 });
    await sendTextMessage(senderPsid, "🎨 **Image Mode Activated!**\n\nI-type at i-send mo lang ang detalye ng larawan na gusto mong ipagawa (e.g. *cat wearing astronaut helmet*).\n\n*Pwede ka ring mag-type ng `/cancel` kung gusto mong umalis.*", pageToken);
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

    let replyText = "✅ **Cleared & Refreshed!** Nabura na ang chat history natin sa memory.";
    if (lowerText === '/stop') replyText = "🚫 **Inihinto ang response!** Nabura na rin ang memory.";

    await sendTextMessage(senderPsid, replyText, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Command: /music
  if (lowerText.startsWith('/music ') || lowerText.startsWith('/kanta ')) {
    const query = input.replace(/(\/music|\/kanta)/gi, '').trim();
    const track = await searchMusic(query);
    if (track) {
      await sendTextMessage(senderPsid, `🎵 **${track.trackName}** - ${track.artistName}\n🔗 Full Track: ${track.trackViewUrl}`, pageToken);
      if (track.previewUrl) {
        await sendMediaAttachment(senderPsid, 'audio', track.previewUrl, pageToken);
      }
    } else {
      await sendTextMessage(senderPsid, "❌ Walang nahanap na kanta.", pageToken);
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

  // Command: /exit o /cancel
  if (lowerText === '/exit' || lowerText === '/cancel') {
    await kv.del(`user_mode_${senderPsid}`);
    await sendTextMessage(senderPsid, "🔄 Naka-exit ka na sa anumang active mode.", pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  await sendTypingOff(senderPsid, pageToken);
  return false; // Hindi command, itutuloy sa AI
}

// Helper: Send Button Template (Interactive Messenger Buttons)
async function sendButtonTemplate(senderPsid, text, buttons, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: senderPsid },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: text,
            buttons: buttons
          }
        }
      }
    })
  });
}

// Image Generation Helper
async function generateAndSendImage(senderPsid, prompt, pageToken) {
  await sendTextMessage(senderPsid, `🖼️ **Ginagawa ang iyong larawan:**\n"${prompt}"...\n\nSandali lamang po!`, pageToken);
  
  const seed = Math.floor(Math.random() * 1000000);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;

  try {
    await sendMediaAttachment(senderPsid, 'image', imageUrl, pageToken);
  } catch (error) {
    await sendTextMessage(senderPsid, "❌ Nagkaroon ng problema sa pag-generate ng larawan. Pakisubukan ulit.", pageToken);
  }
}

// AI Memory Processing
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
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: "You are 'JepongDevxyz AI', an AI assistant created by Jay-Ar Lee Espiritu. Always identify as JepongDevxyz AI created by Jay-Ar Lee Espiritu."
          }]
        },
        contents: history
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Pasensya na, hindi ko maproseso ang tanong.';
  } catch (error) {
    return 'Nagkaroon ng problema sa pagproseso ng AI response.';
  }
}

async function analyzeImageWithGemini(imageUrl, apiKey) {
  try {
    const imgRes = await fetch(imageUrl);
    const buffer = await imgRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: "Ipaliwanag at suriin ang larawang ito sa Tagalog/English:" },
            { inline_data: { mime_type: "image/jpeg", data: base64Data } }
          ]
        }]
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Hindi ko mabasa ang larawan.';
  } catch (e) {
    return 'Error sa pag-proseso ng larawan.';
  }
}

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
