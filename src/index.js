export default {
  async fetch(request, env) {
    if (request.method === 'POST') {
      return await handleTelegramWebhook(request, env);
    }
    
    // Endpoint untuk debugging dan management
    const url = new URL(request.url);
    if (url.pathname === '/debug' && request.method === 'GET') {
      return await handleDebug(request, env);
    }
    
    if (url.pathname === '/clear' && request.method === 'POST') {
      return await handleClearAll(request, env);
    }
    
    return new Response('Telegram AI Bot Worker with KV is running!');
  }
};

async function handleTelegramWebhook(request, env) {
  try {
    const update = await request.json();
    
    // Verifikasi secret
    const secret = request.headers.get('x-telegram-bot-api-secret-token');
    if (secret !== env.WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (update.message) {
      await handleMessage(update.message, env);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
    }

    return new Response('OK');
  } catch (error) {
    console.error('Error:', error);
    return new Response('Error processing request', { status: 500 });
  }
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text || '';
  const userId = message.from.id;

  console.log(`Processing message from user ${userId} in chat ${chatId}: ${text}`);

  // Handle commands
  if (text.startsWith('/')) {
    await handleCommand(message, env);
    return;
  }

  // Generate AI response dengan context history
  const aiResponse = await generateAIResponseWithHistory(userId, chatId, text, env);
  
  // Kirim response ke Telegram
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, aiResponse);
}

async function handleCommand(message, env) {
  const chatId = message.chat.id;
  const text = message.text;
  const userId = message.from.id;

  switch (text) {
    case '/start':
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, 
        '🤖 Halo! Saya adalah AI assistant yang ditenagai oleh Cloudflare AI.\n\n' +
        'Silakan tanyakan apa saja kepada saya! Saya akan mengingat percakapan kita dalam sesi ini.\n\n' +
        'Commands:\n/help - Lihat bantuan\n/clear - Hapus riwayat percakapan\n/history - Lihat riwayat terbaru');
      break;
      
    case '/help':
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        '📚 **Bantuan Bot AI**\n\n' +
        '• Cukup ketik pesan untuk berinteraksi dengan AI\n' +
        '• Saya akan mengingat maksimal 10 pesan terakhir\n' +
        '• Gunakan /clear untuk memulai percakapan baru\n\n' +
        '**Commands:**\n' +
        '/start - Mulai bot\n' +
        '/help - Bantuan ini\n' +
        '/clear - Hapus riwayat\n' +
        '/history - Lihat riwayat');
      break;
      
    case '/clear':
      await clearChatHistory(env, userId, chatId);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        '🗑️ Riwayat percakapan telah dihapus! Mari mulai percakapan baru.');
      break;
      
    case '/history':
      await showChatHistory(env, userId, chatId);
      break;
      
    default:
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        '❌ Perintah tidak dikenali. Ketik /help untuk bantuan.');
  }
}

async function generateAIResponseWithHistory(userId, chatId, userMessage, env) {
  try {
    // Ambil riwayat percakapan dari KV
    const history = await getChatHistory(env, userId, chatId);
    
    // Tambah pesan user ke riwayat
    await addToChatHistory(env, userId, chatId, 'user', userMessage);
    
    // Siapkan messages untuk AI
    const messages = [
      {
        role: "system",
        content: `Anda adalah asisten AI yang membantu dan ramah. Berikan respons dalam bahasa Indonesia yang natural dan mudah dimengerti. 
        Tanggapi percakapan dengan konteks yang diberikan. Jika tidak ada konteks relevan, jawab secara umum.`
      },
      ...history,
      {
        role: "user", 
        content: userMessage
      }
    ];

    console.log('Sending to AI with messages:', messages.length);
    
    // Pilih model AI (bisa diganti dengan model lain)
    const response = await env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
      messages
    });

    const aiResponse = response.response || 'Maaf, saya tidak bisa menghasilkan respons saat ini.';
    
    // Simpan response AI ke riwayat
    await addToChatHistory(env, userId, chatId, 'assistant', aiResponse);
    
    return aiResponse;
    
  } catch (error) {
    console.error('AI Error:', error);
    return 'Maaf, terjadi kesalahan dalam memproses permintaan Anda. Silakan coba lagi.';
  }
}

