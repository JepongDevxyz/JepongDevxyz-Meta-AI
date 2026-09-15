const GEMINI_MODELS_FALLBACK = [
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest'
];

const FB_GRAPH_VERSION = process.env.FB_GRAPH_VERSION || 'v26.0';
const MAX_HISTORY_ITEMS = 10;
const MAX_CONVERSATIONS = 500;
const MAX_INLINE_BYTES = 18 * 1024 * 1024;
const MAX_WEB_MESSAGE_CHARS = 12000;
const MESSENGER_CHUNK_SIZE = 1800;

let currentKeyIndex = 0;

function getApiKeysList() {
  const raw =
    process.env.GEMINI_API_KEYS ||
    process.env.GEMINI_API_KEY ||
    '';

  return raw
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);
}

function normalizeWebSessionId(sessionId) {
  if (typeof sessionId !== 'string') {
    return null;
  }

  const clean =
    sessionId
      .trim()
      .slice(0, 128);

  return clean
    ? `web:${clean}`
    : null;
}

function setLimitedConversation(
  map,
  key,
  value
) {
  if (!key) {
    return;
  }

  if (map.has(key)) {
    map.delete(key);
  }

  map.set(
    key,
    value
  );

  while (
    map.size >
    MAX_CONVERSATIONS
  ) {
    map.delete(
      map
        .keys()
        .next()
        .value
    );
  }
}

function stripDataUrlPrefix(
  value
) {
  if (
    typeof value !==
    'string'
  ) {
    return '';
  }

  const comma =
    value.indexOf(',');

  return (
    value.startsWith(
      'data:'
    ) &&
    comma !== -1
  )
    ? value.slice(
        comma + 1
      )
    : value;
}

function extractGeminiText(
  data
) {
  const parts =
    data
      ?.candidates?.[0]
      ?.content?.parts;

  if (
    !Array.isArray(
      parts
    )
  ) {
    return '';
  }

  return parts
    .filter(
      p =>
        typeof p?.text ===
          'string' &&
        p.text.trim() &&
        !p.thought
    )
    .map(
      p =>
        p.text
    )
    .join('\n')
    .trim();
}

function extractUrls(
  text
) {
  if (
    typeof text !==
    'string'
  ) {
    return [];
  }

  return [
    ...new Set(
      (
        text.match(
          /https?:\/\/[^\s<>()]+/gi
        ) || []
      ).map(
        url =>
          url.replace(
            /[.,!?;:)]+$/,
            ''
          )
      )
    )
  ].slice(
    0,
    20
  );
}

async function fetchBinaryAsBase64(
  url,
  fallbackMimeType
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      10000
    );

  try {
    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `Download failed: HTTP ${response.status}`
      );
    }

    const declaredSize =
      Number(
        response.headers.get(
          'content-length'
        ) || 0
      );

    if (
      declaredSize >
      MAX_INLINE_BYTES
    ) {
      throw new Error(
        'Attachment is too large.'
      );
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (
      buffer.length >
      MAX_INLINE_BYTES
    ) {
      throw new Error(
        'Attachment is too large.'
      );
    }

    const mimeType =
      (
        response.headers.get(
          'content-type'
        ) ||
        fallbackMimeType ||
        'application/octet-stream'
      )
        .split(';')[0]
        .trim()
        .toLowerCase();

    return {
      data:
        buffer.toString(
          'base64'
        ),

      mimeType
    };

  } finally {
    clearTimeout(
      timer
    );
  }
}

function getPhilippineDateTime() {
  return new Date()
    .toLocaleString(
      'en-US',
      {
        timeZone:
          'Asia/Manila',

        weekday:
          'long',

        year:
          'numeric',

        month:
          'long',

        day:
          'numeric',

        hour:
          'numeric',

        minute:
          '2-digit',

        hour12:
          true
      }
    );
}

/* =========================================================
   WEB SEARCH
========================================================= */

