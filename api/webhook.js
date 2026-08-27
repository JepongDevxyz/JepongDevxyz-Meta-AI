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
    } else {
      return res.status(403).send('Forbidden');
    }
  }

  if (req.method === 'POST') {
    const body = req.body;

    if (body.object === 'page') {
      for (const entry of body.entry) {
        const webhookEvent = entry.messaging[0];
        const senderPsid = webhookEvent.sender.id;

        // 1. Handling Voice Messages (Audio Attachment)
        if (webhookEvent.message && webhookEvent.message.attachments) {
          const audioAttachment = webhookEvent.message.attachments.find(a => a.type === 'audio');
          if (audioAttachment) {
            await sendTextMessage(senderPsid, "🎙️ Pinakikinggan ko ang iyong voice message...", PAGE_ACCESS_TOKEN);
            const transcribedText = await transcribeAudio(audioAttachment.payload.url);
            
            if (transcribedText) {
              await sendTextMessage(senderPsid, `Narinig ko: "${transcribedText}"`, PAGE_ACCESS_TOKEN);
              await handleUserIntent(senderPsid, transcribedText, apiKeys, PAGE_ACCESS_TOKEN);
            } else {
              await sendTextMessage(senderPsid, "Pasensya na, hindi ko gaanong naintindihan ang boses sa audio message.", PAGE_ACCESS_TOKEN);
            }
            continue;
          }
        }

        // 2. Handling Regular Text Messages
        if (webhookEvent.message && webhookEvent.message.text && !webhookEvent.message.is_echo) {
          const userMessage = webhookEvent.message.text;
          await handleUserIntent(senderPsid, userMessage, apiKeys, PAGE_ACCESS_TOKEN);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    } else {
      return res.status(404).send();
    }
  }

  res.status(405).send('Method Not Allowed');
}

// Main logic routing (Image, Music, Link, o Normal Chat)
async function handleUserIntent(senderPsid, userMessage, apiKeys, pageToken) {
  const lowerText = userMessage.toLowerCase();

  // Check kung Image Generation Request
  if (lowerText.includes('generate image') || lowerText.includes('gumawa ng larawan') || lowerText.includes('drawing ng') || lowerText.startsWith('image:')) {
    const prompt = userMessage.replace(/(generate image|gumawa ng larawan|drawing ng|image:)/gi, '').trim();
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt || 'beautiful abstract art')}?width=1024&height=1024&nologo=true`;
    
    await sendTextMessage(senderPsid, `🎨 Ginagawa ko ang larawan para sa: "${prompt}"...`, pageToken);
    await sendMediaAttachment(senderPsid, 'image', imageUrl, pageToken);
    return;
  }

  // Check kung Music / Song Search Request
  if (lowerText.includes('kanta') || lowerText.includes('music') || lowerText.includes('song') || lowerText.includes('patugtog') || lowerText.includes('play')) {
    const query = userMessage.replace(/(pa-music|patugtog|kanta ng|song|music|play)/gi, '').trim();
    const track = await searchMusic(query);
    
    if (track) {
      await sendTextMessage(senderPsid, `🎵 **${track.trackName}** - ${track.artistName}\n\n🔗 Full Track / iTunes: ${track.trackViewUrl}`, pageToken);
      if (track.previewUrl) {
        await sendMediaAttachment(senderPsid, 'audio', track.previewUrl, pageToken);
      }
      return;
    }
  }

  // Normal Chat / Standard Queries gamit si Gemini AI
  const selectedApiKey = getRandomApiKey(apiKeys);
  const aiReply = await getGeminiResponse(userMessage, selectedApiKey);
  await sendLongTextMessage(senderPsid, aiReply, pageToken);
}

function getRandomApiKey(keysList) {
  if (!keysList || keysList.length === 0) return null;
  return keysList[Math.floor(Math.random() * keysList.length)];
}

// Gemini AI Call
async function getGeminiResponse(userPrompt, apiKey) {
  if (!apiKey) return 'Error: Walang na-detect na Gemini API Key.';

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: "You are 'JepongDevxyz AI', created by Jay-Ar Lee Espiritu. " +
                  "CAPABILITIES: You are an expert assistant capable of answering questions, helping with code, providing useful Web/YouTube links when requested, and guiding users. " +
                  "LINKS: When a user asks for references or links, provide direct and useful URLs (e.g., Google, YouTube, Wikipedia). " +
                  "LANGUAGE: Automatically reply in the user's language (Tagalog, English, Taglish, etc.)."
          }]
        },
        contents: [{ parts: [{ text: userPrompt }] }]
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Pasensya na, hindi ko maproseso ang tanong sa ngayon.';
  } catch (error) {
    return 'Nagkaroon ng problema sa AI response.';
  }
}

// iTunes Music Search API
async function searchMusic(query) {
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=1&media=music`);
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      return data.results[0];
    }
  } catch (e) {
    console.error('Music search error:', e);
  }
  return null;
}

// Speech-to-Text Transcription via Hugging Face Public Inference
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
    console.error('Audio transcription error:', err);
    return null;
  }
}

// Helper: Sending Media Attachments (Image/Audio) to Messenger
async function sendMediaAttachment(senderPsid, type, url, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: senderPsid },
      message: {
        attachment: {
          type: type,
          payload: { url: url, is_reusable: true }
        }
      }
    })
  });
}

// Helper: Splitting Long Text Messages
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

// Helper: Sending Text Messages
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
