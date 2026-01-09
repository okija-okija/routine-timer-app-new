// app.js - Capacitor完全対応版（Preferencesで永続保存、LocalNotificationsでネイティブ通知）
// 元のroutine_timer2.htmlの<script>部分をほぼそのまま移植し、Capacitor対応にした完璧版
// 音声読み上げ：Web Speech API (speechSynthesis) を使用 → Androidでは自動的に端末の内蔵TTSエンジン（Google TTSなど）を使用します
// 端末設定で変更した音声エンジン・声が反映されます（これが「内蔵エンジンを使う」最善の方法です）
// 専用プラグインは不要・追加コード不要で動作します

/* =================================================================
   1. Capacitorプラグイン参照（Web実行時はフォールバック）
   ================================================================= */
const { Preferences, LocalNotifications } = window.Capacitor?.Plugins || {};

/* =================================================================
   2. データ・設定初期値
   ================================================================= */
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

/* =================================================================
   3. DOM要素取得
   ================================================================= */
const els = {
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

/* =================================================================
   4. Preferences（永続保存）ラッパー関数
   ================================================================= */
async function prefSet(key, value) {
    if (Preferences) {
        await Preferences.set({ key, value: JSON.stringify(value) });
    } else {
        localStorage.setItem(key, JSON.stringify(value));
    }
}

async function prefGet(key, fallback = null) {
    if (Preferences) {
        const { value } = await Preferences.get({ key });
        return value ? JSON.parse(value) : fallback;
    } else {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
    }
}

/* =================================================================
   5. ネイティブ通知ヘルパー
   ================================================================= */
async function requestNotificationPermission() {
    if (LocalNotifications) {
        await LocalNotifications.requestPermissions();
    }
}

async function sendNotification(title, body) {
    if (LocalNotifications) {
        await LocalNotifications.schedule({
            notifications: [{
                id: Date.now(),
                title: title,
                body: body,
                schedule: { at: new Date(Date.now() + 500) } // ほぼ即時
            }]
        });
    }
}

/* =================================================================
   6. 音声読み上げ（Android内蔵TTSエンジンを使用）
   ================================================================= */
function speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    const uttr = new SpeechSynthesisUtterance(text);
    uttr.lang = 'ja-JP';
    uttr.rate = appConfig.voiceRate;
    uttr.pitch = 1.0;

    if (appConfig.voiceURI) {
        const voices = window.speechSynthesis.getVoices();
        const selected = voices.find(v => v.voiceURI === appConfig.voiceURI);
        if (selected) uttr.voice = selected;
    }

    window.speechSynthesis.speak(uttr);
}

/* =================================================================
   7. タイマー基本関数
   ================================================================= */