async function performFreeWebSearch(
  query
) {
  const cleanQuery =
    String(
      query || ''
    )
      .replace(
        /^(search|mag-search|hanapin|ano ang balita sa|updates sa)\s+/i,
        ''
      )
      .trim();

  if (
    !cleanQuery
  ) {
    return null;
  }

  const liveIntent =
    /(latest|update|balita|ngayon|today|current|presyo|price|score|weather|panahon|forecast)/i
      .test(
        cleanQuery
      );

  const searchQuery =
    liveIntent
      ? `${cleanQuery} ${new Date().getFullYear()}`
      : cleanQuery;

  /*
   * WEATHER
   */
  if (
    /weather|panahon|ulan|init|bagyo|temperatura|temperature|forecast/i
      .test(
        cleanQuery
      )
  ) {
    try {
      const place =
        cleanQuery
          .replace(
            /\b(weather|panahon|ulan|init|bagyo|temperatura|temperature|forecast|ngayon|today|current|kumusta)\b/gi,
            ' '
          )
          .replace(
            /\s+/g,
            ' '
          )
          .trim()
          .replace(
            /^(sa|in|at)\s+/i,
            ''
          )
          .trim();

      if (
        place
      ) {
        const geoRes =
          await fetch(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
              place
            )}&count=1&language=en&format=json`
          );

        if (
          geoRes.ok
        ) {
          const geoData =
            await geoRes.json();

          if (
            geoData
              .results?.[0]
          ) {
            const {
              latitude,
              longitude,
              name,
              admin1,
              country
            } =
              geoData
                .results[0];

            const weatherRes =
              await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m&timezone=auto`
              );

            if (
              weatherRes.ok
            ) {
              const weatherData =
                await weatherRes.json();

              const c =
                weatherData.current;

              if (
                c
              ) {
                return (
                  `Live Weather Report (${name}, ${admin1 || ''}, ${country})\n` +
                  `Temperature: ${c.temperature_2m}°C\n` +
                  `Feels Like: ${c.apparent_temperature}°C\n` +
                  `Humidity: ${c.relative_humidity_2m}%\n` +
                  `Precipitation: ${c.precipitation} mm\n` +
                  `Wind: ${c.wind_speed_10m} km/h`
                );
              }
            }
          }
        }
      }

    } catch (
      error
    ) {
      console.warn(
        '[Weather API Error]',
        error.message
      );
    }
  }

  /*
   * TAVILY
   */
  const tavilyKey =
    process.env
      .TAVILY_API_KEY;

  if (
    tavilyKey
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        5000
      );

    try {
      const response =
        await fetch(
          'https://api.tavily.com/search',
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json',

              Authorization:
                `Bearer ${tavilyKey}`
            },

            body:
              JSON.stringify({
                query:
                  searchQuery,

                search_depth:
                  'basic',

                max_results:
                  4
              }),

            signal:
              controller.signal
          }
        );

      if (
        response.ok
      ) {
        const data =
          await response.json();

        if (
          Array.isArray(
            data.results
          ) &&
          data.results.length
        ) {
          return data
            .results
            .slice(
              0,
              4
            )
            .map(
              r =>
                `• ${r.title || 'Result'}: ${r.content || r.url || ''}`
            )
            .join(
              '\n\n'
            );
        }
      }

    } catch (
      error
    ) {
      console.warn(
        '[Tavily Search Failed]',
        error.message
      );

    } finally {
      clearTimeout(
        timer
      );
    }
  }

  /*
   * SEARXNG
   */
  const instances = [
    'https://search.ononoki.org',
    'https://searx.be',
    'https://baresearch.org'
  ];

  for (
    const instance of
    instances
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        3500
      );

    try {
      const searchUrl =
        `${instance}/search?q=${encodeURIComponent(
          searchQuery
        )}&format=json&language=tl,en`;

      const response =
        await fetch(
          searchUrl,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (compatible; JepongDevxyzBot/1.0)'
            },

            signal:
              controller.signal
          }
        );

      if (
        response.ok
      ) {
        const data =
          await response.json();

        if (
          Array.isArray(
            data.results
          ) &&
          data.results.length
        ) {
          const results =
            data.results
              .slice(
                0,
                4
              )
              .map(
                r =>
                  `• ${r.title || 'Result'}: ${r.content || r.url || ''}`
              )
              .filter(
                Boolean
              );

          if (
            results.length
          ) {
            return results
              .join(
                '\n\n'
              );
          }
        }
      }

    } catch (_) {
      // Try next instance.

    } finally {
      clearTimeout(
        timer
      );
    }
  }

  /*
   * WIKIPEDIA FALLBACK
   */
  try {
    const wikiRes =
      await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
          cleanQuery
        )}`,
        {
          headers: {
            'User-Agent':
              'JepongDevxyzBot/1.0'
          }
        }
      );

    if (
      wikiRes.ok
    ) {
      const data =
        await wikiRes.json();

      if (
        data.extract
      ) {
        return data.extract;
      }
    }

  } catch (_) {}

  return null;
}

/* =========================================================
   MEMORY
========================================================= */

const processedMessageIds =
  new Set();

const userPersonasMap =
  new Map();

const userConversationsMap =
  new Map();

const webConversationsMap =
  new Map();

/* =========================================================
   MAIN HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {
  const VERIFY_TOKEN =
    process.env
      .VERIFY_TOKEN;

  const PAGE_ACCESS_TOKEN =
    process.env
      .PAGE_ACCESS_TOKEN;

  const ADMIN_PSID =
    process.env
      .ADMIN_PSID;

  const apiKeys =
    getApiKeysList();

  const currentDateTimePH =
    getPhilippineDateTime();

  /*
   * WEB CHAT
   */
  if (
    req.method ===
      'POST' &&
    req.body
      ?.isWebChat
  ) {
    const {
      message,
      sessionId,
      attachments
    } =
      req.body;

    const sessionKey =
      normalizeWebSessionId(
        sessionId
      );

    if (
      !apiKeys.length
    ) {
      return res
        .status(500)
        .json({
          error:
            'AI service is not configured.'
        });
    }

    const cleanMessage =
      typeof message ===
      'string'
        ? message
            .trim()
            .slice(
              0,
              MAX_WEB_MESSAGE_CHARS
            )
        : '';

    if (
      cleanMessage &&
      [
        '/reset',
        '/refresh',
        'reset'
      ].includes(
        cleanMessage
          .toLowerCase()
      )
    ) {
      if (
        sessionKey
      ) {
        webConversationsMap
          .delete(
            sessionKey
          );
      }

      return res
        .status(200)
        .json({
          reply:
            '✓ Naka-reset na ang memorya. Paano kita maitutulungan ngayon, Boss?'
        });
    }

    const systemInstructionText =
`You are JepongDevxyz AI, a state-of-the-art analytical AI assistant chatting with Boss.

TEMPORAL GROUND TRUTH:
- Exact Philippine Date & Time: ${currentDateTimePH}
- Timezone: Asia/Manila (PHT, UTC+8)
- If asked for current time/date/day/year, use the Philippine time supplied above.

