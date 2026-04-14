// --- State Management ---
let state = {
  isPunchedIn: false,
  punchInTime: null,
  workType: 'normal',     // 'normal' | 'overtime'
  displayMode: 'elapsed', // 'elapsed' | 'countdown'
  leaveSettings: { enabled: false, hours: 1 },
  records: []
};

// Notification settings (persisted separately)
let notifySettings = {
  enabled: false,
  minsBefore: 5  // default: 5 minutes before punch-out
};

// Runtime flag — reset each punch-in so we only fire once per session
let _notifyFired = false;

// Break durations and work hours config
const WORK_CONFIG = {
  normal:   { breakMins: 50, label: '上班',   breakLabel: '（中間休息50分鐘）' },
  overtime: { breakMins: 30, label: '加班',   breakLabel: '（中間休息30分鐘）' }
};
const WORK_HOURS = 8; // hours of actual work

// --- Initialize App ---
function init() {
  loadData();
  startClock();
  updateUI();
  updateHistoryUI();
  syncNotifyUI();
  syncLeaveUI();
}

// --- Data Layer ---
function loadData() {
  const savedState = localStorage.getItem('attendance_state');
  if (savedState) {
    const parsed = JSON.parse(savedState);
    state.isPunchedIn = parsed.isPunchedIn;
    state.punchInTime = parsed.punchInTime ? new Date(parsed.punchInTime) : null;
    state.workType = parsed.workType || 'normal';
    if (parsed.leaveSettings) state.leaveSettings = parsed.leaveSettings;
  }

  const savedRecords = localStorage.getItem('attendance_records');
  if (savedRecords) {
    state.records = JSON.parse(savedRecords).map(r => ({
      ...r,
      in: new Date(r.in),
      out: r.out ? new Date(r.out) : null
    }));
  }

  // Load notification settings
  const savedNotify = localStorage.getItem('attendance_notify');
  if (savedNotify) {
    Object.assign(notifySettings, JSON.parse(savedNotify));
  }
}

function saveData() {
  localStorage.setItem('attendance_state', JSON.stringify({
    isPunchedIn: state.isPunchedIn,
    punchInTime: state.punchInTime,
    workType: state.workType,
    leaveSettings: state.leaveSettings
  }));
  localStorage.setItem('attendance_records', JSON.stringify(state.records));
}

function saveNotifySettings() {
  localStorage.setItem('attendance_notify', JSON.stringify(notifySettings));
}

// --- Clock Logic ---
function startClock() {
  setInterval(updateClock, 1000);
  updateClock();
}

