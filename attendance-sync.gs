/**
 * 考勤打卡 APP - Google Apps Script 後端
 * 試算表 ID: 1xpax7RGcnPvwvWzZhIC1D-hs2IRoHaRa7h3ft0vBLmY
 * 
 * 部署方式：
 * 1. 在試算表中點選「擴充功能」→「Apps Script」
 * 2. 貼上此程式碼並儲存
 * 3. 點選「部署」→「新增部署作業」
 * 4. 類型：網頁應用程式
 * 5. 執行身分：我自己
 * 6. 存取權限：所有人
 * 7. 複製部署網址，填入 main.js 的 SHEETS_API_URL
 */

const SHEET_ID = '1xpax7RGcnPvwvWzZhIC1D-hs2IRoHaRa7h3ft0vBLmY';
const SHEET_NAME = '工作表1'; // 若您的工作表名稱不同請修改

function getSheet() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
}

// ─── 初始化標題列（第一次執行時自動建立）───
function initHeaders() {
  const sheet = getSheet();
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['日期', '上班時間', '下班時間', '工作類型', '實際工作時數', '備註']);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#4a90d9').setFontColor('#ffffff');
  }
}

// ─── GET 請求：讀取最後一筆資料 ───
function doGet(e) {
  try {
    initHeaders();
    const sheet = getSheet();
    const lastRow = sheet.getLastRow();

    // 沒有任何資料列（只有標題或完全空白）
    if (lastRow <= 1) {
      return jsonResponse({ hasData: false, lastRow: 0 });
    }

    const row = sheet.getRange(lastRow, 1, 1, 6).getValues()[0];
    
    // 輔助函式：確保日期/時間格式正確
    const fmtTime = (val) => {
      if (!val || !(val instanceof Date)) return val ? val.toString() : '';
      return Utilities.formatDate(val, Session.getScriptTimeZone(), "HH:mm");
    };

    return jsonResponse({
      hasData: true,
      lastRow: lastRow,
      date: row[0] instanceof Date ? Utilities.formatDate(row[0], Session.getScriptTimeZone(), "yyyy/MM/dd") : row[0].toString(),
      clockIn: fmtTime(row[1]),
      clockOut: fmtTime(row[2]),
      workType: row[3] ? row[3].toString() : '',
      duration: row[4] ? row[4].toString() : ''
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ─── POST 請求：新增或更新打卡資料 ───
function doPost(e) {
  try {
    initHeaders();
    const sheet = getSheet();
    const data = JSON.parse(e.postData.contents);

    if (data.action === 'clockIn') {
      // 新增一列（上班），下班欄留空
      sheet.appendRow([
        data.date,
        data.clockIn,
        '',           // 下班時間（待下班打卡補上）
        data.workType,
        '',           // 工作時數（待下班打卡補上）
        ''
      ]);
      const newRow = sheet.getLastRow();
      return jsonResponse({ success: true, action: 'clockIn', lastRow: newRow });

    } else if (data.action === 'clockOut') {
      // 更新指定列的下班時間與工作時數
      const targetRow = data.lastRow;
      if (!targetRow || targetRow <= 1) {
        return jsonResponse({ error: '無效的列號' }, 400);
      }
      sheet.getRange(targetRow, 3).setValue(data.clockOut);    // C 欄：下班時間
      sheet.getRange(targetRow, 5).setValue(data.duration);    // E 欄：工作時數
      return jsonResponse({ success: true, action: 'clockOut', updatedRow: targetRow });

    } else {
      return jsonResponse({ error: '未知的 action' }, 400);
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ─── 輔助：回傳 JSON 格式 ───
function jsonResponse(obj, statusCode) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
