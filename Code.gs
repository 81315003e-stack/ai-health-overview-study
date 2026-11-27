/**
 * Google Apps Script (Code.gs) - 搜尋沙盒實驗資料接收器
 *
 * 使用方式：
 * 1. 開啟一個新的 Google 試算表 -> 上方選單「擴充功能」->「Apps Script」
 * 2. 將此檔案內容完整貼入 Code.gs 並儲存
 * 3. 點擊右上角「部署」->「新增部署作業」-> 類型選「網頁應用程式 (Web app)」
 *    - 執行身分：我 (Me)
 *    - 誰可以存取：所有人 (Anyone)
 * 4. 複製產生的「網頁應用程式網址 (Web app URL)」，填入 .env 的 GAS_WEBHOOK_URL
 */

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const data = JSON.parse(raw);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (data.type === 'search_log') {
      const sheet = getOrCreateSheet(ss, 'search_logs', [
        'timestamp',
        'participant_id',
        'session_id',
        'turn',
        'query',
        'dwell_time_ms',
        'clicked',
        'click_count',
        'clicked_urls',
      ]);
      sheet.appendRow([
        data.timestamp || new Date().toISOString(),
        data.participantId || '',
        data.sessionId || '',
        data.turn ?? '',
        data.query || '',
        data.dwellTime ?? 0,
        Boolean(data.clicked),
        data.clickCount ?? 0,
        data.clickedUrls || '',
      ]);
    } else if (data.type === 'termination_study') {
      const sheet = getOrCreateSheet(ss, 'termination_study', [
        'timestamp',
        'participant_id',
        'session_id',
        'last_query',
        'reason',
      ]);
      sheet.appendRow([
        data.timestamp || new Date().toISOString(),
        data.participantId || '',
        data.sessionId || '',
        data.lastQuery || '',
        data.reason || '',
      ]);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ status: 'ok', type: data.type || 'unknown' })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: err.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