function updateClock() {
  const now = new Date();

  // Format Time: HH:MM:SS
  const timeStr = now.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  document.getElementById('current-time').textContent = timeStr;

  // Format Date: YYYY年MM月DD日 星期X
  const dateOptions = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
  document.getElementById('current-date').textContent = now.toLocaleDateString('zh-TW', dateOptions);

  // Update Work Duration / Countdown
  if (state.isPunchedIn && state.punchInTime) {
    const durEl = document.getElementById('work-duration');

    if (state.displayMode === 'countdown') {
      // --- Countdown to estimated punch-out ---
      const currentRecord = state.records[0];
      if (currentRecord && currentRecord.estimatedOut) {
        const estOut = new Date(currentRecord.estimatedOut);
        const remainMs = estOut - now;

        if (remainMs <= 0) {
          // Overtime!
          const overMs  = Math.abs(remainMs);
          const overHrs = Math.floor(overMs / 3600000);
          const overMin = Math.floor((overMs % 3600000) / 60000);
          const overSec = Math.floor((overMs % 60000) / 1000);
          durEl.textContent = `+${pad(overHrs)}:${pad(overMin)}:${pad(overSec)}`;
          durEl.classList.add('overtime');
        } else {
          const rHrs = Math.floor(remainMs / 3600000);
          const rMin = Math.floor((remainMs % 3600000) / 60000);
          const rSec = Math.floor((remainMs % 60000) / 1000);
          durEl.textContent = `${pad(rHrs)}:${pad(rMin)}:${pad(rSec)}`;
          durEl.classList.remove('overtime');
        }
      }
    } else {
      // --- Elapsed time since punch-in ---
      const diffMs = now - state.punchInTime;
      const hrs = Math.floor(diffMs / 3600000);
      const mins = Math.floor((diffMs % 3600000) / 60000);
      const secs = Math.floor((diffMs % 60000) / 1000);
      durEl.textContent = `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
      durEl.classList.remove('overtime');
    }
  }

  // Check reminder notification
  checkReminder();
}

function pad(num) {
  return num.toString().padStart(2, '0');
}

// --- Work Type & Manual Time Logic ---
window.setWorkType = function(type) {
  state.workType = type;
  document.getElementById('type-normal').classList.toggle('active', type === 'normal');
  document.getElementById('type-overtime').classList.toggle('active', type === 'overtime');

  const manualTimeInput = document.getElementById('manual-time');
  const hintEl = document.getElementById('manual-time-hint');

  if (type === 'normal') {
    manualTimeInput.min = "06:10";
    manualTimeInput.max = "10:00";
    if (hintEl) {
      hintEl.innerHTML = '留空則以按鈕時間為準 <span style="color:#e74c3c; font-weight:600;">(彈性上班時間:06:10~10:00)</span>';
    }
  } else {
    manualTimeInput.removeAttribute('min');
    manualTimeInput.removeAttribute('max');
    if (hintEl) {
      hintEl.textContent = '留空則以按下「上班打卡」時的時間為準';
    }
  }
  
  if (type !== 'normal') {
    closeQuickPicker();
  }
};

// --- Display Mode Toggle (elapsed ↔ countdown) ---
window.toggleDisplayMode = function() {
  state.displayMode = (state.displayMode === 'elapsed') ? 'countdown' : 'elapsed';
  syncModeToggleBtn();
  // Remove overtime flash when switching away from countdown
  if (state.displayMode === 'elapsed') {
    document.getElementById('work-duration').classList.remove('overtime');
  }
};

function syncModeToggleBtn() {
  const btn = document.getElementById('mode-toggle-btn');
  if (!btn) return;
  if (state.displayMode === 'countdown') {
    btn.innerHTML = `<span class="material-icons-round">timer</span> 離下班倒數`;
    btn.classList.add('mode-countdown');
  } else {
    btn.innerHTML = `<span class="material-icons-round">schedule</span> 已上班時間`;
    btn.classList.remove('mode-countdown');
  }
}


window.clearManualTime = function() {
  document.getElementById('manual-time').value = '';
};

// --- Notification Logic ---

/**
 * Called when user flips the notification toggle.
 * Requests permission if enabling for the first time.
 */
window.onNotifyToggle = async function(checked) {
  if (checked) {
    const granted = await requestNotifyPermission();
    if (!granted) {
      // Permission denied — revert the toggle
      document.getElementById('notify-toggle').checked = false;
      return;
    }
  }
  notifySettings.enabled = checked;
  _notifyFired = false;
  saveNotifySettings();
  syncNotifyUI();
};

/** Set how many minutes before punch-out to send reminder */
window.setNotifyMins = function(mins) {
  notifySettings.minsBefore = mins;
  saveNotifySettings();
  // Reset fired flag so the new time triggers properly
  _notifyFired = false;
  // Update full UI (including hint text)
  syncNotifyUI();
};

/** Sync notification UI (toggle, preset buttons, hint text) */
function syncNotifyUI() {
  const toggle = document.getElementById('notify-toggle');
  const presetsEl = document.getElementById('notify-presets');
  const hintEl = document.getElementById('notify-hint');
  const iconEl = document.querySelector('.switch-icon');

  if (!toggle) return;

  toggle.checked = notifySettings.enabled;

  if (iconEl) {
    iconEl.textContent = notifySettings.enabled ? 'notifications_active' : 'notifications_off';
  }

  // Preset buttons are always clickable — user can set time before enabling
  // (No opacity/pointer-events restriction)

  if (hintEl) {
    if (notifySettings.enabled) {
      hintEl.textContent = `已開啟：下班前 ${notifySettings.minsBefore} 分鐘發送提醒`;
      hintEl.style.color = 'var(--success-color)';
      hintEl.style.opacity = '1';
    } else {
      hintEl.textContent = `目前設定：提前 ${notifySettings.minsBefore} 分鐘（開啟開關即生效）`;
      hintEl.style.color = '';
      hintEl.style.opacity = '0.8';
    }
  }

  // Sync preset active state
  [5, 10, 15, 30].forEach(m => {
    const btn = document.getElementById(`preset-${m}`);
    if (btn) btn.classList.toggle('active', m === notifySettings.minsBefore);
  });
}

/** Ask for browser notification permission */
async function requestNotifyPermission() {
  if (!('Notification' in window)) {
    alert('您的瀏覽器不支援通知功能');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// --- Leave Logic ---
function syncLeaveUI() {
  const toggle = document.getElementById('leave-toggle');
  const group = document.getElementById('group-leave-hours');
  const hint = document.getElementById('leave-hint');
  const icon = document.getElementById('leave-switch-icon');
  const summaryNote = document.getElementById('leave-summary-note');
  const rangeText = document.getElementById('leave-range-text');
  
  if (!toggle) return;
  
  toggle.checked = state.leaveSettings.enabled;
  
  if (state.leaveSettings.enabled) {
    group.style.opacity = '1';
    group.style.pointerEvents = '';
    hint.textContent = `已開啟：預計請假 ${state.leaveSettings.hours} 小時`;
    hint.style.color = 'var(--success-color)';
    if (icon) {
      icon.textContent = 'beach_access';
      icon.style.color = 'var(--success-color)';
    }
  } else {
    group.style.opacity = '0.5';
    group.style.pointerEvents = 'none';
    hint.textContent = '開啟後，可選擇今日預計請假的時數';
    hint.style.color = '';
    if (icon) {
      icon.textContent = 'event_busy';
      icon.style.color = '#aaa';
    }
  }
  
  // Update buttons and range note
  const canShowRange = state.isPunchedIn && state.records.length > 0;
  
  if (canShowRange && state.leaveSettings.enabled) {
    const wt = state.records[0].workType || state.workType;
    const config = WORK_CONFIG[wt];
    
    // 1. 計算「如果不請假」的標準下班時間 (8小時工作 + 休息)
    const stdOut = calculatePunchOut(state.punchInTime, wt, 0);
    
    // 2. 計算請假開始時間
    // 基本邏輯：標準下班時間往前推請假時數
    // 但如果請假時數超過 4 小時，代表會跨過中間休息時段，所以要額外往前推休息時間
    let leaveStartMs = stdOut.getTime() - (state.leaveSettings.hours * 3600000);
    if (state.leaveSettings.hours > 4) {
      leaveStartMs -= (config.breakMins * 60 * 1000);
    }
    const leaveStart = new Date(leaveStartMs);
    
    const fmt = { hour12: false, hour: '2-digit', minute: '2-digit' };
    rangeText.textContent = `預計請假時段：${leaveStart.toLocaleTimeString('zh-TW', fmt)} ~ ${stdOut.toLocaleTimeString('zh-TW', fmt)}`;
    summaryNote.style.display = 'flex';
  } else {
    summaryNote.style.display = 'none';
  }

  const wt = (state.records[0] && state.records[0].workType) || state.workType;
  const config = WORK_CONFIG[wt];
  const stdOut = state.isPunchedIn ? calculatePunchOut(state.punchInTime, wt, 0) : null;

  for (let i = 1; i <= 8; i++) {
    const btn = document.getElementById(`leave-btn-${i}`);
    if (btn) btn.classList.toggle('active', i === state.leaveSettings.hours);
    
    const timeSpan = document.getElementById(`leave-time-${i}`);
    if (timeSpan) {
      if (canShowRange && stdOut) {
         // 按鈕顯示的時間也採用相同邏輯：顯示「請假開始時間」
         let startMs = stdOut.getTime() - (i * 3600000);
         if (i > 4) startMs -= (config.breakMins * 60 * 1000);
         const start = new Date(startMs);
         timeSpan.textContent = `(${start.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' })} 起)`;
      } else {
         timeSpan.textContent = '';
      }
    }
  }
}

window.onLeaveToggle = function(checked) {
  state.leaveSettings.enabled = checked;
  saveData();
  syncLeaveUI();
  recalcCurrentSession();
};

window.setLeaveHours = function(hours) {
  state.leaveSettings.hours = hours;
  saveData();
  syncLeaveUI();
  recalcCurrentSession();
};

function recalcCurrentSession() {
  if (state.isPunchedIn && state.records.length > 0) {
    const currentRecord = state.records[0];
    if (!currentRecord.out) {
      currentRecord.estimatedOut = calculatePunchOut(state.punchInTime, currentRecord.workType);
      saveData();
      updateUI();
      updateHistoryUI();
    }
  }
}

/**
 * Called every second by updateClock.
 * Fires a notification when we enter the reminder window.
 */
function checkReminder() {
  if (!notifySettings.enabled) return;
  if (!state.isPunchedIn) return;
  if (_notifyFired) return;

  const currentRecord = state.records[0];
  if (!currentRecord || !currentRecord.estimatedOut) return;

  const now = new Date();
  const estOut = new Date(currentRecord.estimatedOut);
  const remainMs = estOut - now;
  const thresholdMs = notifySettings.minsBefore * 60 * 1000;

  // Fire when remaining time drops into the threshold window
  if (remainMs > 0 && remainMs <= thresholdMs) {
    _notifyFired = true;
    fireNotification(estOut, notifySettings.minsBefore);
  }
}

/** Dispatch the browser notification */
function fireNotification(estOut, minsBefore) {
  if (Notification.permission !== 'granted') return;

  const timeStr = estOut.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
  new Notification('✅ 即將下班啊！', {
    body: `您的下班時間 ${timeStr}，還有 ${minsBefore} 分鐘即可下班坏`,
    icon: '🌙'
  });
}


/**
 * Calculate estimated punch-out time:
 *  Total time to stay = 8 work hours + break duration
 */
function calculatePunchOut(punchInTime, workType, specificLeaveHours = null) {
  const config = WORK_CONFIG[workType];
  
  let actualWorkHours = WORK_HOURS; // default 8
  
  if (specificLeaveHours !== null) {
    actualWorkHours = WORK_HOURS - specificLeaveHours;
  } else if (state.leaveSettings && state.leaveSettings.enabled) {
    actualWorkHours = WORK_HOURS - state.leaveSettings.hours;
  }
  
  if (actualWorkHours < 0) actualWorkHours = 0;
  
  let breakMins = 0;
  // If actual work hours > 4, include the break time!
  if (actualWorkHours > 4) {
    breakMins = config.breakMins;
  }

  const totalMins = (actualWorkHours * 60) + breakMins;
  const punchOut = new Date(punchInTime.getTime() + totalMins * 60 * 1000);
  return punchOut;
}

// --- Interaction Logic ---
window.handlePunchIn = function() {
  if (state.isPunchedIn) return;

  // Resolve actual punch-in time: manual input OR now
  let punchInTime = new Date();
  const manualVal = document.getElementById('manual-time').value; // "HH:MM"
  if (manualVal) {
    const [h, m] = manualVal.split(':').map(Number);
    punchInTime = new Date();
    punchInTime.setHours(h, m, 0, 0);
  }

  // --- Validate Work Time for 'normal' shift ---
  if (state.workType === 'normal') {
    const h = punchInTime.getHours();
    const m = punchInTime.getMinutes();
    const timeNum = h * 100 + m; // 06:10 -> 610, 10:00 -> 1000
    if (timeNum < 610 || timeNum > 1000) {
      alert('⚠️ 「上班」性質的時間限制在 06:10 ~ 10:00 之間！');
      return;
    }
  }

  state.isPunchedIn = true;
  state.punchInTime = punchInTime;
  _notifyFired = false; // reset so reminder fires fresh for this session

  const estimatedOut = calculatePunchOut(punchInTime, state.workType);

  // Create an open record
  state.records.unshift({
    id: Date.now().toString(),
    date: punchInTime.toLocaleDateString('zh-TW'),
    workType: state.workType,
    in: punchInTime,
    out: null,
    estimatedOut: estimatedOut,
    durationMs: 0
  });

  saveData();
  updateUI();
  updateHistoryUI();
};

window.handlePunchOut = function() {
  if (!state.isPunchedIn) return;
  
  const now = new Date();
  const currentRecord = state.records[0];
  
  if (currentRecord && !currentRecord.out) {
    currentRecord.out = now;
    currentRecord.durationMs = now - currentRecord.in;
  }
  
  state.isPunchedIn = false;
  state.punchInTime = null;

  saveData();
  updateUI();
  updateHistoryUI();
};

// --- UI Updates ---
function updateUI() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const dur = document.getElementById('work-duration');
  const estimateEl = document.getElementById('punchout-estimate');
  const estimateTime = document.getElementById('punchout-time-display');
  const breakLabel = document.getElementById('break-label');

  const btnIn = document.getElementById('btn-punch-in');
  const btnOut = document.getElementById('btn-punch-out');
  const settingsCard = document.getElementById('settings-card');
  const manualTimeInput = document.getElementById('manual-time');

  if (state.isPunchedIn) {
    // Hide specific settings when punched in, show status
    const workTypeGroup = document.getElementById('group-work-type');
    const manualTimeGroup = document.getElementById('group-manual-time');
    if (workTypeGroup) {
      workTypeGroup.style.opacity = '0.5';
      workTypeGroup.style.pointerEvents = 'none';
    }
    if (manualTimeGroup) {
      manualTimeGroup.style.opacity = '0.5';
      manualTimeGroup.style.pointerEvents = 'none';
    }
    document.getElementById('type-normal').disabled = true;
    document.getElementById('type-overtime').disabled = true;
    manualTimeInput.disabled = true;

    dot.classList.add('active');
    const cfg = WORK_CONFIG[state.workType];
    const timeInStr = state.punchInTime.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    text.textContent = `目前的狀態：${cfg.label}中 (${timeInStr} 打卡)`;
    text.style.color = 'var(--success-color)';
    dur.classList.add('active');

    // Show estimated punch-out time
    const currentRecord = state.records[0];
    if (currentRecord && currentRecord.estimatedOut) {
      const est = new Date(currentRecord.estimatedOut);
      estimateTime.textContent = est.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
      breakLabel.textContent = cfg.breakLabel;
      estimateEl.style.display = 'flex';
      
      const leaveNote = document.getElementById('leave-note');
      const leaveHrs = document.getElementById('leave-hours-display');
      if (state.leaveSettings && state.leaveSettings.enabled) {
        leaveHrs.textContent = state.leaveSettings.hours;
        leaveNote.style.display = 'block';
      } else {
        leaveNote.style.display = 'none';
      }
    }

    btnIn.classList.add('disabled');
    btnIn.disabled = true;
    btnOut.classList.remove('disabled');
    btnOut.disabled = false;
  } else {
    // Restore settings card interaction
    const workTypeGroup = document.getElementById('group-work-type');
    const manualTimeGroup = document.getElementById('group-manual-time');
    if (workTypeGroup) {
      workTypeGroup.style.opacity = '1';
      workTypeGroup.style.pointerEvents = '';
    }
    if (manualTimeGroup) {
      manualTimeGroup.style.opacity = '1';
      manualTimeGroup.style.pointerEvents = '';
    }
    document.getElementById('type-normal').disabled = false;
    document.getElementById('type-overtime').disabled = false;
    manualTimeInput.disabled = false;

    dot.classList.remove('active');
    text.textContent = '目前的狀態：尚未打卡 / 已下班';
    text.style.color = 'var(--text-secondary)';
    dur.classList.remove('active');
    dur.textContent = '00:00:00';
    estimateEl.style.display = 'none';

    btnIn.classList.remove('disabled');
    btnIn.disabled = false;
    btnOut.classList.add('disabled');
    btnOut.disabled = true;
  }

  // Sync toggle button state
  setWorkType(state.workType);
  syncModeToggleBtn();
  syncLeaveUI();

  // Show mode toggle only when punched in
  const modeToggleBtn = document.getElementById('mode-toggle-btn');
  if (modeToggleBtn) {
    modeToggleBtn.style.display = state.isPunchedIn ? 'inline-flex' : 'none';
  }
  // Reset displayMode when clocked out
  if (!state.isPunchedIn) {
    state.displayMode = 'elapsed';
    document.getElementById('work-duration').classList.remove('overtime');
  }
}

