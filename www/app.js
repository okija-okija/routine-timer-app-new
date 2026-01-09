// ==========================================
// 0. エラーハンドリング (真っ黒画面対策)
// ==========================================
window.onerror = function(msg, url, line) {
    // 画面にエラーを表示させる（デバッグ用）
    const log = document.getElementById('error-log');
    if (log) {
        log.style.display = 'block';
        log.innerHTML += `<div>Error: ${msg} <br> Line: ${line}</div>`;
    }
};

// ==========================================
// 1. Capacitorプラグインの読み込み
// ==========================================
// Webブラウザで開いたときは window.Capacitor は undefined になるため、空オブジェクトを入れてエラーを防ぐ
const CapacitorPlugins = window.Capacitor ? window.Capacitor.Plugins : {};
const Preferences = CapacitorPlugins.Preferences || null;
const LocalNotifications = CapacitorPlugins.LocalNotifications || null;

// ==========================================
// 2. データ初期値と状態管理
// ==========================================
const defaultTasks = [
    { id: '1', name: 'カーテンを開けて光を浴びる', duration: 1 },
    { id: '2', name: '顔を洗う', duration: 3 },
    { id: '3', name: '歯を磨く', duration: 3 },
    { id: '4', name: '着替え', duration: 5 }
];

let currentTasks = [];
let appConfig = {
    breakTime: 5,
    warnLoopLimit: 3,
    stopPassword: '123',
    voiceRate: 1.2,
    voiceURI: null
};

let state = {
    currentIndex: -1,
    isBreak: false,
    timeLeft: 0,
    timerInterval: null,
    warnInterval: null,
    warnCount: 0,
    isRunning: false
};

// ==========================================
// 3. DOM要素取得
// ==========================================
// 読み込み完了後に実行するように変更
document.addEventListener('DOMContentLoaded', () => {
    try {
        initializeApp();
    } catch (e) {
        console.error("Init Error", e);
        alert("初期化エラー: " + e.message);
    }
});

let els = {}; // 後で代入

function initializeApp() {
    // DOM要素を一括取得
    els = {
        mainScreen: document.getElementById('mainScreen'),
        settingsScreen: document.getElementById('settingsScreen'),
        menuBtn: document.getElementById('menuBtn'),
        closeSettingsBtn: document.getElementById('closeSettingsBtn'),
        saveSettingsBtn: document.getElementById('saveSettingsBtn'),
        addTaskBtn: document.getElementById('addTaskBtn'),
        nextBtn: document.getElementById('nextBtn'),
        breakBtn: document.getElementById('breakBtn'),
        retryBtn: document.getElementById('retryBtn'),
        stopBtn: document.getElementById('stopBtn'),
        testVoiceBtn: document.getElementById('testVoiceBtn'),
        timerDisplay: document.getElementById('timerDisplay'),
        taskName: document.getElementById('currentTaskName'),
        statusMsg: document.getElementById('statusMessage'),
        taskList: document.getElementById('taskListContainer'),
        breakTimeInput: document.getElementById('breakTimeInput'),
        loopLimitInput: document.getElementById('loopLimitInput'),
        voiceRateInput: document.getElementById('voiceRateInput'),
        voiceRateValue: document.getElementById('voiceRateValue'),
        voiceSelect: document.getElementById('voiceSelect')
    };

    // イベントリスナー設定
    setupEventListeners();
    // データ読み込み
    loadData();
}

// ==========================================
// 4. データ保存・読み込み (Capacitor Preferences対応)
// ==========================================
async function loadData() {
    let savedConfig = null;
    let savedTasks = null;

    if (Preferences) {
        // Androidアプリとして実行時はCapacitorのPreferencesを使用（アンインストールまで永続化）
        const { value: configVal } = await Preferences.get({ key: 'routine_timer_config' });
        const { value: tasksVal } = await Preferences.get({ key: 'routine_timer_tasks' });
        if (configVal) savedConfig = JSON.parse(configVal);
        if (tasksVal) savedTasks = JSON.parse(tasksVal);
    } else {
        // ブラウザ実行時はLocalStorageを使用
        const c = localStorage.getItem('routine_timer_config');
        const t = localStorage.getItem('routine_timer_tasks');
        if (c) savedConfig = JSON.parse(c);
        if (t) savedTasks = JSON.parse(t);
    }

    if (savedConfig) appConfig = { ...appConfig, ...savedConfig };
    currentTasks = savedTasks || JSON.parse(JSON.stringify(defaultTasks));

    // UIへの反映
    if(els.breakTimeInput) els.breakTimeInput.value = appConfig.breakTime;
    if(els.loopLimitInput) els.loopLimitInput.value = appConfig.warnLoopLimit;
    if(els.voiceRateInput) els.voiceRateInput.value = appConfig.voiceRate;
    if(els.voiceRateValue) els.voiceRateValue.textContent = `${appConfig.voiceRate}x`;

    loadVoices();
    updateDisplay();
}