AI IDENTITY:
- Official Name: JepongDevxyz AI
- Creator: Jepong Devxyz (Jay-Ar Lee Espiritu)

WRITING:
- Be accurate, logical and useful.
- Use correct spelling and grammar.
- Automatically match the user's language.
- Never invent live information.`;

    let history =
      sessionKey
        ? (
            webConversationsMap
              .get(
                sessionKey
              ) ||
            []
          )
        : [];

    const userParts = [];

    for (
      const item of
      Array.isArray(
        attachments
      )
        ? attachments.slice(
            0,
            4
          )
        : []
    ) {
      const rawBase64 =
        stripDataUrlPrefix(
          item?.base64
        );

      const mimeType =
        typeof item?.mimeType ===
        'string'
          ? item
              .mimeType
              .trim()
              .toLowerCase()
          : '';

      if (
        !rawBase64 ||
        !mimeType
      ) {
        continue;
      }

      if (
        rawBase64.length >
        Math.ceil(
          (
            MAX_INLINE_BYTES *
            4
          ) /
          3
        ) +
        16
      ) {
        continue;
      }

      userParts.push({
        inline_data: {
          mime_type:
            mimeType,

          data:
            rawBase64
        }
      });
    }

    let finalPrompt =
      cleanMessage ||
      'Kumusta!';

    if (
      /(balita|sino si|kailan|latest|update|presyo|weather|panahon|search|score|oras|petsa)/i
        .test(
          finalPrompt
        )
    ) {
      try {
        const results =
          await performFreeWebSearch(
            finalPrompt
          );

        if (
          results
        ) {
          finalPrompt +=
            `\n\n[Live Real-Time Web Data]:\n${results}`;
        }

      } catch (
        error
      ) {
        console.warn(
          'Web Search Error:',
          error.message
        );
      }
    }

    userParts.push({
      text:
        finalPrompt
    });

    const requestHistory =
      [
        ...history,

        {
          role:
            'user',

          parts:
            userParts
        }
      ].slice(
        -MAX_HISTORY_ITEMS
      );

    try {
      const reply =
        await callGeminiApiWithFallback(
          {
            system_instruction: {
              parts: [
                {
                  text:
                    systemInstructionText
                }
              ]
            },

            contents:
              requestHistory
          },

          apiKeys,

          35000
        );

      history.push({
        role:
          'user',

        parts: [
          {
            text:
              cleanMessage ||
              'Kumusta!'
          }
        ]
      });

      history.push({
        role:
          'model',

        parts: [
          {
            text:
              reply
          }
        ]
      });

      history =
        history.slice(
          -MAX_HISTORY_ITEMS
        );

      setLimitedConversation(
        webConversationsMap,
        sessionKey,
        history
      );

      return res
        .status(200)
        .json({
          reply
        });

    } catch (
      error
    ) {
      console.error(
        'Web Chat Error:',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Medyo busy ang server, paki-ulit.'
        });
    }
  }

  /*
   * FACEBOOK VERIFICATION
   */
  if (
    req.method ===
    'GET'
  ) {
    const mode =
      req.query
        ?.['hub.mode'];

    const token =
      req.query
        ?.['hub.verify_token'];

    const challenge =
      req.query
        ?.['hub.challenge'];

    if (
      VERIFY_TOKEN &&
      mode ===
        'subscribe' &&
      token ===
        VERIFY_TOKEN
    ) {
      return res
        .status(200)
        .send(
          challenge
        );
    }

    return res
      .status(403)
      .send(
        'Forbidden'
      );
  }

  /*
   * FACEBOOK MESSENGER WEBHOOK
   */
  if (
    req.method ===
    'POST'
  ) {
    const body =
      req.body;

    if (
      body?.object !==
      'page'
    ) {
      return res
        .status(404)
        .send(
          'Not Found'
        );
    }

    if (
      !PAGE_ACCESS_TOKEN
    ) {
      console.error(
        'Missing PAGE_ACCESS_TOKEN.'
      );

      return res
        .status(500)
        .send(
          'Messenger is not configured'
        );
    }

    try {
      for (
        const entry of
        body.entry || []
      ) {
        for (
          const webhookEvent of
          entry.messaging || []
        ) {
          const senderPsid =
            webhookEvent
              .sender?.id ||
            null;

          /*
           * ADMIN PSID DEBUG
           */
          console.log(
            '📌 SENDER PSID:',
            senderPsid
          );

          if (
            !senderPsid
          ) {
            continue;
          }

          const messageId =
            webhookEvent
              .message?.mid ||
            null;

          if (
            messageId
          ) {
            if (
              processedMessageIds
                .has(
                  messageId
                )
            ) {
              continue;
            }

            processedMessageIds
              .add(
                messageId
              );

            const cleanupTimer =
              setTimeout(
                () =>
                  processedMessageIds
                    .delete(
                      messageId
                    ),
                300000
              );

            cleanupTimer
              .unref?.();
          }

          /*
           * POSTBACK
           */
          if (
            webhookEvent
              .postback
              ?.payload
          ) {
            await handleCommandAction(
              senderPsid,

              webhookEvent
                .postback
                .payload,

              apiKeys,

              PAGE_ACCESS_TOKEN,

              ADMIN_PSID,

              currentDateTimePH
            );

            continue;
          }

          const incomingMessage =
            webhookEvent
              .message;

          if (
            !incomingMessage ||
            incomingMessage
              .is_echo
          ) {
            continue;
          }

          /*
           * ATTACHMENT
           */
          const attachment =
            incomingMessage
              .attachments?.[0];

          if (
            attachment
              ?.payload?.url
          ) {
            await sendTypingOn(
              senderPsid,
              PAGE_ACCESS_TOKEN
            );

            try {
              if (
                attachment.type ===
                'audio'
              ) {
                const reply =
                  await processAudioMessage(
                    attachment
                      .payload
                      .url,

                    apiKeys
                  );

                await sendLongTextMessage(
                  senderPsid,
                  reply,
                  PAGE_ACCESS_TOKEN
                );

                continue;
              }

              if (
                attachment.type ===
                'image'
              ) {
                const reply =
                  await analyzeHomeworkWithGemini(
                    attachment
                      .payload
                      .url,

                    apiKeys
                  );

                await sendLongTextMessage(
                  senderPsid,
                  reply,
                  PAGE_ACCESS_TOKEN
                );

                continue;
              }

              if (
                attachment.type ===
                'file'
              ) {
                const reply =
                  await processDocumentFile(
                    attachment
                      .payload
                      .url,

                    apiKeys
                  );

                await sendLongTextMessage(
                  senderPsid,
                  reply,
                  PAGE_ACCESS_TOKEN
                );

                continue;
              }

            } finally {
              await sendTypingOff(
                senderPsid,
                PAGE_ACCESS_TOKEN
              );
            }
          }

          const userMessage =
            incomingMessage
              .text
              ?.trim() ||
            '';

          const quickReplyPayload =
            incomingMessage
              .quick_reply
              ?.payload ||
            null;

          const finalMessage =
            quickReplyPayload ||
            userMessage;

          if (
            !finalMessage
          ) {
            continue;
          }

          /*
           * PERIODIC TABLE
           */
          if (
            finalMessage
              .toLowerCase()
              .includes(
                'periodic table'
              )
          ) {
            await sendTextMessage(
              senderPsid,

              '🧪 Periodic Table of Elements (HD)',

              PAGE_ACCESS_TOKEN
            );

            await sendMediaAttachment(
              senderPsid,

              'image',

              'https://upload.wikimedia.org/wikipedia/commons/b/b3/Simple_Periodic_Table_Chart-en.svg',

              PAGE_ACCESS_TOKEN
            );

            continue;
          }

          /*
           * COMMANDS
           */
          const handled =
            await handleCommandAction(
              senderPsid,

              finalMessage,

              apiKeys,

              PAGE_ACCESS_TOKEN,

              ADMIN_PSID,

              currentDateTimePH
            );

          if (
            handled
          ) {
            continue;
          }

          await sendTypingOn(
            senderPsid,
            PAGE_ACCESS_TOKEN
          );

          /*
           * URL CONTEXT
           */
          if (
            /https?:\/\/[^\s]+/i
              .test(
                finalMessage
              )
          ) {
            try {
              const reply =
                await fetchAndSummarizeUrl(
                  finalMessage,
                  apiKeys
                );

              await sendLongTextMessage(
                senderPsid,
                reply,
                PAGE_ACCESS_TOKEN
              );

            } finally {
              await sendTypingOff(
                senderPsid,
                PAGE_ACCESS_TOKEN
              );
            }

            continue;
          }

          await processDirectAI(
            senderPsid,

            finalMessage,

            apiKeys,

            PAGE_ACCESS_TOKEN,

            currentDateTimePH
          );
        }
      }

    } catch (
      error
    ) {
      console.error(
        'Processing Error:',
        error
      );
    }

    return res
      .status(200)
      .send(
        'EVENT_RECEIVED'
      );
  }

  return res
    .status(405)
    .send(
      'Method Not Allowed'
    );
}

/* =========================================================
   GEMINI FALLBACK ENGINE
========================================================= */

async function callGeminiApiWithFallback(
  payload,
  apiKeys,
  maxTotalTimeoutMs = 30000
) {
  if (
    !Array.isArray(
      apiKeys
    ) ||
    !apiKeys.length
  ) {
    throw new Error(
      'Walang Gemini API Key.'
    );
  }

  const requestBody =
    JSON.parse(
      JSON.stringify(
        payload
      )
    );

  /*
   * Gemini 3.x thinking.
   * LOW = mas mabilis para sa Messenger.
   */
  requestBody.generationConfig = {
    ...(
      requestBody
        .generationConfig ||
      {}
    ),

    thinkingConfig: {
      ...(
        requestBody
          .generationConfig
          ?.thinkingConfig ||
        {}
      ),

      thinkingLevel:
        'low'
    }
  };

  const totalTimeoutMs =
    Math.max(
      Number(
        maxTotalTimeoutMs
      ) || 0,

      15000
    );

  const startTime =
    Date.now();

  let lastError =
    null;

  const firstKeyIndex =
    currentKeyIndex %
    apiKeys.length;

  currentKeyIndex =
    (
      currentKeyIndex +
      1
    ) %
    apiKeys.length;

  const attempts = [];

  /*
   * Subukan lahat ng models
   * gamit lahat ng API keys.
   */
  for (
    const modelName of
    GEMINI_MODELS_FALLBACK
  ) {
    for (
      let offset = 0;
      offset <
      apiKeys.length;
      offset++
    ) {
      attempts.push({
        modelName,

        apiKey:
          apiKeys[
            (
              firstKeyIndex +
              offset
            ) %
            apiKeys.length
          ]
      });
    }
  }

  for (
    let attempt = 0;
    attempt <
    attempts.length;
    attempt++
  ) {
    const elapsed =
      Date.now() -
      startTime;

    const remaining =
      totalTimeoutMs -
      elapsed;

    if (
      remaining <
      1200
    ) {
      break;
    }

    const {
      modelName,
      apiKey
    } =
      attempts[
        attempt
      ];

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    const controller =
      new AbortController();

    /*
     * Dating 8 seconds.
     * Ginawang hanggang 18 seconds
     * para sa mahahabang sagot.
     */
    const requestTimeout =
      Math.min(
        18000,

        Math.max(
          3000,

          remaining -
          750
        )
      );

    const timer =
      setTimeout(
        () =>
          controller.abort(),

        requestTimeout
      );

    try {
      console.log(
        `🤖 Gemini ${attempt + 1}/${attempts.length} | Model: ${modelName} | Timeout: ${requestTimeout}ms`
      );

      const response =
        await fetch(
          endpoint,
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json',

              'x-goog-api-key':
                apiKey
            },

            body:
              JSON.stringify(
                requestBody
              ),

            signal:
              controller.signal
          }
        );

      let data =
        null;

      try {
        data =
          await response.json();

      } catch (_) {}

      const text =
        extractGeminiText(
          data
        );

      if (
        response.ok &&
        text
      ) {
        console.log(
          `✅ Gemini Success | Model: ${modelName}`
        );

        return text;
      }

      const errorMessage =
        data?.error?.message ||
        `API Status ${response.status}`;

      lastError =
        new Error(
          errorMessage
        );

      console.warn(
        `[Gemini Attempt ${attempt + 1}/${attempts.length}] Model: ${modelName} | Status: ${response.status} | ${errorMessage}`
      );

      if (
        response.status ===
          429 ||
        response.status >=
          500
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              300
            )
        );
      }

    } catch (
      error
    ) {
      lastError =
        error;

      if (
        error?.name ===
        'AbortError'
      ) {
        console.warn(
          `⏱️ Gemini timeout | Model: ${modelName} | ${requestTimeout}ms`
        );

      } else {
        console.error(
          `[Gemini Fetch Attempt ${attempt + 1}/${attempts.length}] Model: ${modelName} | ${error.message}`
        );
      }

    } finally {
      clearTimeout(
        timer
      );
    }
  }

  throw (
    lastError ||
    new Error(
      'Unavailable ang lahat ng Gemini API keys/models.'
    )
  );
}

/* =========================================================
   COMMAND HANDLER
========================================================= */

async function handleCommandAction(
  senderPsid,
  input,
  apiKeys,
  pageToken,
  adminPsid,
  currentDateTimePH
) {
  const lowerText =
    input
      .toLowerCase()
      .trim();

  /*
   * ADMIN
   */
  if (
    [
      '/stats',
      '/admin'
    ].includes(
      lowerText
    )
  ) {
    if (
      !adminPsid ||
      senderPsid !==
        adminPsid
    ) {
      await sendTextMessage(
        senderPsid,

        '🚫 Access Denied!',

        pageToken
      );

      return true;
    }

    await sendTextMessage(
      senderPsid,

      `📊 AI Status\n\n` +
      `• Active Keys: ${apiKeys.length}\n` +
      `• Current Key Index: ${currentKeyIndex}\n` +
      `• Philippine Time: ${currentDateTimePH}\n` +
      `• Status: Operational 🟢`,

      pageToken
    );

    return true;
  }

  /*
   * SEARCH
   */
  if (
    lowerText
      .startsWith(
        '/search '
      )
  ) {
    await sendTypingOn(
      senderPsid,
      pageToken
    );

    try {
      const query =
        input
          .replace(
            /^\/search\s*/i,
            ''
          )
          .trim();

      const results =
        await performFreeWebSearch(
          query
        );

      const reply =
        await getDirectGeminiResponse(
          `Philippine time: ${currentDateTimePH}\n\n` +
          `Search Data:\n${results || 'Walang nahanap.'}\n\n` +
          `Question:\n${query}`,

          apiKeys
        );

      await sendLongTextMessage(
        senderPsid,

        `🌐 Web Search Result:\n\n${reply}`,

        pageToken
      );

    } finally {
      await sendTypingOff(
        senderPsid,
        pageToken
      );
    }

    return true;
  }

  /*
   * IMAGE GENERATION
   */
  if (
    lowerText
      .startsWith(
        '/imagen '
      )
  ) {
    const prompt =
      input
        .replace(
          /^\/imagen\s*/i,
          ''
        )
        .trim();

    if (
      prompt
    ) {
      await generateAndSendImage(
        senderPsid,
        prompt,
        pageToken
      );
    }

    return true;
  }

  /*
   * MATH
   */
  if (
    lowerText
      .startsWith(
        '/math '
      )
  ) {
    await sendTypingOn(
      senderPsid,
      pageToken
    );

    try {
      const problem =
        input
          .replace(
            /^\/math\s*/i,
            ''
          )
          .trim();

      const reply =
        await getDirectGeminiResponse(
          `Solve this step-by-step: ${problem}`,

          apiKeys
        );

      await sendLongTextMessage(
        senderPsid,

        `🧮 Math Solution:\n\n${reply}`,

        pageToken
      );

    } finally {
      await sendTypingOff(
        senderPsid,
        pageToken
      );
    }

    return true;
  }

  /*
   * CODE
   */
  if (
    lowerText
      .startsWith(
        '/code '
      )
  ) {
    await sendTypingOn(
      senderPsid,
      pageToken
    );

    try {
      const task =
        input
          .replace(
            /^\/code\s*/i,
            ''
          )
          .trim();

      const reply =
        await getDirectGeminiResponse(
          `Provide clean and functional code for: ${task}`,

          apiKeys
        );

      await sendLongTextMessage(
        senderPsid,

        `💻 Code Solution:\n\n${reply}`,

        pageToken
      );

    } finally {
      await sendTypingOff(
        senderPsid,
        pageToken
      );
    }

    return true;
  }

  /*
   * HELP
   */
  if (
    [
      '/commands',
      '/help'
    ].includes(
      lowerText
    )
  ) {
    await sendTextMessage(
      senderPsid,

      '📚 JepongDevxyz AI Commands\n\n' +
      '🔍 /search [topic]\n' +
      '🎨 /imagen [prompt]\n' +
      '🧮 /math [problem]\n' +
      '💻 /code [task]\n' +
      '🔄 /reset\n' +
      '📊 /stats (Admin only)',

      pageToken
    );

    return true;
  }

  return false;
}

/* =========================================================
   AUDIO
========================================================= */

async function processAudioMessage(
  audioUrl,
  apiKeys
) {
  try {
    const {
      data,
      mimeType
    } =
      await fetchBinaryAsBase64(
        audioUrl,
        'audio/mpeg'
      );

    const normalizedMime =
      mimeType
        .startsWith(
          'audio/'
        )
        ? mimeType
        : 'audio/mpeg';

    return await callGeminiApiWithFallback(
      {
        contents: [
          {
            parts: [
              {
                text:
                  'Transcribe this audio first, then answer naturally and accurately.'
              },

              {
                inline_data: {
                  mime_type:
                    normalizedMime,

                  data
                }
              }
            ]
          }
        ]
      },

      apiKeys,

      25000
    );

  } catch (
    error
  ) {
    console.error(
      'Audio Error:',
      error.message
    );

    return (
      '× Error sa pagproseso ng boses.'
    );
  }
}

/* =========================================================
   DOCUMENT
========================================================= */

async function processDocumentFile(
  fileUrl,
  apiKeys
) {
  try {
    const {
      data,
      mimeType
    } =
      await fetchBinaryAsBase64(
        fileUrl,
        'application/pdf'
      );

    const supported =
      mimeType ===
        'application/pdf' ||
      mimeType
        .startsWith(
          'text/'
        ) ||
      mimeType ===
        'application/json';

    if (
      !supported
    ) {
      return (
        `× Unsupported file type: ${mimeType}`
      );
    }

    return await callGeminiApiWithFallback(
      {
        contents: [
          {
            parts: [
              {
                text:
                  'Analyze and summarize this document clearly and accurately.'
              },

              {
                inline_data: {
                  mime_type:
                    mimeType,

                  data
                }
              }
            ]
          }
        ]
      },

      apiKeys,

      30000
    );

  } catch (
    error
  ) {
    console.error(
      'Document Error:',
      error.message
    );

    return (
      '× Error sa pagbasa ng file.'
    );
  }
}

/* =========================================================
   URL CONTEXT
========================================================= */

async function fetchAndSummarizeUrl(
  textWithUrl,
  apiKeys
) {
  try {
    const urls =
      extractUrls(
        textWithUrl
      );

    if (
      !urls.length
    ) {
      return (
        '× Walang valid URL na nakita.'
      );
    }

    return await callGeminiApiWithFallback(
      {
        contents: [
          {
            parts: [
              {
                text:
`Analyze the public URLs below using URL Context.