function updateHistoryUI() {
  const container = document.getElementById('history-container');
  container.innerHTML = '';
  
  if (state.records.length === 0) {
    container.innerHTML = '<div class="history-empty">目前還沒有打卡紀錄喔！</div>';
    return;
  }

  state.records.forEach(record => {
    const timeInStr = record.in.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    let timeOutStr, estOutStr = '';

    if (record.out) {
      timeOutStr = record.out.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    } else {
      timeOutStr = '進行中...';
      if (record.estimatedOut) {
        const est = new Date(record.estimatedOut);
        estOutStr = `<span class="history-est">預計下班：${est.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>`;
      }
    }

    const wt = record.workType || 'normal';
    const cfg = WORK_CONFIG[wt];
    const typeTag = `<span class="history-type-tag type-${wt}">${cfg.label}</span>`;

    // Determine the raw elapsed milliseconds to display:
    // For completed records use durationMs; for in-progress use elapsed so far.
    const rawMs = record.out
      ? record.durationMs
      : (new Date() - record.in);

    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const breakMins = cfg.breakMins; // 50 or 30
    const breakMs   = breakMins * 60 * 1000;

    let durStr = '--';
    let breakNote = '';

    if (record.out || rawMs > 0) {
      if (rawMs > FOUR_HOURS_MS) {
        // Deduct break time
        const netMs   = Math.max(0, rawMs - breakMs);
        const netHrs  = Math.floor(netMs / 3600000);
        const netMins = Math.floor((netMs % 3600000) / 60000);
        durStr    = `${netHrs}h ${netMins}m`;
        breakNote = `<div class="break-note">
                       <span class="material-icons-round" style="font-size:13px;vertical-align:middle;">info</span>
                       已扣除休息 ${breakMins} 分鐘
                     </div>`;
      } else {
        // Under 4 hours — no deduction
        const hrs  = Math.floor(rawMs / 3600000);
        const mins = Math.floor((rawMs % 3600000) / 60000);
        durStr = `${hrs}h ${mins}m`;
      }
    }

    const card = document.createElement('div');
    card.className = 'history-card';
    card.dataset.id = record.id;
    card.innerHTML = `
      <div class="history-card-left">
        <div class="history-date">${record.date} ${typeTag}</div>
        <div class="history-times">
          ${timeInStr}
          <span class="material-icons-round" style="font-size:14px;margin:0 4px;">arrow_forward</span>
          ${timeOutStr}
        </div>
        ${estOutStr}
        ${breakNote}
      </div>
      <div class="history-card-right">
        <div class="history-duration">${durStr}</div>
        <button class="delete-btn" data-id="${record.id}" title="刪除此紀錄">
          <span class="material-icons-round">delete_outline</span>
        </button>
      </div>
    `;

    // Attach delete handler
    card.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;

      if (btn.classList.contains('confirm')) {
        // Second tap — actually delete
        deleteRecord(record.id);
      } else {
        // First tap — ask for confirmation
        btn.classList.add('confirm');
        btn.querySelector('.material-icons-round').textContent = 'check';
        btn.title = '再按一次確認刪除';

        // Auto-reset after 3 seconds
        setTimeout(() => {
          if (btn.classList.contains('confirm')) {
            btn.classList.remove('confirm');
            btn.querySelector('.material-icons-round').textContent = 'delete_outline';
            btn.title = '刪除此紀錄';
          }
        }, 3000);
      }
    });

    container.appendChild(card);
  });
}

