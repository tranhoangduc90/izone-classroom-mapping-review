import https from 'node:https';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';

const DEFAULT_ENDPOINT = 'https://ducizone.ddns.net/dispatcher/webhook/phan_phoi_get_chatgpt';
const MAX_HTML_BYTES = 12 * 1024 * 1024;

function validateShareUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Link share không hợp lệ.');
  }

  const allowedHosts = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !allowedHosts.has(url.hostname) || !url.pathname.startsWith('/share/')) {
    throw new Error('Chỉ chấp nhận link HTTPS dạng chatgpt.com/share/...');
  }
  return url.toString();
}

function pickHtml(body) {
  if (typeof body?.data === 'string' && body.data.includes('<!DOCTYPE html')) return body.data;
  if (typeof body?.html === 'string' && body.html.includes('<!DOCTYPE html')) return body.html;
  if (typeof body?.body === 'string' && body.body.includes('<!DOCTYPE html')) return body.body;

  if (Array.isArray(body?.data)) {
    for (const step of body.data) {
      const result = step?.results?.[0];
      if (typeof result?.html === 'string' && result.html.includes('<!DOCTYPE html')) return result.html;
      if (typeof result?.text === 'string' && result.text.includes('<!DOCTYPE html')) return result.text;
    }
  }

  throw new Error('Webhook không trả HTML ChatGPT hợp lệ.');
}

function extractEnqueueArgs(html) {
  const output = [];
  const needle = 'streamController.enqueue("';
  let cursor = 0;

  while (true) {
    const start = html.indexOf(needle, cursor);
    if (start === -1) break;

    let index = start + needle.length;
    let buffer = '';
    let escaped = false;

    while (index < html.length) {
      const char = html[index];
      if (escaped) {
        buffer += char;
        escaped = false;
      } else if (char === '\\') {
        buffer += char;
        escaped = true;
      } else if (char === '"') {
        break;
      } else {
        buffer += char;
      }
      index += 1;
    }

    output.push(buffer);
    cursor = index + 1;
  }

  return output;
}

function pickMainPayload(strings) {
  return strings.find((value) =>
    value.trim().startsWith('[') &&
    value.includes('"mapping"') &&
    (value.includes('"linear_conversation"') || value.includes('"current_node"'))
  ) || strings.find((value) =>
    value.trim().startsWith('[') && value.includes('"mapping"')
  ) || null;
}

function findConversationIndex(payload) {
  const titleIndex = payload.indexOf('title');
  const mappingIndex = payload.indexOf('mapping');
  const currentNodeIndex = payload.indexOf('current_node');
  const linearIndex = payload.indexOf('linear_conversation');

  for (let index = 0; index < payload.length; index += 1) {
    const value = payload[index];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

    const has = (target) => target !== -1 && Object.prototype.hasOwnProperty.call(value, `_${target}`);
    if (has(mappingIndex) && (has(titleIndex) || has(currentNodeIndex) || has(linearIndex))) {
      return index;
    }
  }

  return -1;
}

function decodeDevalue(payload, rootIndex) {
  const memo = new Map();

  function decodeAt(index) {
    if (typeof index !== 'number' || index < 0) return index;
    if (memo.has(index)) return memo.get(index);

    const value = payload[index];
    if (!value || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      const array = [];
      memo.set(index, array);
      for (const entry of value) {
        array.push(typeof entry === 'number' ? decodeAt(entry) : entry);
      }
      return array;
    }

    const object = {};
    memo.set(index, object);
    for (const [encodedKey, encodedValue] of Object.entries(value)) {
      const key = /^_\d+$/.test(encodedKey)
        ? payload[Number.parseInt(encodedKey.slice(1), 10)]
        : encodedKey;
      object[key] = typeof encodedValue === 'number' && encodedValue >= 0
        ? decodeAt(encodedValue)
        : encodedValue;
    }
    return object;
  }

  return decodeAt(rootIndex);
}

function messageText(message) {
  const content = message?.content || {};
  if (content.content_type === 'text' && Array.isArray(content.parts)) {
    return content.parts.join('\n');
  }
  return JSON.stringify(content);
}