User Message:
${textWithUrl}

URLs:
${urls.join('\n')}

Give an accurate summary and answer the user's question.`
              }
            ]
          }
        ],

        tools: [
          {
            url_context: {}
          }
        ]
      },

      apiKeys,

      30000
    );

  } catch (
    error
  ) {
    console.error(
      'URL Context Error:',
      error.message
    );

    return (
      '× Hindi nabasa ang link.'
    );
  }
}

/* =========================================================
   IMAGE GENERATION
========================================================= */

async function generateAndSendImage(
  senderPsid,
  prompt,
  pageToken
) {
  await sendTextMessage(
    senderPsid,

    '🖼️ Ginagawa ang larawan...',

    pageToken
  );

  const seed =
    Math.floor(
      Math.random() *
      1000000
    );

  const imageUrl =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(
      prompt
    )}/image.jpg?width=1024&height=1024&nologo=true&seed=${seed}`;

  try {
    await sendMediaAttachment(
      senderPsid,
      'image',
      imageUrl,
      pageToken
    );

  } catch (_) {
    await sendTextMessage(
      senderPsid,

      '❌ Error loading image.',

      pageToken
    );
  }
}

/* =========================================================
   DIRECT GEMINI
========================================================= */

async function getDirectGeminiResponse(
  promptText,
  apiKeys
) {
  try {
    return await callGeminiApiWithFallback(
      {
        contents: [
          {
            parts: [
              {
                text:
                  `${promptText}\n\nUse correct facts, spelling and grammar.`
              }
            ]
          }
        ]
      },

      apiKeys,

      25000
    );

  } catch (
    error
  ) {
    console.error(
      'Direct Gemini Error:',
      error.message
    );

    return (
      'Pasensya na, may kaunting delay.'
    );
  }
}

/* =========================================================
   IMAGE ANALYSIS
========================================================= */

async function analyzeHomeworkWithGemini(
  imageUrl,
  apiKeys
) {
  try {
    const {
      data,
      mimeType
    } =
      await fetchBinaryAsBase64(
        imageUrl,
        'image/jpeg'
      );

    const normalizedMime =
      mimeType
        .startsWith(
          'image/'
        )
        ? mimeType
        : 'image/jpeg';

    return await callGeminiApiWithFallback(
      {
        contents: [
          {
            parts: [
              {
                text:
                  'Analyze this image carefully. If it contains homework, explain the answer step-by-step.'
              },

              {
                inline_data: {
                  mime_type:
                    normalizedMime,

                  data
                }
              }
            ]
          }
        ]
      },

      apiKeys,

      25000
    );

  } catch (
    error
  ) {
    console.error(
      'Image Analysis Error:',
      error.message
    );

    return (
      'Error sa pag-analyze ng larawan.'
    );
  }
}

/* =========================================================
   MAIN MESSENGER AI
========================================================= */

async function processDirectAI(
  senderPsid,
  userMessage,
  apiKeys,
  pageToken,
  currentDateTimePH
) {
  try {
    const firstName =
      'Boss';

    const lowerMsg =
      userMessage
        .toLowerCase();

    if (
      [
        '/reset',
        '/refresh',
        '/normal',
        'ibalik sa dati',
        'normal mode'
      ].some(
        cmd =>
          lowerMsg.includes(
            cmd
          )
      )
    ) {
      userPersonasMap
        .delete(
          senderPsid
        );

      userConversationsMap
        .delete(
          senderPsid
        );

      await sendTextMessage(
        senderPsid,

        `✓ Naka-reset na ang mode at memory. Normal mode na ulit, ${firstName}!`,

        pageToken
      );

      await sendTypingOff(
        senderPsid,
        pageToken
      );

      return;
    }

    let currentPersona =
      userPersonasMap
        .get(
          senderPsid
        ) ||
      null;

    const isPersonaTrigger =
      /umakting ka|maging|gayahin mo|ikaw si|pretend/i
        .test(
          userMessage
        );

    if (
      isPersonaTrigger &&
      !currentPersona
    ) {
      currentPersona =
        userMessage;

      userPersonasMap
        .set(
          senderPsid,
          currentPersona
        );
    }

    let history =
      userConversationsMap
        .get(
          senderPsid
        ) ||
      [];

    let messageToSend =
      userMessage;

    const isSearchQuery =
      /kailan|sino si|ano ang balita|latest|updates|search|presyo|petsa|panahon|weather|score|sino ang|ano ang nangyari|balita ngayon/i
        .test(
          userMessage
        );

    if (
      isSearchQuery
    ) {
      try {
        const searchData =
          await performFreeWebSearch(
            userMessage
          );

        if (
          searchData
        ) {
          messageToSend =
            `${userMessage}\n\n[Live Real-Time Web Data]:\n${searchData}`;
        }

      } catch (
        error
      ) {
        console.warn(
          'Search Error:',
          error.message
        );
      }
    }

    history.push({
      role:
        'user',

      parts: [
        {
          text:
            messageToSend
        }
      ]
    });

    history =
      history.slice(
        -MAX_HISTORY_ITEMS
      );

    let systemInstructionText =
`You are JepongDevxyz AI chatting with ${firstName} on Facebook Messenger.