// --- Delete a single record by id ---
function deleteRecord(id) {
  state.records = state.records.filter(r => r.id !== id);
  saveData();
  updateHistoryUI();
}


// --- Navigation ---
window.switchTab = function(tabId) {
  // Update Tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  document.getElementById(`tab-${tabId}`).classList.add('active');

  // Update Nav Buttons
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.remove('active');
  });
  event.currentTarget.classList.add('active');
};

// Start
document.addEventListener('DOMContentLoaded', init);


// --- Quick Time Picker Logic ---

let pickerState = {
  h: 8,
  t: 0,
  u: 0
};

window.openQuickPicker = function() {
  const picker = document.getElementById('quick-picker');
  if (!picker) return;
  
  // Try to parse current input value to sync picker
  const currentVal = document.getElementById('manual-time').value;
  if (currentVal && currentVal.includes(':')) {
    const [h, m] = currentVal.split(':').map(Number);
    pickerState.h = h;
    pickerState.t = Math.floor(m / 10);
    pickerState.u = m % 10;
  }

  syncPickerUI();
  picker.style.display = 'block';
};

window.closeQuickPicker = function() {
  const picker = document.getElementById('quick-picker');
  if (picker) picker.style.display = 'none';
};

window.pick = function(type, val) {
  pickerState[type] = val;
  syncPickerUI();
  updateManualTimeFromPicker();
  
  // Auto-close after picking units for speed, or if we have a full valid time
  if (type === 'u') {
    setTimeout(closeQuickPicker, 150);
  }
};