async function saveToStorage() {
    appConfig.breakTime = parseInt(els.breakTimeInput.value) || 5;
    appConfig.warnLoopLimit = parseInt(els.loopLimitInput.value) || 3;
    appConfig.voiceRate = parseFloat(els.voiceRateInput.value) || 1.2;
    appConfig.voiceURI = els.voiceSelect.value;

    const tasksStr = JSON.stringify(currentTasks);
    const configStr = JSON.stringify(appConfig);

    if (Preferences) {
        await Preferences.set({ key: 'routine_timer_tasks', value: tasksStr });
        await Preferences.set({ key: 'routine_timer_config', value: configStr });
    } else {
        localStorage.setItem('routine_timer_tasks', tasksStr);
        localStorage.setItem('routine_timer_config', configStr);
    }

    alert('設定を保存しました');
}

// ==========================================
// 5. 通知機能 (Capacitor LocalNotifications)
// ==========================================
async function sendNotification(title, body) {
    if (LocalNotifications) {
        // 権限確認
        const perm = await LocalNotifications.checkPermissions();
        if (perm.display !== 'granted') {
            await LocalNotifications.requestPermissions();
        }
        
        // 即時通知をスケジュール
        await LocalNotifications.schedule({
            notifications: [{
                title: title,
                body: body,
                id: Date.now(), // ユニークID
                schedule: { at: new Date(Date.now() + 100) } // ほぼ即時
            }]
        });
    } else {
        console.log(`Notification: ${title} - ${body}`);
    }
}

// ==========================================
// 6. 音声合成 (TTS)
// ==========================================
function loadVoices() {
    if (!window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    els.voiceSelect.innerHTML = '<option value="">デフォルト</option>';
    
    voices.forEach(voice => {
        if(voice.lang.includes('ja') || voice.lang.includes('JP')) {
            const option = document.createElement('option');
            option.value = voice.voiceURI;
            option.textContent = `${voice.name} (${voice.lang})`;
            if (voice.voiceURI === appConfig.voiceURI) option.selected = true;
            els.voiceSelect.appendChild(option);
        }
    });
}
window.speechSynthesis.onvoiceschanged = loadVoices;

function speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const uttr = new SpeechSynthesisUtterance(text);
    uttr.lang = 'ja-JP';
    uttr.rate = appConfig.voiceRate;
    if (appConfig.voiceURI) {
        const voices = window.speechSynthesis.getVoices();
        const v = voices.find(vo => vo.voiceURI === appConfig.voiceURI);
        if (v) uttr.voice = v;
    }
    window.speechSynthesis.speak(uttr);
}

// ==========================================
// 7. タイマーロジック & UI更新
// ==========================================
function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateDisplay() {
    els.timerDisplay.textContent = formatTime(state.timeLeft);
    if (state.isBreak) {
        els.taskName.textContent = "休憩中";
        els.taskName.className = "text-3xl font-bold text-green-600 flex items-center justify-center";
    } else if (state.currentIndex >= 0 && state.currentIndex < currentTasks.length) {
        els.taskName.textContent = currentTasks[state.currentIndex].name;
        els.taskName.className = "text-3xl font-bold text-gray-800 flex items-center justify-center";
    } else {
        if (state.currentIndex >= currentTasks.length) {
            els.taskName.textContent = "全タスク完了！";
            els.nextBtn.textContent = "最初に戻る";
        } else {
            els.taskName.textContent = "準備完了";
            els.nextBtn.textContent = "スタート";
        }
    }
}

function startTimer(minutes) {
    clearInterval(state.timerInterval);
    clearInterval(state.warnInterval);
    state.warnCount = 0;
    els.statusMsg.textContent = "";
    els.retryBtn.classList.add('hidden');
    
    state.timeLeft = minutes * 60;
    state.isRunning = true;
    updateDisplay();

    state.timerInterval = setInterval(() => {
        if (state.timeLeft > 0) {
            state.timeLeft--;
            updateDisplay();
        } else {
            finishTaskTimer();
        }
    }, 1000);
}

