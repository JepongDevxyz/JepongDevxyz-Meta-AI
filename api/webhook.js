export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  
  // Kukunin ang listahan ng API keys at gagawing array
  const rawKeys = process.env.GEMINI_API_KEYS || '';
  const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

  // 1. Webhook Verification (GET Request mula sa Meta)
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

  // 2. Incoming Messages (POST Request)
  if (req.method === 'POST') {
    const body = req.body;

    if (body.object === 'page') {
      for (const entry of body.entry) {
        const webhookEvent = entry.messaging[0];
        const senderPsid = webhookEvent.sender.id;

        if (webhookEvent.message && webhookEvent.message.text && !webhookEvent.message.is_echo) {
          const userMessage = webhookEvent.message.text;
          
          // Pipili ng random key sa listahan ng API keys
          const selectedApiKey = getRandomApiKey(apiKeys);
          
          const aiReply = await getGeminiResponse(userMessage, selectedApiKey);
          await sendTextMessage(senderPsid, aiReply, PAGE_ACCESS_TOKEN);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    } else {
      return res.status(404).send();
    }
  }

  res.status(405).send('Method Not Allowed');
}

// Function para pumili ng random API Key
function getRandomApiKey(keysList) {
  if (!keysList || keysList.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * keysList.length);
  return keysList[randomIndex];
}

async function getGeminiResponse(userPrompt, apiKey) {
  if (!apiKey) {
    return 'Error: Walang na-detect na Gemini API Key.';
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: "You are 'JepongDevxyz AI', an AI assistant created by Jay-Ar Lee Espiritu. " +
                  "Identity Rule: If anyone asks who you are or who created/developed you, state clearly that you are JepongDevxyz AI and you were created by Jay-Ar Lee Espiritu. " +
                  "Language Rule: Automatically detect the language used by the user (Tagalog, English, Taglish, Spanish, etc.) and respond in that EXACT same language naturally."
          }]
        },
        contents: [{
          parts: [{ text: userPrompt }]
        }]
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Pasensya na, hindi ko maproseso ang tanong sa ngayon.';
  } catch (error) {
    return 'Nagkaroon ng problema sa AI response.';
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
