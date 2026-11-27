(() => {
  // Generate or restore anonymous Participant ID & Session ID
  function getOrCreateId(storage, key, prefix) {
    let val = storage.getItem(key);
    if (!val) {
      val = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
      storage.setItem(key, val);
    }
    return val;
  }

  const participantId = getOrCreateId(localStorage, 'sandbox_participant_id', 'P');
  const sessionId = getOrCreateId(sessionStorage, 'sandbox_session_id', 'S');

  let turn = 0;
  let activeTurnQuery = null;
  let activeTurnStartTime = null;
  let activeTurnLogged = false;
  let activeTurnClickedUrls = [];
  let isSearching = false;
  const conversationHistory = [];

  const homeForm = document.getElementById('home-search-form');
  const homeInput = document.getElementById('home-search-input');
  const resultsForm = document.getElementById('results-search-form');
  const resultsInput = document.getElementById('results-search-input');
  const followupForm = document.getElementById('followup-form');
  const followupInput = document.getElementById('followup-input');
  const followupSubmitBtn = document.getElementById('followup-submit-btn');
  const clearBtn = document.getElementById('clear-btn');
  const sessionBadge = document.getElementById('session-badge');

  const threadEl = document.getElementById('conversation-thread');
  const loadingEl = document.getElementById('loading-indicator');
  const errorEl = document.getElementById('error-banner');

  const terminateBtn = document.getElementById('terminate-btn');
  const modal = document.getElementById('terminate-modal');
  const modalLastQuery = document.getElementById('modal-last-query');
  const terminateReasonEl = document.getElementById('terminate-reason');
  const modalCancelBtn = document.getElementById('modal-cancel-btn');
  const modalSubmitBtn = document.getElementById('modal-submit-btn');

  function updateBadge() {
    sessionBadge.textContent = `${participantId} · Turn ${turn}`;
  }
  updateBadge();

  function buildActionPayload() {
    const dwellTime = Math.max(0, Date.now() - activeTurnStartTime);
    return {
      participantId,
      sessionId,
      turn,
      query: activeTurnQuery,
      dwellTime,
      clicked: activeTurnClickedUrls.length > 0,
      clickCount: activeTurnClickedUrls.length,
      clickedUrls: activeTurnClickedUrls.join(' | '),
    };
  }

  async function logPreviousTurnDwellTime() {
    if (!activeTurnQuery || activeTurnStartTime === null || activeTurnLogged) {
      return;
    }
    const payload = buildActionPayload();
    activeTurnLogged = true;

    try {
      await fetch('/api/log-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch (err) {
      console.error('Failed to log action:', err);
    }
  }

  // Flush active turn automatically if the user closes/leaves the page
  window.addEventListener('pagehide', () => {
    if (!activeTurnQuery || activeTurnStartTime === null || activeTurnLogged) {
      return;
    }
    const payload = buildActionPayload();
    activeTurnLogged = true;
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    navigator.sendBeacon('/api/log-action', blob);
  });

  function findSourceUrlForLabel(label, sources) {
    if (!Array.isArray(sources) || sources.length === 0) return null;
    const clean = label.trim().toLowerCase();
    for (const src of sources) {
      if (!src?.url) continue;
      try {
        const hostname = new URL(src.url).hostname.toLowerCase().replace(/^www\./, '');
        const cleanNoWww = clean.replace(/^www\./, '');
        if (
          hostname === cleanNoWww ||
          hostname.endsWith('.' + cleanNoWww) ||
          cleanNoWww.endsWith('.' + hostname) ||
          src.url.toLowerCase().includes(cleanNoWww)
        ) {
          return src.url;
        }
      } catch {
        if (src.url.toLowerCase().includes(clean)) return src.url;
      }
    }
    return null;
  }

  function appendFormattedText(parent, text, sources) {
    // Match [label](https://url), **bold**, or standalone [domain.tld]
    const tokenRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\[([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s\]]*)?)\]/g;
    let lastIndex = 0;
    let match;

    while ((match = tokenRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      if (match[1] && match[2]) {
        // [label](https://url)
        const a = document.createElement('a');
        a.className = 'cite-link';
        a.href = match[2];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = match[1];
        parent.appendChild(a);
      } else if (match[3]) {
        // **bold**
        const strong = document.createElement('strong');
        appendFormattedText(strong, match[3], sources);
        parent.appendChild(strong);
      } else if (match[4]) {
        // Standalone [domain.com] -> look up matching URL from sources
        const matchedUrl = findSourceUrlForLabel(match[4], sources);
        if (matchedUrl) {
          const a = document.createElement('a');
          a.className = 'cite-link';
          a.href = matchedUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = match[4];
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(match[0]));
        }
      }

      lastIndex = tokenRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function renderTurnBlock(turnNumber, query, summary, sources) {
    const block = document.createElement('section');
    block.className = 'turn-block';

    const header = document.createElement('div');
    header.className = 'turn-query-header';

    const tag = document.createElement('span');
    tag.className = 'turn-tag';
    tag.textContent = `Turn ${turnNumber}`;

    const qText = document.createElement('div');
    qText.className = 'turn-query-text';
    qText.textContent = query;

    header.appendChild(tag);
    header.appendChild(qText);
    block.appendChild(header);

    const aiBox = document.createElement('div');
    aiBox.className = 'ai-overview';

    const aiHeader = document.createElement('div');
    aiHeader.className = 'ai-overview-header';
    aiHeader.innerHTML = '<span class="ai-sparkle">✦</span><span>AI 摘要與即時搜尋結果</span>';

    const aiContent = document.createElement('div');
    aiContent.className = 'ai-summary-content';
    appendFormattedText(aiContent, summary || '（無文字摘要）', sources);

    aiBox.appendChild(aiHeader);
    aiBox.appendChild(aiContent);
    block.appendChild(aiBox);

    if (Array.isArray(sources) && sources.length > 0) {
      const srcSection = document.createElement('div');
      srcSection.className = 'sources-section';

      const srcHeading = document.createElement('h2');
      srcHeading.className = 'sources-heading';
      srcHeading.textContent = '引用來源';

      const srcList = document.createElement('div');
      srcList.className = 'sources-list';

      for (const src of sources) {
        const item = document.createElement('div');
        item.className = 'source-item';

        const urlDiv = document.createElement('div');
        urlDiv.className = 'source-url';
        urlDiv.textContent = src.url;

        const link = document.createElement('a');
        link.className = 'source-title';
        link.href = src.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = src.title || src.url;

        item.appendChild(urlDiv);
        item.appendChild(link);
        srcList.appendChild(item);
      }

      srcSection.appendChild(srcHeading);
      srcSection.appendChild(srcList);
      block.appendChild(srcSection);
    }

    block.addEventListener('click', (e) => {
      const link = e.target.closest('a.cite-link, a.source-title');
      if (link && link.href && turnNumber === turn) {
        activeTurnClickedUrls.push(link.href);
      }
    });

    threadEl.appendChild(block);
    block.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function performSearch(query) {
    const trimmed = query.trim();
    if (!trimmed || isSearching) return;

    isSearching = true;
    followupSubmitBtn.disabled = true;

    // Log dwell time of the previous turn before starting the new turn
    await logPreviousTurnDwellTime();

    turn += 1;
    updateBadge();

    document.body.classList.remove('mode-home');
    document.body.classList.add('mode-results');
    resultsInput.value = trimmed;

    loadingEl.classList.remove('hidden');
    errorEl.classList.add('hidden');

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: trimmed,
          history: conversationHistory,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '搜尋失敗');
      }

      const summary = data.summary || '';
      const sources = Array.isArray(data.sources) ? data.sources : [];

      renderTurnBlock(turn, trimmed, summary, sources);

      // Append to multi-turn context for future follow-up questions
      conversationHistory.push({ role: 'user', content: trimmed });
      if (summary) {
        conversationHistory.push({ role: 'assistant', content: summary });
      }

      followupForm.classList.remove('hidden');
      followupInput.value = '';
      followupInput.focus();

      activeTurnQuery = trimmed;
      activeTurnStartTime = Date.now();
      activeTurnLogged = false;
      activeTurnClickedUrls = [];
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
      activeTurnQuery = trimmed;
      activeTurnStartTime = Date.now();
      activeTurnLogged = false;
      activeTurnClickedUrls = [];
    } finally {
      loadingEl.classList.add('hidden');
      isSearching = false;
      followupSubmitBtn.disabled = false;
    }
  }

  homeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    performSearch(homeInput.value);
  });

  resultsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    performSearch(resultsInput.value);
  });

  followupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    performSearch(followupInput.value);
  });

  clearBtn.addEventListener('click', () => {
    resultsInput.value = '';
    resultsInput.focus();
  });

  // Termination ("轉為實體") modal handlers
  terminateBtn.addEventListener('click', () => {
    modalLastQuery.textContent = activeTurnQuery || '（尚未進行搜尋）';
    terminateReasonEl.value = '';
    modal.classList.remove('hidden');
    terminateReasonEl.focus();
  });

  modalCancelBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  modalSubmitBtn.addEventListener('click', async () => {
    const reason = terminateReasonEl.value.trim();
    if (!reason) {
      alert('請輸入轉為實體的原因。');
      terminateReasonEl.focus();
      return;
    }

    // Flush the final turn's dwell time before recording termination
    await logPreviousTurnDwellTime();

    try {
      const res = await fetch('/api/log-terminate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId,
          sessionId,
          lastQuery: activeTurnQuery || '',
          reason,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '送出失敗');
      }
      modal.classList.add('hidden');
      alert('已記錄您的轉實體原因，感謝參與！');
    } catch (err) {
      alert(`送出失敗：${err.message}`);
    }
  });
})();