CURRENT PHILIPPINE DATE & TIME:
${currentDateTimePH}

IDENTITY:
- Your official name is JepongDevxyz AI.
- Your creator is Jepong Devxyz (Jay-Ar Lee Espiritu).

RULES:
- Match the user's language naturally.
- Use correct spelling and grammar.
- Give accurate and useful answers.
- Use supplied Live Real-Time Web Data when available.
- Never invent live/current facts.`;

    if (
      currentPersona
    ) {
      systemInstructionText +=
        `\nCurrent requested persona: "${currentPersona}"`;
    }

    const aiReply =
      await callGeminiApiWithFallback(
        {
          system_instruction: {
            parts: [
              {
                text:
                  systemInstructionText
              }
            ]
          },

          contents:
            history
        },

        apiKeys,

        30000
      );

    /*
     * Itago sa memory ang original user text,
     * hindi yung injected web data.
     */
    history[
      history.length -
      1
    ] = {
      role:
        'user',

      parts: [
        {
          text:
            userMessage
        }
      ]
    };

    history.push({
      role:
        'model',

      parts: [
        {
          text:
            aiReply
        }
      ]
    });

    history =
      history.slice(
        -MAX_HISTORY_ITEMS
      );

    setLimitedConversation(
      userConversationsMap,
      senderPsid,
      history
    );

    const formattedReply =
      `.ᐟ ${firstName} : ' ${userMessage} '\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${aiReply}`;

    await sendLongTextMessage(
      senderPsid,

      formattedReply,

      pageToken
    );

    await sendTypingOff(
      senderPsid,
      pageToken
    );

  } catch (
    error
  ) {
    console.error(
      'AI Processing Error:',
      error
    );

    await sendTextMessage(
      senderPsid,

      'Medyo busy ang server, paki-ulit sandali.',

      pageToken
    );

    await sendTypingOff(
      senderPsid,
      pageToken
    );
  }
}

/* =========================================================
   META MESSENGER SEND API
========================================================= */

async function callMessengerSendApi(
  payload,
  pageToken
) {
  if (
    !pageToken
  ) {
    throw new Error(
      'Missing PAGE_ACCESS_TOKEN.'
    );
  }

  const response =
    await fetch(
      `https://graph.facebook.com/${FB_GRAPH_VERSION}/me/messages`,
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/json',

          Authorization:
            `Bearer ${pageToken}`
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  let data =
    null;

  try {
    data =
      await response.json();

  } catch (_) {}

  if (
    !response.ok
  ) {
    throw new Error(
      data?.error?.message ||
      `Meta HTTP ${response.status}`
    );
  }

  return data;
}