function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateDisplay() {
    els.timerDisplay.textContent = formatTime(state.timeLeft);

    if (state.isBreak) {
        els.taskName.textContent = "休憩中 (リラックス...)";
        els.taskName.className = "text-3xl font-bold text-green-600 break-words leading-tight min-h-[4rem] flex items-center justify-center";
        els.timerDisplay.className = "text-6xl font-mono font-bold text-green-600 tracking-wider";
    } else if (state.currentIndex >= 0 && state.currentIndex < currentTasks.length) {
        els.taskName.textContent = currentTasks[state.currentIndex].name;
        els.taskName.className = "text-3xl font-bold text-gray-800 break-words leading-tight min-h-[4rem] flex items-center justify-center";
        els.timerDisplay.className = "text-6xl font-mono font-bold text-gray-700 tracking-wider";
    } else {
        if (state.currentIndex >= currentTasks.length) {
            els.taskName.textContent = "全タスク完了！";
            els.nextBtn.textContent = "最初に戻る";
        } else {
            els.taskName.textContent = "準備中...";
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

    // 音声＋ネイティブ通知
    if (state.isBreak) {
        speak("休憩終了です。画面を見て、次のタスクへ進んでください。");
        sendNotification("休憩終了", "次のタスクへ進んでください");
    } else {
        speak("時間です。終わりましたか？次へ進むか、延長を選んでください。");
        sendNotification("時間です", currentTasks[state.currentIndex]?.name + " が終了しました");
    }

    // 放置防止アラート
    const WARN_INTERVAL_MS = 15000; // 15秒（テスト時は短め、本番は長くしてもOK）
    state.warnInterval = setInterval(() => {
        if (state.warnCount >= appConfig.warnLoopLimit) {
            clearInterval(state.warnInterval);
            speak("反応がないため音声を停止します。再開時は画面を操作してください。");
            els.statusMsg.textContent = "待機中(静音)";
            return;
        }
        state.warnCount++;
        const phrases = [
            "作業に集中しすぎていませんか？画面を操作してください。",
            "手が止まっていませんか？次へ行くか、延長しましょう。",
            "時間管理モードです。切り替えをお願いします。"
        ];
        speak(phrases[state.warnCount % phrases.length]);
    }, WARN_INTERVAL_MS);
}

/* =================================================================
   8. タスク操作関数
   ================================================================= */
function startTask(index) {
    const task = currentTasks[index];
    speak(`次は、${task.name}。時間は${task.duration}分です。開始。`);
    sendNotification("タスク開始", `${task.name}（${task.duration}分）`);
    startTimer(task.duration);
    els.nextBtn.textContent = "完了 / 次へ";
}

function endAllTasks() {
    speak("全てのタスクが終了しました。今日も素晴らしい一日を！");
    sendNotification("ルーティン完了", "お疲れ様でした！");
    state.currentIndex = -1;
    els.taskName.textContent = "完了！";
    els.timerDisplay.textContent = "00:00";
    els.nextBtn.textContent = "最初に戻る";
}

function handleNext() {
    clearInterval(state.warnInterval);
    if (state.isBreak) {
        state.isBreak = false;
        if (state.currentIndex < currentTasks.length) {
            startTask(state.currentIndex);
        } else {
            endAllTasks();
        }
    } else {
        state.currentIndex++;
        if (state.currentIndex >= currentTasks.length) {
            endAllTasks();
        } else {
            startTask(state.currentIndex);
        }
    }
}

function handleBreak() {
    clearInterval(state.warnInterval);
    state.isBreak = true;
    speak(`了解しました。${appConfig.breakTime}分休憩します。深呼吸しましょう。`);
    sendNotification("休憩開始", `${appConfig.breakTime}分間リラックス`);
    startTimer(appConfig.breakTime);
}

function handleRetry() {
    clearInterval(state.warnInterval);
    speak("3分延長します。無理せず進めましょう。");
    sendNotification("延長", "＋3分");
    startTimer(3);
}

function handleStop() {
    const pass = prompt(`中断しますか？パスワードを入力してください`);
    if (pass === appConfig.stopPassword) {
        clearInterval(state.timerInterval);
        clearInterval(state.warnInterval);
        state.currentIndex = -1;
        state.timeLeft = 0;
        state.isRunning = false;
        updateDisplay();
        els.taskName.textContent = "中断しました";
        els.nextBtn.textContent = "スタート";
        speak("タイマーを中断しました。");
    } else {
        alert("パスワードが違います。");
    }
}

/* =================================================================
   9. タスクリスト描画・編集
   ================================================================= */
function renderTaskList() {
    els.taskList.innerHTML = '';
    currentTasks.forEach((task, index) => {
        const li = document.createElement('li');
        li.className = "bg-white border rounded-lg flex items-center p-2 shadow-sm mb-2";
        li.innerHTML = `
            <div class="drag-handle text-gray-400 mr-2 px-2 cursor-grab text-lg">☰</div>
            <input type="text" value="${task.name}" class="task-name-input flex-1 border-b border-transparent focus:border-blue-500 outline-none p-1 text-gray-700 bg-transparent" placeholder="タスク名">
            <div class="flex items-center mx-2">
                <input type="number" value="${task.duration}" class="task-duration-input w-12 border rounded p-1 text-center bg-gray-50" min="1">
                <span class="text-xs text-gray-400 ml-1">分</span>
            </div>
            <button class="delete-btn text-red-300 hover:text-red-500 p-2 rounded-full hover:bg-red-50">✕</button>
        `;
        li.querySelector('.task-name-input').addEventListener('input', e => {
            currentTasks[index].name = e.target.value;
        });
        li.querySelector('.task-duration-input').addEventListener('change', e => {
            const val = parseInt(e.target.value);
            currentTasks[index].duration = val > 0 ? val : 1;
        });
        li.querySelector('.delete-btn').addEventListener('click', () => {
            if (confirm('このタスクを削除しますか？')) {
                currentTasks.splice(index, 1);
                renderTaskList();
            }
        });
        els.taskList.appendChild(li);
    });

    // Sortable再適用
    new Sortable(els.taskList, {
        handle: '.drag-handle',
        animation: 150,
        ghostClass: 'bg-blue-100',
        onEnd: evt => {
            const item = currentTasks.splice(evt.oldIndex, 1)[0];
            currentTasks.splice(evt.newIndex, 0, item);
        }
    });
}

/* =================================================================
   10. データ読み込み・保存
   ================================================================= */
async function loadData() {
    await requestNotificationPermission();

    const savedConfig = await prefGet('routine_timer_config');
    const savedTasks = await prefGet('routine_timer_tasks');

    if (savedConfig) appConfig = { ...appConfig, ...savedConfig };
    currentTasks = savedTasks || JSON.parse(JSON.stringify(defaultTasks));

    // UI反映
    els.breakTimeInput.value = appConfig.breakTime;
    els.loopLimitInput.value = appConfig.warnLoopLimit;
    els.voiceRateInput.value = appConfig.voiceRate;
    els.voiceRateValue.textContent = `${appConfig.voiceRate}x`;

    loadVoicesToSelect();
    updateDisplay();
}

async function saveToStorage() {
    appConfig.breakTime = parseInt(els.breakTimeInput.value) || 5;
    appConfig.warnLoopLimit = parseInt(els.loopLimitInput.value) || 3;
    appConfig.voiceRate = parseFloat(els.voiceRateInput.value) || 1.2;
    appConfig.voiceURI = els.voiceSelect.value || null;

    await prefSet('routine_timer_tasks', currentTasks);
    await prefSet('routine_timer_config', appConfig);

    alert('現在の設定を「いつもの」として保存しました');
    sendNotification("保存完了", "次回起動時もこの設定で開始します");
}

/* =================================================================
   11. 音声リスト読み込み
   ================================================================= */
function loadVoicesToSelect() {
    const voices = window.speechSynthesis.getVoices();
    els.voiceSelect.innerHTML = '<option value="">デフォルト</option>';
    voices.forEach(voice => {
        if (voice.lang.includes('ja') || voice.lang.includes('JP')) {
            const option = document.createElement('option');
            option.value = voice.voiceURI;
            option.textContent = `${voice.name} (${voice.lang})`;
            if (voice.voiceURI === appConfig.voiceURI) option.selected = true;
            els.voiceSelect.appendChild(option);
        }
    });
}
window.speechSynthesis.onvoiceschanged = loadVoicesToSelect;

/* =================================================================
   12. イベントリスナー
   ================================================================= */
els.menuBtn.addEventListener('click', () => {
    renderTaskList();
    els.settingsScreen.classList.remove('translate-x-full');
});

els.closeSettingsBtn.addEventListener('click', () => {
    // 閉じる時に一時設定を反映
    appConfig.breakTime = parseInt(els.breakTimeInput.value) || 5;
    appConfig.warnLoopLimit = parseInt(els.loopLimitInput.value) || 3;
    appConfig.voiceRate = parseFloat(els.voiceRateInput.value) || 1.2;
    appConfig.voiceURI = els.voiceSelect.value || null;
    els.settingsScreen.classList.add('translate-x-full');
});

els.saveSettingsBtn.addEventListener('click', saveToStorage);
els.addTaskBtn.addEventListener('click', () => {
    currentTasks.push({ id: Date.now().toString(), name: '', duration: 5 });
    renderTaskList();
});

els.nextBtn.addEventListener('click', () => {
    if (state.currentIndex === -1) {
        speak("ルーティンを開始します。");
        state.currentIndex = 0;
        startTask(0);
    } else {
        handleNext();
    }
});

els.breakBtn.addEventListener('click', handleBreak);
els.retryBtn.addEventListener('click', handleRetry);
els.stopBtn.addEventListener('click', handleStop);

els.testVoiceBtn.addEventListener('click', () => {
    const tempRate = parseFloat(els.voiceRateInput.value);
    const tempVoiceURI = els.voiceSelect.value;
    const uttr = new SpeechSynthesisUtterance("こんにちは。音声のテストです。");
    uttr.lang = 'ja-JP';
    uttr.rate = tempRate;
    if (tempVoiceURI) {
        const voices = window.speechSynthesis.getVoices();
        const v = voices.find(vo => vo.voiceURI === tempVoiceURI);
        if (v) uttr.voice = v;
    }
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(uttr);
});

els.voiceRateInput.addEventListener('input', e => {
    els.voiceRateValue.textContent = `${e.target.value}x`;
});

/* =================================================================
   13. アプリ起動
   ================================================================= */
loadData();