function finishTaskTimer() {
    clearInterval(state.timerInterval);
    state.isRunning = false;
    els.retryBtn.classList.remove('hidden');
    els.statusMsg.textContent = "アクション待ち...";

    let msg = state.isBreak ? "休憩終了です。" : "時間です。";
    speak(msg);
    sendNotification("タイマー終了", msg);

    // 放置防止ループ
    state.warnInterval = setInterval(() => {
        if (state.warnCount >= appConfig.warnLoopLimit) {
            clearInterval(state.warnInterval);
            return;
        }
        state.warnCount++;
        speak("画面を操作してください。");
    }, 15000);
}

// ==========================================
// 8. イベントハンドラ
// ==========================================
function setupEventListeners() {
    // 設定画面開閉
    els.menuBtn.addEventListener('click', () => {
        renderTaskList();
        els.settingsScreen.classList.remove('translate-x-full');
    });
    els.closeSettingsBtn.addEventListener('click', () => {
        appConfig.breakTime = parseInt(els.breakTimeInput.value) || 5;
        appConfig.warnLoopLimit = parseInt(els.loopLimitInput.value) || 3;
        appConfig.voiceRate = parseFloat(els.voiceRateInput.value) || 1.2;
        appConfig.voiceURI = els.voiceSelect.value;
        els.settingsScreen.classList.add('translate-x-full');
    });

    els.saveSettingsBtn.addEventListener('click', saveToStorage);
    
    // タスク追加
    els.addTaskBtn.addEventListener('click', () => {
        currentTasks.push({ id: Date.now().toString(), name: '', duration: 5 });
        renderTaskList();
    });

    // タイマー操作
    els.nextBtn.addEventListener('click', () => {
        if (state.currentIndex === -1) {
            speak("開始します。");
            state.currentIndex = 0;
            startTask(0);
        } else {
            handleNext();
        }
    });

    els.breakBtn.addEventListener('click', () => {
        clearInterval(state.warnInterval);
        state.isBreak = true;
        speak("休憩します。");
        startTimer(appConfig.breakTime);
    });

    els.retryBtn.addEventListener('click', () => {
        clearInterval(state.warnInterval);
        speak("延長します。");
        startTimer(3);
    });

    els.stopBtn.addEventListener('click', () => {
        const pass = prompt("中断パスワード:");
        if (pass === appConfig.stopPassword) {
            clearInterval(state.timerInterval);
            clearInterval(state.warnInterval);
            state.currentIndex = -1;
            state.timeLeft = 0;
            updateDisplay();
            speak("中断しました。");
        }
    });
    
    els.testVoiceBtn.addEventListener('click', () => speak("テストです"));
    els.voiceRateInput.addEventListener('input', e => els.voiceRateValue.textContent = e.target.value + "x");
}

function handleNext() {
    clearInterval(state.warnInterval);
    if (state.isBreak) {
        state.isBreak = false;
        if (state.currentIndex < currentTasks.length) startTask(state.currentIndex);
        else endAllTasks();
    } else {
        state.currentIndex++;
        if (state.currentIndex >= currentTasks.length) endAllTasks();
        else startTask(state.currentIndex);
    }
}

function startTask(index) {
    const task = currentTasks[index];
    speak(`次は、${task.name}`);
    startTimer(task.duration);
    els.nextBtn.textContent = "完了 / 次へ";
}

function endAllTasks() {
    speak("全て完了です。");
    state.currentIndex = -1;
    updateDisplay();
}

function renderTaskList() {
    els.taskList.innerHTML = '';
    currentTasks.forEach((task, index) => {
        const li = document.createElement('li');
        li.className = "bg-white border rounded p-2 mb-2 flex items-center";
        li.innerHTML = `
            <div class="drag-handle mr-2 cursor-grab">☰</div>
            <input type="text" value="${task.name}" class="flex-1 border-b p-1 name-input">
            <input type="number" value="${task.duration}" class="w-12 border p-1 text-center dur-input">
            <span class="ml-1 text-xs">分</span>
            <button class="ml-2 text-red-400 del-btn">✕</button>
        `;
        
        li.querySelector('.name-input').addEventListener('input', e => currentTasks[index].name = e.target.value);
        li.querySelector('.dur-input').addEventListener('change', e => currentTasks[index].duration = parseInt(e.target.value)||1);
        li.querySelector('.del-btn').addEventListener('click', () => {
            if(confirm('削除しますか？')) {
                currentTasks.splice(index, 1);
                renderTaskList();
            }
        });
        els.taskList.appendChild(li);
    });

    new Sortable(els.taskList, {
        handle: '.drag-handle',
        onEnd: evt => {
            const item = currentTasks.splice(evt.oldIndex, 1)[0];
            currentTasks.splice(evt.newIndex, 0, item);
        }
    });
}