/* =========================================================
   TYPING
========================================================= */

async function sendTypingOn(
  senderPsid,
  pageToken
) {
  try {
    await callMessengerSendApi(
      {
        recipient: {
          id:
            senderPsid
        },

        sender_action:
          'typing_on'
      },

      pageToken
    );

  } catch (
    error
  ) {
    console.error(
      'Typing On Error:',
      error.message
    );
  }
}

async function sendTypingOff(
  senderPsid,
  pageToken
) {
  try {
    await callMessengerSendApi(
      {
        recipient: {
          id:
            senderPsid
        },

        sender_action:
          'typing_off'
      },

      pageToken
    );

  } catch (
    error
  ) {
    console.error(
      'Typing Off Error:',
      error.message
    );
  }
}

/* =========================================================
   SEND MEDIA
========================================================= */

async function sendMediaAttachment(
  senderPsid,
  type,
  url,
  pageToken
) {
  try {
    await callMessengerSendApi(
      {
        recipient: {
          id:
            senderPsid
        },

        message: {
          attachment: {
            type,

            payload: {
              url,

              is_reusable:
                true
            }
          }
        }
      },

      pageToken
    );

  } catch (
    error
  ) {
    console.error(
      'Send Media Error:',
      error.message
    );
  }
}

/* =========================================================
   MESSENGER TEXT CLEANUP
========================================================= */

