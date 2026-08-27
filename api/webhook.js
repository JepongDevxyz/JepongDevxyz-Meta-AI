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
      try {
        for (const entry of body.entry) {
          if (!entry.messaging || !entry.messaging[0]) continue;
          
          const webhookEvent = entry.messaging[0];
          const senderPsid = webhookEvent.sender ? webhookEvent.sender.id : null;
          if (!senderPsid) continue;

          // 1. Handle Postback
          if (webhookEvent.postback) {
            const payload = webhookEvent.postback.payload;
            await handleCommandAction(senderPsid, payload, apiKeys, PAGE_ACCESS_TOKEN);
            continue;
          }

          // 2. Handle Attachments (Image, Video, etc.)
          if (webhookEvent.message && webhookEvent.message.attachments) {
            const attachment = webhookEvent.message.attachments[0];

            if (attachment.type === 'image') {
              await sendTypingOn(senderPsid, PAGE_ACCESS_TOKEN);
              await sendTextMessage(senderPsid, "📖 Sinu-suri ko ang iyong larawan... ✨", PAGE_ACCESS_TOKEN);
              const visionReply = await analyzeHomeworkWithGemini(attachment.payload.url, getRandomApiKey(apiKeys), senderPsid);
              await sendLongTextMessage(senderPsid, visionReply, PAGE_ACCESS_TOKEN);
              await sendTypingOff(senderPsid, PAGE_ACCESS_TOKEN);
              continue;
            }

            if (attachment.type === 'video') {
              await sendTextMessage(senderPsid, "🎥 Pasensya na! Sa ngayon ay mga larawan at text pa lamang ang kaya kong suriin.", PAGE_ACCESS_TOKEN);
              continue;
            }
          }

          // 3. Handle Normal Text / Commands
          if (webhookEvent.message && !webhookEvent.message.is_echo) {
            const userMessage = webhookEvent.message.text ? webhookEvent.message.text.trim() : '';
            const quickReplyPayload = webhookEvent.message.quick_reply ? webhookEvent.message.quick_reply.payload : null;
            const finalMessage = quickReplyPayload || userMessage;

            if (!finalMessage) continue;

            // Smart Periodic Table
            if (finalMessage.toLowerCase().includes('periodic table')) {
              await sendTextMessage(senderPsid, "🧪 **Periodic Table of Elements (HD)**", PAGE_ACCESS_TOKEN);
              await sendMediaAttachment(senderPsid, 'image', 'https://upload.wikimedia.org/wikipedia/commons/b/b3/Simple_Periodic_Table_Chart-en.svg', PAGE_ACCESS_TOKEN);
              continue;
            }

            let userMode = null;
            try {
              userMode = await kv.get(`user_mode_${senderPsid}`);
            } catch (e) {}

            if (userMode === 'IMAGE_MODE') {
              await kv.del(`user_mode_${senderPsid}`);
              await generateAndSendImage(senderPsid, finalMessage, PAGE_ACCESS_TOKEN);
              continue;
            }

            const handled = await handleCommandAction(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
            if (handled) continue;

            if (userMode === 'TALK_MODE') {
              await handleEnglishTalkMode(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
              continue;
            }

            // Default AI Chat
            await processAIWithMemory(senderPsid, finalMessage, apiKeys, PAGE_ACCESS_TOKEN);
          }
        }
      } catch (err) {
        console.error("Error processing webhook event:", err);
      }

      // 🛑 DITO NA ILALAGAY ANG RESPONSE (Pagkatapos mag-process ng lahat)
      return res.status(200).send('EVENT_RECEIVED');
    }

    return res.status(404).send('Not Found');
  }

  return res.status(405).send('Method Not Allowed');
}

