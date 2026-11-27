require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash:online';
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || `http://localhost:${PORT}`;
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'Search Sandbox';

const SEARCH_LOGS_PATH = path.join(__dirname, 'search_logs.csv');
const TERMINATION_STUDY_PATH = path.join(__dirname, 'termination_study.csv');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Per-file sequential write queue to prevent race conditions during concurrent CSV appends.
const fileWriteQueues = new Map();

function escapeCsvField(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function appendCsvRow(filePath, headers, rowValues) {
  const prev = fileWriteQueues.get(filePath) || Promise.resolve();
  const next = prev.then(async () => {
    let needsHeader = false;
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size === 0) {
        needsHeader = true;
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        needsHeader = true;
      } else {
        throw err;
      }
    }

    const lines = [];
    if (needsHeader) {
      // Prepend UTF-8 BOM (\uFEFF) so Excel opens Traditional Chinese characters cleanly.
      lines.push('\uFEFF' + headers.map(escapeCsvField).join(','));
    }
    lines.push(rowValues.map(escapeCsvField).join(','));

    await fs.promises.appendFile(filePath, lines.join('\n') + '\n', 'utf8');
  });

  // Keep queue alive even if one write fails
  fileWriteQueues.set(
    filePath,
    next.catch(() => {})
  );
  return next;
}

/**
 * POST /api/search
 * Receives { query } and calls OpenRouter API with web search enabled.
 * Returns { query, summary, sources }.
 */
app.post('/api/search', async (req, res) => {
  try {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      return res.status(400).json({ error: '請提供有效的搜尋關鍵字或提問 (query)。' });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: '伺服器尚未設定 OPENROUTER_API_KEY 環境變數，無法呼叫 OpenRouter API。',
      });
    }

    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const historyMessages = rawHistory
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim() !== ''
      )
      .slice(-16)
      .map((m) => ({
        role: m.role,
        content: m.content.trim(),
      }));

    const payload = {
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            '請務必一律使用「繁體中文（台灣用語）」回答所有問題與整理摘要。即使搜尋到的網頁來源為英文或其他語言，也請翻譯並彙整為自然流暢的繁體中文回覆，同時保留引用來源標記。',
        },
        ...historyMessages,
        {
          role: 'user',
          content: query,
        },
      ],
    };

    // Enable web search plugin if model slug doesn't already include :online
    if (!OPENROUTER_MODEL.endsWith(':online')) {
      payload.plugins = [{ id: 'web' }];
    }

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': OPENROUTER_SITE_URL,
        'X-Title': OPENROUTER_APP_NAME,
      },
      body: JSON.stringify(payload),
    });

    const data = await orRes.json();
    if (!orRes.ok) {
      const errMsg = data?.error?.message || `OpenRouter HTTP ${orRes.status}`;
      throw new Error(errMsg);
    }

    const message = data?.choices?.[0]?.message || {};
    const summary = typeof message.content === 'string' ? message.content : '';
    const annotations = Array.isArray(message.annotations) ? message.annotations : [];

    // Deduplicate url_citation annotations returned by OpenRouter web search
    const seenUrls = new Set();
    const sources = [];
    for (const ann of annotations) {
      const citation = ann?.url_citation;
      const uri = citation?.url;
      if (ann?.type === 'url_citation' && uri && !seenUrls.has(uri)) {
        seenUrls.add(uri);
        sources.push({
          title: citation.title || uri,
          url: uri,
        });
      }
    }

    return res.json({
      query,
      summary,
      sources,
    });
  } catch (err) {
    console.error('[/api/search] Error:', err);
    return res.status(500).json({
      error: '搜尋服務發生錯誤，請稍後再試。',
      details: err.message,
    });
  }
});

async function forwardToGas(payload) {
  const gasUrl = (process.env.GAS_WEBHOOK_URL || '').trim();
  if (!gasUrl) return;

  try {
    const res = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[GAS] HTTP ${res.status} while syncing ${payload.type}`);
    }
  } catch (err) {
    console.error(`[GAS] Sync failed (${payload.type}):`, err.message);
  }
}

/**
 * POST /api/log-action
 * Quantitative behavioral logging -> appends to search_logs.csv (+ optional GAS Google Sheets sync)
 * Fields: participantId, sessionId, turn, query, dwellTime, clicked, clickCount, clickedUrls
 */
app.post('/api/log-action', async (req, res) => {
  try {
    const body = req.body || {};
    const participantId = body.participantId ?? body.participant_id;
    const sessionId = body.sessionId ?? body.session_id;
    const turn = body.turn;
    const query = body.query;
    const dwellTime = body.dwellTime ?? body.dwell_time;
    const clicked = Boolean(body.clicked);
    const clickCount = Number.isFinite(Number(body.clickCount ?? body.click_count))
      ? Number(body.clickCount ?? body.click_count)
      : 0;
    const clickedUrls = body.clickedUrls ?? body.clicked_urls ?? '';

    if (
      !participantId ||
      !sessionId ||
      turn === undefined ||
      turn === null ||
      query === undefined ||
      query === null ||
      dwellTime === undefined ||
      dwellTime === null
    ) {
      return res.status(400).json({
        error: '缺少必要欄位：participantId, sessionId, turn, query, dwellTime',
      });
    }

    const timestamp = new Date().toISOString();
    await appendCsvRow(
      SEARCH_LOGS_PATH,
      [
        'timestamp',
        'participant_id',
        'session_id',
        'turn',
        'query',
        'dwell_time_ms',
        'clicked',
        'click_count',
        'clicked_urls',
      ],
      [timestamp, participantId, sessionId, turn, query, dwellTime, clicked, clickCount, clickedUrls]
    );

    // Sync to Google Sheets via GAS in background without blocking local logging
    forwardToGas({
      type: 'search_log',
      timestamp,
      participantId,
      sessionId,
      turn,
      query,
      dwellTime,
      clicked,
      clickCount,
      clickedUrls,
    });

    return res.json({ status: 'ok', file: 'search_logs.csv' });
  } catch (err) {
    console.error('[/api/log-action] Error:', err);
    return res.status(500).json({ error: '寫入 search_logs.csv 失敗。' });
  }
});

/**
 * POST /api/log-terminate
 * Qualitative turning point logging -> appends to termination_study.csv (+ optional GAS Google Sheets sync)
 * Fields: participantId, sessionId, lastQuery, reason
 */
app.post('/api/log-terminate', async (req, res) => {
  try {
    const body = req.body || {};
    const participantId = body.participantId ?? body.participant_id;
    const sessionId = body.sessionId ?? body.session_id;
    const lastQuery = body.lastQuery ?? body.last_query ?? '';
    const reason = body.reason;

    if (!participantId || !sessionId || !reason || String(reason).trim() === '') {
      return res.status(400).json({
        error: '缺少必要欄位：participantId, sessionId, reason',
      });
    }

    const timestamp = new Date().toISOString();
    const trimmedReason = String(reason).trim();
    await appendCsvRow(
      TERMINATION_STUDY_PATH,
      ['timestamp', 'participant_id', 'session_id', 'last_query', 'reason'],
      [timestamp, participantId, sessionId, lastQuery, trimmedReason]
    );

    forwardToGas({
      type: 'termination_study',
      timestamp,
      participantId,
      sessionId,
      lastQuery,
      reason: trimmedReason,
    });

    return res.json({ status: 'ok', file: 'termination_study.csv' });
  } catch (err) {
    console.error('[/api/log-terminate] Error:', err);
    return res.status(500).json({ error: '寫入 termination_study.csv 失敗。' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Search Sandbox server running at http://0.0.0.0:${PORT}`);
});
