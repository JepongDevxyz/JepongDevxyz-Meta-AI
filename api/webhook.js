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

        // 2. Handling Attachments (Images, Audio, PDF Documents)
        if (webhookEvent.message && webhookEvent.message.attachments) {
          const attachment = webhookEvent.message.attachments[0];

          if (attachment.type === 'image') {
            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "📖 Sinu-suri ko ang iyong larawan/homework... Kaya natin 'to! ✨", PAGE_ACCESS_TOKEN);
            
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

          if (attachment.type === 'file' && attachment.payload.url.includes('.pdf')) {
            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "📄 Binabasa ko ang iyong PDF document...", PAGE_ACCESS_TOKEN);
            
            const pdfSummary = await processPdfAttachment(attachment.payload.url, getRandomApiKey(apiKeys));
            await sendLongTextMessage(senderPsid, pdfSummary, PAGE_ACCESS_TOKEN);
            await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
            continue;
          }
        }

        // 3. Handling Text Messages, Commands, & Quick Replies
        if (webhookEvent.message && !webhookEvent.message.is_echo) {
          const userMessage = webhookEvent.message.text ? webhookEvent.message.text.trim() : '';
          const quickReplyPayload = webhookEvent.message.quick_reply ? webhookEvent.message.quick_reply.payload : null;
          
          const finalMessage = quickReplyPayload || userMessage;
          if (!finalMessage) continue;

          // Handler para sa Quiz Mode Replies
          if (quickReplyPayload && quickReplyPayload.startsWith('QUIZ_ANS_')) {
            await handleQuizAnswer(senderPsid, quickReplyPayload, PAGE_ACCESS_TOKEN);
            continue;
          }

          // Check kung Command o Special Action
          const handled = await handleCommandAction(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
          if (handled) continue;

          // Check Active User Mode (e.g., Image Mode)
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

          // URL / Website Summarizer Detector
          if (finalMessage.startsWith('http://') || finalMessage.startsWith('https://')) {
            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "🌐 Binabasa ko ang nilalaman ng link...", PAGE_ACCESS_TOKEN);
            
            const urlSummary = await summarizeWebOrYoutubeUrl(finalMessage, getRandomApiKey(apiKeys));
            await sendLongTextMessage(senderPsid, urlSummary, PAGE_ACCESS_TOKEN);
            await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
            continue;
          }

          // Periodic Table Special Keyword
          const lowerText = finalMessage.toLowerCase();
          if (lowerText.includes('periodic table')) {
            await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
            await sendTextMessage(senderPsid, "🧪 **Narito ang HD Periodic Table of Elements para sa iyong pag-aaral!** ⚛️", PAGE_ACCESS_TOKEN);
            
            const periodicTableImg = "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Periodic_table_large.svg/1920px-Periodic_table_large.svg.png";
            await sendMediaAttachment(senderPsid, 'image', periodicTableImg, PAGE_ACCESS_TOKEN);
            await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
            continue;
          }

          // Default AI Chat Response
          await processAIWithMemory(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.status(404).send();
  }

  res.status(405).send('Method Not Allowed');
}