function cleanMessengerFormatting(
  text
) {
  return String(
    text ?? ''
  )
    .replace(
      /\r\n/g,
      '\n'
    )
    .replace(
      /^\s{0,3}#{1,6}\s+/gm,
      ''
    )
    .replace(
      /^\s*[*_-]{3,}\s*$/gm,
      '━━━━━━━━━━━━━━━━━━'
    )
    .replace(
      /\*\*(.*?)\*\*/g,
      '$1'
    )
    .replace(
      /__(.*?)__/g,
      '$1'
    )
    .replace(
      /\n{3,}/g,
      '\n\n'
    )
    .trim();
}

/* =========================================================
   LONG MESSAGE SPLITTER
========================================================= */

function splitLongMessage(
  text,
  maxLength =
    MESSENGER_CHUNK_SIZE
) {
  const source =
    String(
      text ?? ''
    )
      .trim();

  if (
    !source
  ) {
    return [];
  }

  if (
    source.length <=
    maxLength
  ) {
    return [
      source
    ];
  }

  const chunks = [];

  let remaining =
    source;

  while (
    remaining.length >
    maxLength
  ) {
    /*
     * Unahin:
     * 1. paragraph
     * 2. newline
     * 3. sentence
     * 4. word
     */
    let cut =
      remaining
        .lastIndexOf(
          '\n\n',
          maxLength
        );

    if (
      cut <
      Math.floor(
        maxLength *
        0.5
      )
    ) {
      cut =
        remaining
          .lastIndexOf(
            '\n',
            maxLength
          );
    }

    if (
      cut <
      Math.floor(
        maxLength *
        0.5
      )
    ) {
      cut =
        remaining
          .lastIndexOf(
            '. ',
            maxLength
          );

      if (
        cut > 0
      ) {
        cut += 1;
      }
    }

    if (
      cut <
      Math.floor(
        maxLength *
        0.5
      )
    ) {
      cut =
        remaining
          .lastIndexOf(
            ' ',
            maxLength
          );
    }

    if (
      cut <= 0
    ) {
      cut =
        maxLength;
    }

    const chunk =
      remaining
        .slice(
          0,
          cut
        )
        .trim();

    if (
      chunk
    ) {
      chunks.push(
        chunk
      );
    }

    remaining =
      remaining
        .slice(
          cut
        )
        .trim();
  }

  if (
    remaining
  ) {
    chunks.push(
      remaining
    );
  }

  return chunks;
}