function isVisibleMessage(message) {
  if (!message || !['user', 'assistant'].includes(message?.author?.role)) return false;
  if (message?.metadata?.is_visually_hidden_from_conversation) return false;
  if (message?.content?.content_type === 'model_editable_context') return false;
  return messageText(message).trim().length > 0;
}

function buildOrderedMessages(conversation) {
  const mapping = conversation?.mapping || {};
  const seen = new Set();

  function push(nodeId, target) {
    if (!nodeId || seen.has(nodeId)) return;
    const message = mapping[nodeId]?.message;
    if (!isVisibleMessage(message)) return;
    seen.add(nodeId);
    target.push({
      id: message.id,
      node_id: nodeId,
      role: message.author.role,
      create_time: message.create_time ?? null,
      update_time: message.update_time ?? null,
      text: messageText(message),
    });
  }

  const linearMessages = [];
  const linear = Array.isArray(conversation?.linear_conversation)
    ? conversation.linear_conversation
    : [];

  for (const value of linear) {
    if (typeof value === 'string') {
      push(value, linearMessages);
    } else if (value && typeof value === 'object') {
      push(value.id || value.message_id || value.node_id, linearMessages);
    }
  }
  if (linearMessages.length) {
    return { orderedBy: 'linear_conversation', messages: linearMessages };
  }

  const chainIds = [];
  let current = conversation?.current_node;
  while (current && typeof current === 'string' && mapping[current] && !chainIds.includes(current)) {
    chainIds.push(current);
    current = mapping[current]?.parent || null;
  }

  const chainMessages = [];
  chainIds.reverse().forEach((nodeId) => push(nodeId, chainMessages));
  if (chainMessages.length) {
    return { orderedBy: 'current_node_parent_chain', messages: chainMessages };
  }

  const sortedMessages = Object.entries(mapping)
    .map(([nodeId, node]) => {
      const message = node?.message;
      if (!isVisibleMessage(message)) return null;
      return {
        id: message.id,
        node_id: nodeId,
        role: message.author.role,
        create_time: message.create_time ?? null,
        update_time: message.update_time ?? null,
        text: messageText(message),
      };
    })
    .filter(Boolean)
    .sort((left, right) => (left.create_time ?? 0) - (right.create_time ?? 0));

  return { orderedBy: 'create_time_fallback', messages: sortedMessages };
}

// Nhận Share công khai; đọc HTTPS với header tối đa 64 KiB, thân tối đa 12 MiB.
// Redirect vẫn phải là Share hợp lệ; deadline chung chặn treo/nhỏ giọt dữ liệu.
// Trả HTML đầy đủ cho parser; lỗi mạng/trang thiếu dữ liệu không thành bài chưa đạt.
async function fetchDirectHtml(shareUrl, deadline, redirects = 0) {
  validateShareUrl(shareUrl);
  if (redirects > 4 || Date.now() >= deadline) throw new Error('SHARE_READ_LIMIT');
  return new Promise((resolve, reject) => {
    const request = https.get(shareUrl, {
      maxHeaderSize: 64 * 1024,
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36',
      },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        try {
          const next = new URL(response.headers.location, shareUrl).toString();
          validateShareUrl(next);
          resolve(fetchDirectHtml(next, deadline, redirects + 1));
        } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`ChatGPT trả HTTP ${response.statusCode}.`));
        return;
      }
      const decoder = { gzip: createGunzip, br: createBrotliDecompress, deflate: createInflate }[response.headers['content-encoding']];
      const body = decoder ? response.pipe(decoder()) : response;
      let length = 0;
      const chunks = [];
      response.on('error', reject);
      body.on('error', reject);
      body.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_HTML_BYTES) {
          const error = new Error('SHARE_HTML_TOO_LARGE');
          body.destroy(error); request.destroy(error); reject(error);
        } else chunks.push(chunk);
      });
      body.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        if (!/^\s*<!doctype html/i.test(html)) reject(new Error('ChatGPT không trả HTML hợp lệ.'));
        else resolve(html);
      });
    });
    request.on('error', reject);
  });
}