// ==================== KV STORAGE FUNCTIONS ====================

async function getChatHistory(env, userId, chatId) {
  const key = `history:${userId}:${chatId}`;
  
  try {
    const history = await env.TELEGRAM_KV.get(key, 'json');
    return history || [];
  } catch (error) {
    console.error('Error getting chat history:', error);
    return [];
  }
}

async function addToChatHistory(env, userId, chatId, role, content) {
  const key = `history:${userId}:${chatId}`;
  const maxHistory = parseInt(env.MAX_HISTORY_LENGTH) || 10;
  
  try {
    // Ambil riwayat saat ini
    let history = await getChatHistory(env, userId, chatId);
    
    // Tambah pesan baru
    history.push({
      role,
      content,
      timestamp: Date.now()
    });
    
    // Batasi panjang riwayat
    if (history.length > maxHistory) {
      history = history.slice(-maxHistory);
    }
    
    // Simpan kembali ke KV
    await env.TELEGRAM_KV.put(key, JSON.stringify(history));
    
    console.log(`History updated for user ${userId}, chat ${chatId}. Total messages: ${history.length}`);
    
  } catch (error) {
    console.error('Error saving to chat history:', error);
  }
}

async function clearChatHistory(env, userId, chatId) {
  const key = `history:${userId}:${chatId}`;
  
  try {
    await env.TELEGRAM_KV.delete(key);
    console.log(`History cleared for user ${userId}, chat ${chatId}`);
  } catch (error) {
    console.error('Error clearing chat history:', error);
  }
}

async function showChatHistory(env, userId, chatId) {
  const history = await getChatHistory(env, userId, chatId);
  const chatIdNum = chatId;
  
  if (history.length === 0) {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatIdNum, 
      '📝 Tidak ada riwayat percakapan yang tersimpan.');
    return;
  }
  
  let historyText = '📝 **Riwayat Percakapan Terbaru:**\n\n';
  
  history.slice(-5).forEach((msg, index) => {
    const role = msg.role === 'user' ? '👤 Anda' : '🤖 AI';
    const content = msg.content.length > 50 ? 
      msg.content.substring(0, 50) + '...' : msg.content;
    
    historyText += `${role}: ${content}\n\n`;
  });
  
  historyText += `Total pesan: ${history.length}`;
  
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatIdNum, historyText);
}

// ==================== UTILITY FUNCTIONS ====================

async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Telegram API error:', errorText);
    }
    
    return response.ok;
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    return false;
  }
}

async function handleCallbackQuery(callbackQuery, env) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, 
    `Callback received: ${data}`);
}

// ==================== DEBUG ENDPOINTS ====================

async function handleDebug(request, env) {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  const chatId = url.searchParams.get('chat_id');
  
  if (!userId || !chatId) {
    return new Response('Missing user_id or chat_id parameters', { status: 400 });
  }
  
  const history = await getChatHistory(env, userId, chatId);
  
  return new Response(JSON.stringify({
    userId,
    chatId,
    historyLength: history.length,
    history
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleClearAll(request, env) {
  try {
    // HATI-HATI: Ini akan menghapus semua data KV
    // Dalam production, sebaiknya tambahkan autentikasi
    const body = await request.json();
    const userId = body.user_id;
    const chatId = body.chat_id;
    
    if (userId && chatId) {
      await clearChatHistory(env, userId, chatId);
      return new Response(JSON.stringify({ 
        success: true, 
        message: `History cleared for user ${userId}, chat ${chatId}` 
      }));
    } else {
      return new Response(JSON.stringify({ 
        success: false, 
        message: 'Missing user_id or chat_id' 
      }), { status: 400 });
    }
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), { status: 500 });
  }
}

// Fungsi untuk setup webhook
async function setWebhook(botToken, webhookUrl, secret) {
  const url = `https://api.telegram.org/bot${botToken}/setWebhook`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret
    })
  });

  return response.json();
}