function syncPickerUI() {
  // Hour
  document.querySelectorAll('#col-hour .col-item').forEach(btn => {
    const val = parseInt(btn.textContent);
    btn.classList.toggle('active', val === pickerState.h);
  });
  // Tens
  document.querySelectorAll('#col-min-tens .col-item').forEach(btn => {
    const val = parseInt(btn.textContent) / 10;
    btn.classList.toggle('active', val === pickerState.t);
  });
  // Units
  document.querySelectorAll('#col-min-units .col-item').forEach(btn => {
    const val = parseInt(btn.textContent);
    btn.classList.toggle('active', val === pickerState.u);
  });
}

function updateManualTimeFromPicker() {
  const hh = pickerState.h.toString().padStart(2, '0');
  const mm = (pickerState.t * 10 + pickerState.u).toString().padStart(2, '0');
  document.getElementById('manual-time').value = `${hh}:${mm}`;
}

// Global initialization for time input interceptor
function setupPickerInterceptor() {
  const input = document.getElementById('manual-time');
  if (!input) return;

  // Intercept click and focus to show custom picker instead of native one
  const handleTrigger = (e) => {
    if (state.workType === 'normal') {
      e.preventDefault();
      input.blur(); // Prevent keyboard on mobile
      openQuickPicker();
    }
  };

  input.addEventListener('mousedown', handleTrigger);
  input.addEventListener('focus', handleTrigger);
  
  // Click-outside listener
  document.addEventListener('mousedown', (e) => {
    const picker = document.getElementById('quick-picker');
    const inputWrapper = document.querySelector('.time-input-wrapper');
    if (picker && picker.style.display === 'block') {
      if (!picker.contains(e.target) && !inputWrapper.contains(e.target)) {
        closeQuickPicker();
      }
    }
  });
}

// Add to init
const originalInit = init;
init = function() {
  originalInit();
  setupPickerInterceptor();
};