async function fetchViaN8n(shareUrl) {
  const endpoint = process.env.CODEX_CHATGPT_SHARE_ENDPOINT || DEFAULT_ENDPOINT;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ result: shareUrl }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Webhook trả HTTP ${response.status}.`);
  }

  const responseBody = await response.json();
  return pickHtml(responseBody);
}

function parseConversationHtml(html, source) {
  // Share hiện có cả React Router stream và Octane transcript JSON.
  // Chỉ lấy text/markdown gốc theo thứ tự rows; không lấy HTML đã render hay mẫu UI.
  const octane = html.match(/<script\b[^>]*\bid=["']octane-conversation-transcript["'][^>]*>([\s\S]*?)<\/script>/i);
  if (octane) {
    const transcript = JSON.parse(octane[1]);
    if (!Array.isArray(transcript.rows)) throw new Error('OCTANE_TRANSCRIPT_INVALID');
    const messages = [];
    for (const row of transcript.rows) {
      const role = row?.frame?.role;
      if (!['user', 'assistant'].includes(role)) continue;
      // DIL cung cấp bản văn bản đầy đủ riêng; không thực thi code hay lấy constants/UI.
      const text = role === 'user' ? row.frame.text
        : row.source?.markdown?.trim() ? row.source.markdown : row.source?.dil?.fallbackMarkdown;
      const id = row.frame.id || row.source?.messageId;
      if (typeof id !== 'string' || !id || typeof text !== 'string' || !text.trim()) throw new Error('OCTANE_MESSAGE_INVALID');
      messages.push({ id, node_id: row.key || id, role, create_time: null, update_time: null, text });
    }
    if (!messages.length || new Set(messages.map(m => m.id)).size !== messages.length) throw new Error('OCTANE_TRANSCRIPT_INVALID');
    return { source, conversationTitle: html.match(/<title>([^<]*)<\/title>/i)?.[1] || '',
      create_time: null, update_time: null, current_node: messages.at(-1).node_id,
      ordered_by: 'octane_transcript_rows', messages_count: messages.length, messages };
  }
  const rawStrings = extractEnqueueArgs(html);
  if (!rawStrings.length) throw new Error('Trang share không chứa streamController.enqueue(...).');

  const decodedStrings = rawStrings.map((value) => JSON.parse(`"${value}"`));
  const payloadText = pickMainPayload(decodedStrings);
  if (!payloadText) throw new Error('Không tìm thấy payload hội thoại trong trang share.');

  const payload = JSON.parse(payloadText);
  const conversationIndex = findConversationIndex(payload);
  if (conversationIndex === -1) throw new Error('Không tìm thấy conversation object.');

  const conversation = decodeDevalue(payload, conversationIndex);
  const ordered = buildOrderedMessages(conversation);
  if (!ordered.messages.length) throw new Error('Trang Share chưa chứa lời thoại.');
  return {
    source,
    conversationTitle: conversation?.title ?? '',
    create_time: conversation?.create_time ?? null,
    update_time: conversation?.update_time ?? null,
    current_node: conversation?.current_node ?? null,
    ordered_by: ordered.orderedBy,
    messages_count: ordered.messages.length,
    messages: ordered.messages,
  };
}

// Dữ liệu vào: URL ChatGPT Share công khai đã được API chuẩn hóa.
// Việc chính: đọc hội thoại trực tiếp; nếu trang Share tạm lỗi thì thử webhook đọc hiện hành.
// Kết quả: các lượt user/assistant theo đúng thứ tự; lỗi được ném cho hàng việc thử lại.
export async function readSpeakingShare(shareUrl, n8nOnly = false) {
  validateShareUrl(shareUrl);
  if (!n8nOnly) {
    let directError;
    const deadline = Date.now() + 30_000;
    for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
      try {
        const html = await fetchDirectHtml(shareUrl, Math.min(deadline, Date.now() + 15_000));
        return parseConversationHtml(html, 'direct');
      } catch (error) { directError = error; }
    }
    try {
      const html = await fetchViaN8n(shareUrl);
      return parseConversationHtml(html, 'n8n_fallback');
    } catch (n8nError) {
      throw new Error(`Đọc trực tiếp lỗi: ${directError?.message || 'SHARE_READ_LIMIT'} n8n fallback lỗi: ${n8nError.message}`);
    }
  }

  const html = await fetchViaN8n(shareUrl);
  return parseConversationHtml(html, 'n8n_only');
}