/* =========================================================
   SEND LONG TEXT
========================================================= */

async function sendLongTextMessage(
  senderPsid,
  responseText,
  pageToken
) {
  const cleanText =
    cleanMessengerFormatting(
      responseText
    );

  if (
    !cleanText
  ) {
    return;
  }

  const chunks =
    splitLongMessage(
      cleanText,
      MESSENGER_CHUNK_SIZE
    );

  const totalParts =
    chunks.length;

  for (
    let index = 0;
    index <
    totalParts;
    index++
  ) {
    const prefix =
      totalParts > 1
        ? `📄 Part ${index + 1}/${totalParts}\n\n`
        : '';

    await sendTextMessage(
      senderPsid,

      prefix +
      chunks[index],

      pageToken
    );

    /*
     * Small delay para maayos
     * ang order ng bubbles.
     */
    if (
      index <
      totalParts -
      1
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            250
          )
      );
    }
  }
}

/* =========================================================
   SEND TEXT
========================================================= */

async function sendTextMessage(
  senderPsid,
  responseText,
  pageToken
) {
  try {
    await callMessengerSendApi(
      {
        recipient: {
          id:
            senderPsid
        },

        message: {
          text:
            String(
              responseText ??
              ''
            )
        }
      },

      pageToken
    );

  } catch (
    error
  ) {
    console.error(
      'Send Text Error:',
      error.message
    );
  }
}