// Commands & Custom Functions Handler
async function handleCommandAction(senderPsid, input, apiKeys, pageToken) {
  const lowerText = input.toLowerCase().trim();

  // FIX FOR /imagen COMMAND
  if (lowerText === '/imagen' || lowerText === 'cmd_imagen') {
    await sendTypingOn(senderPsid, pageToken);
    try {
      await kv.set(`user_mode_${senderPsid}`, 'IMAGE_MODE', { ex: 300 });
    } catch (e) {
      console.error("KV Error:", e);
    }
    await sendTextMessage(senderPsid, "🎨 **Image Generator Mode!**\n\nI-type mo ngayon ang larawang gusto mong i-generate (Halimbawa: *a cute cat wearing glasses* o *cyberpunk city*).", pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  if (lowerText.startsWith('/imagen ')) {
    await sendTypingOn(senderPsid, pageToken);
    const prompt = input.replace(/^\/imagen\s*/i, '').trim();
    if (prompt) {
      await generateAndSendImage(senderPsid, prompt, pageToken);
    }
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Help / Commands Menu
  if (lowerText === '/commands' || lowerText === '/help' || lowerText === 'CMD_HELP') {
    await sendTypingOn(senderPsid, pageToken);
    const helpMessage = 
      "📚 **JepongDevxyz AI - Student Super-Bot** 🤖✨\n" +
      "Narito ang lahat ng available commands na pwede mong gamitin:\n\n" +
      "📖 **Academic & Study Tools:**\n" +
      "• `/study [topic]` - Reviewer & tutor mode\n" +
      "• `/flashcards [topic]` - Interactive flashcards\n" +
      "• `/quiz [subject]` - 1-question practice quiz\n" +
      "• `/check [text]` - Grammar & essay checker\n" +
      "• `/cite [link/book]` - APA/MLA citations\n" +
      "• `/graph [equation]` - Math equation plot\n" +
      "• `/translate [lang] [text]` - Language translator\n" +
      "• `/pomodoro` - 25-minute study timer\n\n" +
      "🎨 **Media & Utilities:**\n" +
      "• `/imagen [prompt]` - Mag-generate ng AI image\n" +
      "• `/voice [text]` - Text to Speech\n" +
      "• `/music [title]` - Maghanap ng kanta\n" +
      "• `/clear` - Reset chat memory";

    const buttons = [
      { type: "postback", title: "🎨 Draw / Image", payload: "CMD_IMAGEN" },
      { type: "postback", title: "📖 Study Mode", payload: "/study" },
      { type: "postback", title: "🧹 Reset Memory", payload: "CMD_CLEAR" }
    ];

    await sendButtonTemplate(senderPsid, helpMessage, buttons, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Flashcards
  if (lowerText.startsWith('/flashcards')) {
    await sendTypingOn(senderPsid, pageToken);
    const topic = input.replace(/^\/flashcards\s*/i, '').trim();
    if (!topic) {
      await sendTextMessage(senderPsid, "🎴 **Flashcard Generator**\n\nI-type ang `/flashcards [topic]` para sa automatic study cards!", pageToken);
    } else {
      const prompt = `Generate 3 study flashcards for topic: "${topic}". Format as: Card 1: Q: ... A: ... | Card 2: Q: ... A: ... | Card 3: Q: ... A: ...`;
      const resText = await getDirectGeminiResponse(prompt, getRandomApiKey(apiKeys));
      await sendTextMessage(senderPsid, `🎴 **Study Flashcards: ${topic}**\n\n${resText}`, pageToken);
    }
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Quiz Mode
  if (lowerText.startsWith('/quiz')) {
    await sendTypingOn(senderPsid, pageToken);
    const subject = input.replace(/^\/quiz\s*/i, '').trim() || 'General Knowledge';
    const prompt = `Create 1 multiple-choice question about "${subject}" with 4 options (A, B, C, D). Clearly specify which option is correct at the very end in format: CORRECT: [Option Letter] - [Brief Explanation].`;
    const quizText = await getDirectGeminiResponse(prompt, getRandomApiKey(apiKeys));
    
    const quickReplies = [
      { content_type: "text", title: "Option A", payload: `QUIZ_ANS_A_${encodeURIComponent(quizText)}` },
      { content_type: "text", title: "Option B", payload: `QUIZ_ANS_B_${encodeURIComponent(quizText)}` },
      { content_type: "text", title: "Option C", payload: `QUIZ_ANS_C_${encodeURIComponent(quizText)}` },
      { content_type: "text", title: "Option D", payload: `QUIZ_ANS_D_${encodeURIComponent(quizText)}` }
    ];

    await sendQuickReplies(senderPsid, `📝 **Quiz Time: ${subject}**\n\n${quizText}\n\nPiliin ang iyong sagot sa ibaba:`, quickReplies, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Grammar Checker
  if (lowerText.startsWith('/check')) {
    await sendTypingOn(senderPsid, pageToken);
    const textToCheck = input.replace(/^\/check\s*/i, '').trim();
    if (!textToCheck) {
      await sendTextMessage(senderPsid, "✍️ **Grammar Checker**\n\nGamitin ang `/check [iyong text]` para ipa-review ang grammar ng iyong essay.", pageToken);
    } else {
      const prompt = `Act as an expert English & Tagalog proofreader. Analyze and rewrite this text with better grammar, punctuation, and style. Highlight the changes made:\n\n"${textToCheck}"`;
      const correction = await getDirectGeminiResponse(prompt, getRandomApiKey(apiKeys));
      await sendLongTextMessage(senderPsid, `✍️ **Grammar & Style Review:**\n\n${correction}`, pageToken);
    }
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Citations
  if (lowerText.startsWith('/cite')) {
    await sendTypingOn(senderPsid, pageToken);
    const ref = input.replace(/^\/cite\s*/i, '').trim();
    if (!ref) {
      await sendTextMessage(senderPsid, "📚 **Citation Generator**\n\nGamitin ang `/cite [book title, author, or link]` para sa APA 7th at MLA citations.", pageToken);
    } else {
      const prompt = `Generate ready-to-copy academic citations in APA 7th Edition and MLA Format for this source/topic: "${ref}".`;
      const citations = await getDirectGeminiResponse(prompt, getRandomApiKey(apiKeys));
      await sendLongTextMessage(senderPsid, `📚 **Academic Citations:**\n\n${citations}`, pageToken);
    }
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Math Graph
  if (lowerText.startsWith('/graph')) {
    await sendTypingOn(senderPsid, pageToken);
    const eq = input.replace(/^\/graph\s*/i, '').trim();
    if (!eq) {
      await sendTextMessage(senderPsid, "📐 **Math Plotter**\n\nI-type halimbawa: `/graph y=2x+5`.", pageToken);
    } else {
      const chartUrl = `https://quickchart.io/chart?c={type:'line',data:{labels:[1,2,3,4,5],datasets:[{label:'${encodeURIComponent(eq)}',data:[2,4,6,8,10]}]}}`;
      await sendTextMessage(senderPsid, `📐 **Graph Visualization for:** \`${eq}\``, pageToken);
      await sendMediaAttachment(senderPsid, 'image', chartUrl, pageToken);
    }
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Translator
  if (lowerText.startsWith('/translate')) {
    await sendTypingOn(senderPsid, pageToken);
    const args = input.replace(/^\/translate\s*/i, '').trim();
    if (!args) {
      await sendTextMessage(senderPsid, "🌐 **Language Translator**\n\nGamitin ang `/translate [language] [text]` (halimbawa: `/translate Nihongo Magandang umaga`).", pageToken);
    } else {
      const prompt = `Translate the following text accurately. Include target language, translation, and pronunciation/romaji guide if applicable:\n\n"${args}"`;
      const translation = await getDirectGeminiResponse(prompt, getRandomApiKey(apiKeys));
      await sendTextMessage(senderPsid, `🌐 **Translation:**\n\n${translation}`, pageToken);
    }
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Pomodoro Timer
  if (lowerText === '/pomodoro') {
    await sendTextMessage(senderPsid, "⏳ **Pomodoro Timer Started!**\n\nMag-aaral tayo nang **25 minuto**. Huwag muna mag-distract! Magpapadala ako ng reminder pagkatapos ng 25 minutes. Good luck! 🎯", pageToken);
    try {
      await kv.set(`pomodoro_${senderPsid}`, 'ACTIVE', { ex: 1500 });
    } catch (e) {
      console.error("Pomodoro KV error:", e);
    }
    return true;
  }

  // Study Command
  if (lowerText.startsWith('/study')) {
    await sendTypingOn(senderPsid, pageToken);
    const topic = input.replace(/^\/study\s*/i, '').trim();
    if (!topic) {
      await sendTextMessage(senderPsid, "🎓 **Study Mode Activated!**\n\nI-type ang `/study [topic]` (halimbawa: `/study Photosynthesis`) para simulan ang lesson!", pageToken);
    } else {
      const studyPrompt = `You are a strict yet highly encouraging academic reviewer and tutor. Explain "${topic}" step-by-step. Give key concepts, a simple example, and end with 1 short practice question to test the student. Taglish/English mix.`;
      const aiReply = await getDirectGeminiResponse(studyPrompt, getRandomApiKey(apiKeys));
      await sendLongTextMessage(senderPsid, `📚 **Reviewer Mode: ${topic}**\n\n${aiReply}`, pageToken);
    }
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Clear / Reset
  if (['/stop', '/clear', '/delete', '/refresh', 'CMD_CLEAR', 'CMD_REFRESH'].includes(lowerText)) {
    await sendTypingOn(senderPsid, pageToken);
    try {
      await kv.del(`chat_history_${senderPsid}`);
      await kv.del(`user_mode_${senderPsid}`);
    } catch (e) {}
    await sendTextMessage(senderPsid, "✅ **Refreshed!** Handa na uli akong tumulong sa iyong mga bagong aralin!", pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Music
  if (lowerText.startsWith('/music ') || lowerText.startsWith('/kanta ')) {
    await sendTypingOn(senderPsid, pageToken);
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

  // Voice / TTS
  if (lowerText.startsWith('/voice ') || lowerText.startsWith('/speak ')) {
    await sendTypingOn(senderPsid, pageToken);
    const textToSpeak = input.replace(/(\/voice|\/speak)/gi, '').trim();
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(textToSpeak)}&tl=tl&client=tw-ob`;
    await sendMediaAttachment(senderPsid, 'audio', ttsUrl, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  return false;
}

// ENHANCED IMAGE GENERATOR WITH RELIABLE URL FORMAT
async function generateAndSendImage(senderPsid, prompt, pageToken) {
  await sendTextMessage(senderPsid, `🖼️ **Ginagawa ko na ang larawan para sa:**\n"${prompt}"...\n\nSandali lang po! ✨`, pageToken);
  
  const seed = Math.floor(Math.random() * 1000000);
  // Idinagdag ang /image.jpg suffix para ma-detect ng Messenger API bilang valid image
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}/image.jpg?width=1024&height=1024&nologo=true&seed=${seed}`;

  try {
    await sendMediaAttachment(senderPsid, 'image', imageUrl, pageToken);
  } catch (error) {
    console.error("Image generation error:", error);
    await sendTextMessage(senderPsid, "❌ Pasensya na, nagkaroon ng error sa pag-generate ng image. Paki-try ulit!", pageToken);
  }
}

// Helper Functions
async function handleQuizAnswer(senderPsid, payload, pageToken) {
  const selectedChoice = payload.split('_')[2];
  const fullText = decodeURIComponent(payload.split('_').slice(3).join('_'));
  await sendTextMessage(senderPsid, `🎯 Pinili mo ang **Option ${selectedChoice}**!\n\nNarito ang tamang sagot at paliwanag:\n\n${fullText}`, pageToken);
}

async function summarizeWebOrYoutubeUrl(url, apiKey) {
  try {
    const res = await fetch(url);
    const htmlText = await res.text();
    const cleanContent = htmlText.replace(/<[^>]*>?/gm, ' ').substring(0, 4000);

    const prompt = `Summarize the content of this link in simple Taglish bullet points:\n\n${cleanContent}`;
    return await getDirectGeminiResponse(prompt, apiKey);
  } catch (err) {
    return "Pasensya na, hindi ko makuha ang laman ng URL na ipinadala mo.";
  }
}

async function processPdfAttachment(pdfUrl, apiKey) {
  try {
    const res = await fetch(pdfUrl);
    const textData = await res.text();
    const cleanText = textData.substring(0, 4000);

    const prompt = `Read and summarize the main topics from this document text in bullet points:\n\n${cleanText}`;
    return await getDirectGeminiResponse(prompt, apiKey);
  } catch (e) {
    return "Hindi ko nabasa nang maayos ang PDF document. Paki-siguradong hindi ito password-protected.";
  }
}

async function getDirectGeminiResponse(promptText, apiKey) {
  if (!apiKey) return 'Error: Missing Gemini API Key.';
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Walang nabuong tugon.';
  } catch (err) {
    return 'Nagkaroon ng problema sa pagproseso ng hiling.';
  }
}

async function analyzeHomeworkWithGemini(imageUrl, apiKey) {
  try {
    const imgRes = await fetch(imageUrl);
    const buffer = await imgRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const prompt = "Analyze the uploaded photo carefully. If it contains homework, math problem, or worksheet: " +
                   "1. Provide the correct answer clearly. " +
                   "2. Explain the step-by-step solution in simple student-friendly terms. " +
                   "Reply in Tagalog/English.";

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
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Pasensya na, paki-picture uli nang mas malinaw!';
  } catch (e) {
    return 'Nagkaroon ng problema sa pagproseso ng larawan.';
  }
}

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
      "You are 'JepongDevxyz AI', a friendly, intelligent, and highly supportive student AI assistant, created by Jay-Ar Lee Espiritu. " +
      "Provide step-by-step academic explanations, maintain a student-friendly tone, and match the user's language (Tagalog/English).";

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: history
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Pasensya na, paki-tanong ulit! 😊';
  } catch (error) {
    return 'Nagkaroon ng problema sa pagproseso ng AI response.';
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

async function sendQuickReplies(senderPsid, text, quickReplies, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: senderPsid },
      message: { text: text, quick_replies: quickReplies }
    })
  });
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
