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

        // Handling Postback (Get Started / Menu Buttons)
        if (webhookEvent.postback) {
          const payload = webhookEvent.postback.payload;
          await handlePostback(senderPsid, payload, pageToken);
          continue;
        }

        // 1. Handling Attachments (Images, Audio, PDF Documents)
        if (webhookEvent.message && webhookEvent.message.attachments) {
          const attachment = webhookEvent.message.attachments[0];

          // Image Vision Analysis
          if (attachment.type === 'image') {
            await sendTextMessage(senderPsid, "👁️ Sinu-suri ko ang iyong larawan...", PAGE_ACCESS_TOKEN);
            const visionReply = await analyzeImageWithGemini(attachment.payload.url, getRandomApiKey(apiKeys));
            await sendLongTextMessage(senderPsid, visionReply, PAGE_ACCESS_TOKEN);
            continue;
          }

          // Voice Message / Speech-to-Text
          if (attachment.type === 'audio') {
            await sendTextMessage(senderPsid, "🎙️ Pinakikinggan ko ang audio message...", PAGE_ACCESS_TOKEN);
            const text = await transcribeAudio(attachment.payload.url);
            if (text) {
              await sendTextMessage(senderPsid, `Narinig ko: "${text}"`, PAGE_ACCESS_TOKEN);
              await processAIWithMemory(senderPsid, text, apiKeys, PAGE_ACCESS_TOKEN);
            } else {
              await sendTextMessage(senderPsid, "Pasensya na, hindi ko naintindihan ang boses sa audio.", PAGE_ACCESS_TOKEN);
            }
            continue;
          }

          // File / PDF Summarizer
          if (attachment.type === 'file') {
            await sendTextMessage(senderPsid, "📄 Binabasa ko ang dokumento...", PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "Natanggap ko ang file. Anong partikular na impormasyon ang gusto mong malaman dito?", PAGE_ACCESS_TOKEN);
            continue;
          }
        }

        // 2. Handling Regular Text Messages
        if (webhookEvent.message && webhookEvent.message.text && !webhookEvent.message.is_echo) {
          const userMessage = webhookEvent.message.text;
          const lowerText = userMessage.toLowerCase();

          // Image Generation Command
          if (lowerText.includes('generate image') || lowerText.includes('gumawa ng larawan') || lowerText.startsWith('image:')) {
            const prompt = userMessage.replace(/(generate image|gumawa ng larawan|image:)/gi, '').trim();
            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt || 'abstract art')}?width=1024&height=1024&nologo=true`;
            await sendTextMessage(senderPsid, `🎨 Ginagawa ang larawan: "${prompt}"...`, PAGE_ACCESS_TOKEN);
            await sendMediaAttachment(senderPsid, 'image', imageUrl, PAGE_ACCESS_TOKEN);
            continue;
          }

          // Music Search Command
          if (lowerText.includes('kanta') || lowerText.includes('patugtog') || lowerText.includes('music')) {
            const query = userMessage.replace(/(pa-music|patugtog|kanta ng|song|music)/gi, '').trim();
            const track = await searchMusic(query);
            if (track) {
              await sendTextMessage(senderPsid, `🎵 **${track.trackName}** - ${track.artistName}\n🔗 Link: ${track.trackViewUrl}`, PAGE_ACCESS_TOKEN);
              if (track.previewUrl) {
                await sendMediaAttachment(senderPsid, 'audio', track.previewUrl, PAGE_ACCESS_TOKEN);
              }
              continue;
            }
          }

          // TTS / Voice Response Request
          if (lowerText.startsWith('/voice ') || lowerText.startsWith('/speak ')) {
            const textToSpeak = userMessage.replace(/(\/voice|\/speak)/gi, '').trim();
            const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(textToSpeak)}&tl=tl&client=tw-ob`;
            await sendMediaAttachment(senderPsid, 'audio', ttsUrl, PAGE_ACCESS_TOKEN);
            continue;
          }

          // Default: Gemini AI Processing with Chat Memory
          await processAIWithMemory(senderPsid, userMessage, apiKeys, PAGE_ACCESS_TOKEN);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.status(404).send();
  }

  res.status(405).send('Method Not Allowed');
}

// Process AI using Conversation Memory (Vercel KV)
async function processAIWithMemory(senderPsid, userMessage, apiKeys, pageToken) {
  let history = [];
  try {
    history = (await kv.get(`chat_history_${senderPsid}`)) || [];
  } catch (e) {
    console.error("KV Memory error:", e);
  }

  history.push({ role: 'user', parts: [{ text: userMessage }] });

  // Keep last 10 messages for context
  if (history.length > 10) history = history.slice(-10);

  const selectedApiKey = getRandomApiKey(apiKeys);
  const aiReply = await getGeminiResponseWithHistory(history, selectedApiKey);

  history.push({ role: 'model', parts: [{ text: aiReply }] });
  
  try {
    await kv.set(`chat_history_${senderPsid}`, history, { ex: 86400 }); // Expire after 24 hrs
  } catch (e) {
    console.error("KV Save error:", e);
  }

  await sendLongTextMessage(senderPsid, aiReply, pageToken);
}

function getRandomApiKey(keysList) {
  if (!keysList || keysList.length === 0) return null;
  return keysList[Math.floor(Math.random() * keysList.length)];
}

// Gemini Multi-turn Chat
async function getGeminiResponseWithHistory(history, apiKey) {
  if (!apiKey) return 'Error: Walang na-detect na Gemini API Key.';

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: "You are 'JepongDevxyz AI', created by Jay-Ar Lee Espiritu. " +
                  "CAPABILITIES: You are an expert AI with chat memory, vision analysis, music search, code generation, and link capabilities. " +
                  "LANGUAGE: Automatically reply in the user's preferred language (Tagalog, Taglish, English, etc.)."
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

// Vision Analysis (Image Reading)
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
            { text: "Ipaliwanag at suriin ang larawang ito nang detalyado sa wikang Tagalog/English:" },
            { inline_data: { mime_type: "image/jpeg", data: base64Data } }
          ]
        }]
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Hindi ko mabasa ang larawan.';
  } catch (e) {
    return 'Nagkaroon ng error sa pag-proseo ng larawan.';
  }
}

// iTunes Search
async function searchMusic(query) {
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=1&media=music`);
    const data = await res.json();
    return data.results?.[0] || null;
  } catch (e) {
    return null;
  }
}

// Whisper Speech-to-Text
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

// Messenger Helpers
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