async function handleCommandAction(senderPsid, input, apiKeys, pageToken) {
  const lowerText = input.toLowerCase().trim();

  // 🌐 Language Commands
  if (['/english', '/eng'].includes(lowerText)) {
    try { await kv.set(`user_lang_${senderPsid}`, 'ENGLISH'); } catch (e) {}
    await sendTextMessage(senderPsid, "🔤 **Language set to English!** I will respond strictly in English.", pageToken);
    return true;
  }

  if (['/tagalog', '/filipino', '/tag'].includes(lowerText)) {
    try { await kv.set(`user_lang_${senderPsid}`, 'TAGALOG'); } catch (e) {}
    await sendTextMessage(senderPsid, "🇵🇭 **Naka-set na sa Tagalog/Filipino!** Mula ngayon, Tagalog/Taglish na ang sasagutin ko.", pageToken);
    return true;
  }

  if (['/auto', '/autolang'].includes(lowerText)) {
    try { await kv.del(`user_lang_${senderPsid}`); } catch (e) {}
    await sendTextMessage(senderPsid, "🤖 **Smart Auto-Detect Enabled!** Kusa na ulit aangkop ang AI sa wika mo.", pageToken);
    return true;
  }

  // 🎨 Image Generator
  if (['/imagen', 'cmd_imagen'].includes(lowerText)) {
    await sendTypingOn(senderPsid, pageToken);
    try { await kv.set(`user_mode_${senderPsid}`, 'IMAGE_MODE', { ex: 600 }); } catch (e) {}
    await sendTextMessage(senderPsid, "🎨 **Image Generator Mode!**\n\nI-type mo na ngayon ang prompt (hal: *a cute cat wearing glasses*).", pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  if (lowerText.startsWith('/imagen ')) {
    await sendTypingOn(senderPsid, pageToken);
    const prompt = input.replace(/^\/imagen\s*/i, '').trim();
    if (prompt) await generateAndSendImage(senderPsid, prompt, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 🧮 Math Solver Command
  if (lowerText.startsWith('/math ')) {
    await sendTypingOn(senderPsid, pageToken);
    const mathProblem = input.replace(/^\/math\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Solve this step-by-step for a student: ${mathProblem}`, getRandomApiKey(apiKeys), senderPsid);
    await sendLongTextMessage(senderPsid, `🧮 **Math Solution:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 📈 Visual Math Graph
  if (lowerText.startsWith('/graph ')) {
    await sendTypingOn(senderPsid, pageToken);
    const mathEq = input.replace(/^\/graph\s*/i, '').trim();
    const chartUrl = `https://quickchart.io/chart?c={type:'line',data:{labels:[-5,-4,-3,-2,-1,0,1,2,3,4,5],datasets:[{label:'f(x) = ${encodeURIComponent(mathEq)}',data:[-10,-8,-6,-4,-2,0,2,4,6,8,10],borderColor:'blue',fill:false}]}}`;
    await sendTextMessage(senderPsid, `📈 **Visual Graph for:** \`${mathEq}\``, pageToken);
    await sendMediaAttachment(senderPsid, 'image', chartUrl, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 📝 Paraphrase Tool
  if (lowerText.startsWith('/paraphrase ')) {
    await sendTypingOn(senderPsid, pageToken);
    const textToPara = input.replace(/^\/paraphrase\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Paraphrase this academically with better vocabulary: ${textToPara}`, getRandomApiKey(apiKeys), senderPsid);
    await sendLongTextMessage(senderPsid, `📝 **Paraphrased Version:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 🔍 Wiki Search
  if (lowerText.startsWith('/wiki ')) {
    await sendTypingOn(senderPsid, pageToken);
    const topic = input.replace(/^\/wiki\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Give a concise Wikipedia-style summary with key facts about: ${topic}`, getRandomApiKey(apiKeys), senderPsid);
    await sendLongTextMessage(senderPsid, `🔍 **Wikipedia Summary - ${topic}:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 📖 Dictionary Define
  if (lowerText.startsWith('/define ')) {
    await sendTypingOn(senderPsid, pageToken);
    const word = input.replace(/^\/define\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Define "${word}". Include part of speech, meaning, and 2 example sentences.`, getRandomApiKey(apiKeys), senderPsid);
    await sendLongTextMessage(senderPsid, `📖 **Dictionary Definition:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 📚 Citation Generator
  if (lowerText.startsWith('/cite ')) {
    await sendTypingOn(senderPsid, pageToken);
    const citeDetails = input.replace(/^\/cite\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Generate citations for this material in both APA 7th Edition and MLA Format: ${citeDetails}`, getRandomApiKey(apiKeys), senderPsid);
    await sendLongTextMessage(senderPsid, `📚 **Citation References:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 🎴 Flashcards Generator
  if (lowerText.startsWith('/flashcards ')) {
    await sendTypingOn(senderPsid, pageToken);
    const topic = input.replace(/^\/flashcards\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Create 3 study flashcards (Question & Answer format) for the topic: ${topic}`, getRandomApiKey(apiKeys), senderPsid);
    await sendLongTextMessage(senderPsid, `🎴 **Study Flashcards - ${topic}:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 💻 Code Assistant
  if (lowerText.startsWith('/code ')) {
    await sendTypingOn(senderPsid, pageToken);
    const codeQuery = input.replace(/^\/code\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Act as an expert programmer. Help with this coding task/query, provide clean formatted code and brief explanations: ${codeQuery}`, getRandomApiKey(apiKeys), senderPsid);
    await sendLongTextMessage(senderPsid, `💻 **Code Solution:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 🌐 Link / Text Summarizer
  if (lowerText.startsWith('/summarize ')) {
    await sendTypingOn(senderPsid, pageToken);
    const content = input.replace(/^\/summarize\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Summarize this text or topic in 4-5 bullet points focusing on main ideas: ${content}`, getRandomApiKey(apiKeys), senderPsid);
    await sendLongTextMessage(senderPsid, `📌 **Key Summary:**\n\n${reply}`, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // ❓ Interactive Quiz
  if (lowerText.startsWith('/quiz ')) {
    await sendTypingOn(senderPsid, pageToken);
    const topic = input.replace(/^\/quiz\s*/i, '').trim();
    const reply = await getDirectGeminiResponse(`Create 1 multiple-choice review question about "${topic}" with 3 options labeled A, B, and C. Include the correct answer at the bottom hidden or indicated gently.`, getRandomApiKey(apiKeys), senderPsid);
    
    const quickReplies = [
      { content_type: "text", title: "Option A", payload: "Answered A" },
      { content_type: "text", title: "Option B", payload: "Answered B" },
      { content_type: "text", title: "Option C", payload: "Answered C" }
    ];
    await sendQuickReplyMessage(senderPsid, `❓ **Pop Quiz: ${topic}**\n\n${reply}`, quickReplies, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // 🗣️ Talk Practice Mode Toggle
  if (['/talk', 'cmd_talk'].includes(lowerText)) {
    try { await kv.set(`user_mode_${senderPsid}`, 'TALK_MODE'); } catch (e) {}
    await sendTextMessage(senderPsid, "🗣️ **English Practice Mode Active!** Start chatting with me in English. I'll correct your grammar naturally.", pageToken);
    return true;
  }

  // 📚 Help Command
  if (['/commands', '/help', 'cmd_help'].includes(lowerText)) {
    await sendTypingOn(senderPsid, pageToken);
    const helpMessage = 
      "📚 **JepongDevxyz AI Commands** 🤖✨\n\n" +
      "🌐 **Language Controls:**\n" +
      "• `/english` - Force English responses\n" +
      "• `/tagalog` - Force Tagalog responses\n" +
      "• `/auto` - Smart auto-detect language\n\n" +
      "🎓 **Academic & Student Tools:**\n" +
      "• `/imagen [prompt]` - AI Image generator\n" +
      "• `/math [problem]` - Step-by-step Math solver\n" +
      "• `/graph [equation]` - Visual Math function graph\n" +
      "• `/quiz [topic]` - Interactive multiple-choice quiz\n" +
      "• `/flashcards [topic]` - 3 Q&A study cards\n" +
      "• `/cite [details/link]` - APA 7th & MLA references\n" +
      "• `/code [lang] [task]` - Coding helper\n" +
      "• `/summarize [text]` - Fast bullet-point summary\n" +
      "• `/paraphrase [text]` - Academic essay rewriter\n" +
      "• `/wiki [topic]` - Wikipedia research\n" +
      "• `/define [word]` - Dictionary & examples\n" +
      "• `/talk` - English practice mode\n" +
      "• `/clear` - Reset memory & settings";

    await sendTextMessage(senderPsid, helpMessage, pageToken);
    await sendTypingOff(senderPsid, pageToken);
    return true;
  }

  // Reset Memory
  if (['/stop', '/clear', '/delete', '/refresh', 'cmd_clear'].includes(lowerText)) {
    try {
      await kv.del(`chat_history_${senderPsid}`);
      await kv.del(`user_mode_${senderPsid}`);
      await kv.del(`user_lang_${senderPsid}`);
    } catch (e) {}
    await sendTextMessage(senderPsid, "✅ **Reset Done!** Malinis na ulit ang memory at na-reset ang language settings sa Auto-Detect.", pageToken);
    return true;
  }

  return false;
}

async function generateAndSendImage(senderPsid, prompt, pageToken) {
  await sendTextMessage(senderPsid, `🖼️ **Ginagawa ko na ang larawan para sa:**\n"${prompt}"...\n\nSandali lang po! ✨`, pageToken);
  
  const seed = Math.floor(Math.random() * 1000000);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}/image.jpg?width=1024&height=1024&nologo=true&seed=${seed}`;

  try {
    await sendMediaAttachment(senderPsid, 'image', imageUrl, pageToken);
  } catch (error) {
    console.error("Image generation error:", error);
    await sendTextMessage(senderPsid, "❌ Pasensya na, nagkaroon ng error sa pag-send ng larawan.", pageToken);
  }
}

async function handleEnglishTalkMode(senderPsid, userMessage, apiKeys, pageToken) {
  await sendTypingOn(senderPsid, pageToken);
  const prompt = `Act as an English tutor. Respond to: "${userMessage}". If there are grammar errors, gently correct them.`;
  const tutorReply = await getDirectGeminiResponse(prompt, getRandomApiKey(apiKeys), senderPsid);
  await sendLongTextMessage(senderPsid, tutorReply, pageToken);
  await sendTypingOff(senderPsid, pageToken);
}

async function getDirectGeminiResponse(promptText, apiKey, senderPsid) {
  if (!apiKey) return 'Error: Missing API Key.';
  try {
    const systemInstructionText = await getSystemInstructionForUser(senderPsid);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstructionText }] },
        contents: [{ parts: [{ text: promptText }] }]
      })
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Walang tugon.';
  } catch (err) {
    return 'Nagkaroon ng problema.';
  }
}

async function analyzeHomeworkWithGemini(imageUrl, apiKey, senderPsid) {
  try {
    const imgRes = await fetch(imageUrl);
    const buffer = await imgRes.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString("base64");

    const systemInstructionText = await getSystemInstructionForUser(senderPsid);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstructionText }] },
        contents: [{
          parts: [
            { text: "Analyze this image and explain in detail based on the language instruction:" },
            { inline_data: { mime_type: "image/jpeg", data: base64Data } }
          ]
        }]
      })
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Paki-picture uli nang mas malinaw.';
  } catch (e) {
    return 'Error sa pagproseso ng larawan.';
  }
}

async function processAIWithMemory(senderPsid, userMessage, apiKeys, pageToken) {
  let history = [];
  try { history = (await kv.get(`chat_history_${senderPsid}`)) || []; } catch (e) {}

  history.push({ role: 'user', parts: [{ text: userMessage }] });
  if (history.length > 8) history = history.slice(-8);

  const selectedApiKey = getRandomApiKey(apiKeys);
  const aiReply = await getGeminiResponseWithHistory(history, selectedApiKey, senderPsid);

  history.push({ role: 'model', parts: [{ text: aiReply }] });
  try { await kv.set(`chat_history_${senderPsid}`, history, { ex: 86400 }); } catch (e) {}

  await sendLongTextMessage(senderPsid, aiReply, pageToken);
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
    return baseInstruction + "STRICT RULE: Respond strictly in English language ONLY. Even if the user talks in Tagalog, respond only in English.";
  } else if (userLang === 'TAGALOG') {
    return baseInstruction + "STRICT RULE: Respond strictly in Tagalog / Taglish language ONLY. Even if the user talks in English, respond in friendly Tagalog/Taglish.";
  } else {
    return baseInstruction + "SMART AUTO DETECT: Always detect the language used by the user in their message and respond in that exact same language naturally.";
  }
}

async function getGeminiResponseWithHistory(history, apiKey, senderPsid) {
  if (!apiKey) return 'Error: Missing API Key.';
  try {
    const systemInstructionText = await getSystemInstructionForUser(senderPsid);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstructionText }] },
        contents: history
      })
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Paki-tanong ulit!';
  } catch (error) {
    return 'Error sa AI response.';
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
    body: JSON.stringify({ recipient: { id: senderPsid }, message: { attachment: { type: type, payload: { url: url, is_reusable: true } } } })
  });
}

async function sendQuickReplyMessage(senderPsid, text, quickReplies, pageToken) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: senderPsid },
      message: {
        text: text,
        quick_replies: quickReplies
      }
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
    body: JSON.stringify({ recipient: { id: senderPsid }, message: { text: responseText } })
  });
}
