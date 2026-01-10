// ==========================================
// 1. プラグイン準備と初期化
// ==========================================
const CapacitorPlugins = window.Capacitor ? window.Capacitor.Plugins : {};
const Preferences = CapacitorPlugins.Preferences || null;
const LocalNotifications = CapacitorPlugins.LocalNotifications || null;
const TextToSpeech = CapacitorPlugins['TextToSpeech'] || null; // ネイティブTTS

// デフォルト設定
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
    endTime: null,     // 【重要】タイマー終了予定時刻（Timestamp）
    timerId: null,
    warnId: null,
    warnCount: 0,
    isRunning: false
};

let els = {};

document.addEventListener('DOMContentLoaded', initializeApp);

function initializeApp() {
    // DOM取得
    els = {
        main: document.querySelector('main'),
        settingsOverlay: document.getElementById('settingsOverlay'),
        settingsScreen: document.getElementById('settingsScreen'),
        menuBtn: document.getElementById('menuBtn'),
        saveSettingsBtn: document.getElementById('saveSettingsBtn'),
        closeSettingsBtnArea: document.getElementById('closeSettingsBtnArea'),
        addTaskBtn: document.getElementById('addTaskBtn'),
        nextBtn: document.getElementById('nextBtn'),
        breakBtn: document.getElementById('breakBtn'),
        retryBtn: document.getElementById('retryBtn'),
        stopBtn: document.getElementById('stopBtn'),
        testVoiceBtn: document.getElementById('testVoiceBtn'),
        timerDisplay: document.getElementById('timerDisplay'),
        progressRing: document.getElementById('progressRing'),
        taskName: document.getElementById('currentTaskName'),
        statusMsg: document.getElementById('statusMessage'),
        taskList: document.getElementById('taskListContainer'),
        breakTimeInput: document.getElementById('breakTimeInput'),
        loopLimitInput: document.getElementById('loopLimitInput'),
        voiceRateInput: document.getElementById('voiceRateInput'),
        voiceRateValue: document.getElementById('voiceRateValue'),
        voiceSelect: document.getElementById('voiceSelect')
    };

    // リングの円周計算 (r=54)
    const circumference = 54 * 2 * Math.PI;
    els.progressRing.style.strokeDasharray = `${circumference} ${circumference}`;
    els.progressRing.style.strokeDashoffset = circumference;
    els.circumference = circumference;

    setupEventListeners();
    loadData();
    
    // 通知権限リクエスト
    if (LocalNotifications) {
        LocalNotifications.requestPermissions();
    }
}

// ==========================================
// 2. データ保存・読み込み
// ==========================================
async function loadData() {
    let savedConfig = null, savedTasks = null;
    if (Preferences) {
        const { value: c } = await Preferences.get({ key: 'routine_timer_config' });
        const { value: t } = await Preferences.get({ key: 'routine_timer_tasks' });
        if (c) savedConfig = JSON.parse(c);
        if (t) savedTasks = JSON.parse(t);
    } else {
        const c = localStorage.getItem('routine_timer_config');
        const t = localStorage.getItem('routine_timer_tasks');
        if (c) savedConfig = JSON.parse(c);
        if (t) savedTasks = JSON.parse(t);
    }

    if (savedConfig) appConfig = { ...appConfig, ...savedConfig };
    currentTasks = savedTasks || JSON.parse(JSON.stringify(defaultTasks));

    // UI反映
    els.breakTimeInput.value = appConfig.breakTime;
    els.loopLimitInput.value = appConfig.warnLoopLimit;
    els.voiceRateInput.value = appConfig.voiceRate;
    els.voiceRateValue.textContent = `${appConfig.voiceRate}x`;
    
    loadVoices();
    updateDisplay(0, 0); // 初期表示
}

async function saveToStorage() {
    appConfig.breakTime = parseInt(els.breakTimeInput.value) || 5;
    appConfig.warnLoopLimit = parseInt(els.loopLimitInput.value) || 3;
    appConfig.voiceRate = parseFloat(els.voiceRateInput.value) || 1.2;
    appConfig.voiceURI = els.voiceSelect.value;

    const tStr = JSON.stringify(currentTasks);
    const cStr = JSON.stringify(appConfig);

    if (Preferences) {
        await Preferences.set({ key: 'routine_timer_tasks', value: tStr });
        await Preferences.set({ key: 'routine_timer_config', value: cStr });
    } else {
        localStorage.setItem('routine_timer_tasks', tStr);
        localStorage.setItem('routine_timer_config', cStr);
    }
    
    closeSettings();
    alert('設定を保存しました');
}

// ==========================================
// 3. 音声処理 (Native Plugin優先)
// ==========================================
async function loadVoices() {
    els.voiceSelect.innerHTML = '<option value="">デフォルト (端末設定)</option>';
    if (TextToSpeech) {
        try {
            const { voices } = await TextToSpeech.getSupportedVoices();
            voices.forEach((v, i) => {
                if (v.lang.includes('ja') || v.lang.includes('JP')) {
                    const op = document.createElement('option');
                    op.value = i; // インデックスを使用
                    op.textContent = `${v.name.substring(0,15)} (${v.lang})`;
                    els.voiceSelect.appendChild(op);
                }
            });
        } catch(e) { console.error(e); }
    }
}

async function speak(text) {
    if (TextToSpeech) {
        try {
            await TextToSpeech.stop();
            const opts = {
                text: text,
                lang: 'ja-JP',
                rate: appConfig.voiceRate,
                pitch: 1.0,
                volume: 1.0
            };
            if (els.voiceSelect.value !== "") opts.voice = parseInt(els.voiceSelect.value);
            await TextToSpeech.speak(opts);
        } catch(e) { console.error(e); fallbackSpeak(text); }
    } else {
        fallbackSpeak(text);
    }
}

function fallbackSpeak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = appConfig.voiceRate;
    window.speechSynthesis.speak(u);
}

// ==========================================
// 4. タイマーロジック (バックグラウンド対応版)
// ==========================================
function startTimer(minutes) {
    stopTimerLogic(); // 既存タイマー停止
    
    const durationSec = minutes * 60;
    const now = Date.now();
    state.endTime = now + (durationSec * 1000); // 終了時刻を計算
    state.isRunning = true;
    state.warnCount = 0;
    
    els.statusMsg.textContent = "";
    els.retryBtn.classList.add('hidden');

    // 初回描画
    updateTimerUI(durationSec, durationSec);

    // 【重要】バックグラウンド通知予約
    if (LocalNotifications) {
        LocalNotifications.schedule({
            notifications: [{
                title: "時間です！",
                body: state.isBreak ? "休憩終了" : `${els.taskName.textContent} 終了`,
                id: 999,
                schedule: { at: new Date(state.endTime) },
                sound: null // デフォルト音
            }]
        });
    }

    // メインループ
    state.timerId = setInterval(() => {
        const remainingMs = state.endTime - Date.now();
        const remainingSec = Math.ceil(remainingMs / 1000);

        if (remainingSec <= 0) {
            finishTaskTimer();
        } else {
            updateTimerUI(remainingSec, durationSec);
        }
    }, 200); // UI更新頻度
}

function stopTimerLogic() {
    if (state.timerId) clearInterval(state.timerId);
    if (state.warnId) clearInterval(state.warnId);
    if (LocalNotifications) LocalNotifications.cancel({ notifications: [{id: 999}] });
    state.isRunning = false;
}

function updateTimerUI(currentSec, totalSec) {
    const m = Math.floor(currentSec / 60);
    const s = currentSec % 60;
    els.timerDisplay.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    
    // プログレスリング更新
    const offset = els.circumference - (currentSec / totalSec) * els.circumference;
    els.progressRing.style.strokeDashoffset = offset;
}

function updateDisplay(idx, duration) {
    // タスク名などのテキスト更新
    if (state.isBreak) {
        els.taskName.textContent = "休憩中 (リラックス...)";
        els.progressRing.classList.replace('text-blue-500', 'text-green-500');
    } else if (idx >= 0 && idx < currentTasks.length) {
        els.taskName.textContent = currentTasks[idx].name;
        els.progressRing.classList.replace('text-green-500', 'text-blue-500');
    } else {
        if (idx >= currentTasks.length) {
            els.taskName.textContent = "全タスク完了！";
            els.nextBtn.querySelector('span').textContent = "最初に戻る";
        } else {
            els.taskName.textContent = "準備完了";
            els.nextBtn.querySelector('span').textContent = "スタート";
        }
        els.timerDisplay.textContent = "00:00";
    }
}

function finishTaskTimer() {
    stopTimerLogic();
    updateTimerUI(0, 1);
    els.retryBtn.classList.remove('hidden');
    els.statusMsg.textContent = "アクション待ち...";

    const msg = state.isBreak ? 
        "休憩終了です。画面を見て、次のタスクへ進んでください。" : 
        "時間です。終わりましたか？次へ進むか、延長を選んでください。";
    
    speak(msg);

    // 没頭防止アラート (バックグラウンドでも動くようForegroundService頼みだが、JS側でもループ維持)
    state.warnId = setInterval(() => {
        if (state.warnCount >= appConfig.warnLoopLimit) {
            clearInterval(state.warnId);
            return;
        }
        state.warnCount++;
        const phrases = [
            "作業に集中しすぎていませんか？画面を操作してください。",
            "手が止まっていませんか？次へ行くか、延長しましょう。",
            "時間管理モードです。切り替えをお願いします。"
        ];
        speak(phrases[state.warnCount % phrases.length]);
    }, 15000);
}

// ==========================================
// 5. アクションハンドラ
// ==========================================
function setupEventListeners() {
    // 設定画面の開閉
    els.menuBtn.addEventListener('click', openSettings);
    els.saveSettingsBtn.addEventListener('click', saveToStorage);
    els.closeSettingsBtnArea.addEventListener('click', () => {
        // 保存せず閉じる場合は設定をリセットすべきだが今回は簡易的に閉じる
        closeSettings();
    });
    els.settingsOverlay.addEventListener('click', closeSettings);

    // メイン操作
    els.nextBtn.addEventListener('click', () => {
        if (state.currentIndex === -1) {
            speak("ルーティンを開始します。");
            state.currentIndex = 0;
            updateDisplay(0);
            startTask(0);
        } else {
            handleNext();
        }
    });

    els.breakBtn.addEventListener('click', () => {
        stopTimerLogic();
        state.isBreak = true;
        updateDisplay(-1);
        speak(`了解しました。${appConfig.breakTime}分休憩します。深呼吸しましょう。`);
        startTimer(appConfig.breakTime);
    });

    els.retryBtn.addEventListener('click', () => {
        stopTimerLogic(); // 警告ループ停止
        speak("3分延長します。無理せず進めましょう。");
        startTimer(3);
    });

    els.stopBtn.addEventListener('click', () => {
        const pass = prompt(`パスワードを入力してください (${appConfig.stopPassword})`);
        if (pass === appConfig.stopPassword) {
            stopTimerLogic();
            state.currentIndex = -1;
            updateDisplay(-1);
            speak("中断しました。");
        }
    });

    els.addTaskBtn.addEventListener('click', () => {
        currentTasks.push({ id: Date.now().toString(), name: '', duration: 5 });
        renderTaskList();
    });

    els.testVoiceBtn.addEventListener('click', () => speak("こんにちは。音声のテストです。"));
    els.voiceRateInput.addEventListener('input', e => els.voiceRateValue.textContent = `${e.target.value}x`);
}

function openSettings() {
    renderTaskList();
    els.settingsOverlay.classList.remove('hidden');
    // 少し待ってからopacity変更でアニメーション
    requestAnimationFrame(() => {
        els.settingsOverlay.classList.remove('opacity-0');
        els.settingsScreen.classList.remove('translate-y-full');
    });
}

function closeSettings() {
    els.settingsOverlay.classList.add('opacity-0');
    els.settingsScreen.classList.add('translate-y-full');
    setTimeout(() => {
        els.settingsOverlay.classList.add('hidden');
    }, 300);
}

function handleNext() {
    stopTimerLogic();
    if (state.isBreak) {
        state.isBreak = false;
        // 休憩後は現在のタスクを再開ではなく「次のタスク」か「休憩していたタスク」かの仕様によるが
        // ここでは「休憩していたタスク」に戻る挙動（または休憩が挟まる設計）
        // 指示書の挙動: 休憩->次のタスクへ進むとあるため次へ
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

function startTask(idx) {
    const task = currentTasks[idx];
    updateDisplay(idx);
    speak(`次は、${task.name}。時間は${task.duration}分です。`);
    startTimer(task.duration);
    els.nextBtn.querySelector('span').textContent = "完了 / 次へ";
}

function endAllTasks() {
    speak("全てのタスクが終了しました。今日も素晴らしい一日を！");
    state.currentIndex = -1;
    updateDisplay(-1);
}

// ==========================================
// 6. リスト描画 (SortableJS修正版)
// ==========================================
function renderTaskList() {
    els.taskList.innerHTML = '';
    currentTasks.forEach((task, index) => {
        const li = document.createElement('li');
        li.className = "bg-white border border-gray-200 rounded-xl p-3 flex items-center shadow-sm select-none";
        li.innerHTML = `
            <div class="drag-handle p-2 mr-2 text-gray-400 cursor-grab active:cursor-grabbing touch-none">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"></path></svg>
            </div>
            <div class="flex-1 min-w-0 mr-3">
                <input type="text" value="${task.name}" class="w-full text-base font-bold text-gray-800 bg-transparent border-b border-transparent focus:border-blue-500 placeholder-gray-400 py-1" placeholder="タスク名">
            </div>
            <div class="flex items-center space-x-3">
                <div class="flex items-center bg-gray-50 rounded-lg px-2 py-1">
                    <input type="number" value="${task.duration}" class="w-10 text-center bg-transparent font-bold text-gray-700" min="1">
                    <span class="text-xs text-gray-400">分</span>
                </div>
                <button class="del-btn text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </div>
        `;
        
        // イベントバブリング防止とデータバインディング
        const nameInput = li.querySelector('input[type="text"]');
        const durInput = li.querySelector('input[type="number"]');
        
        // 【重要】SortableJSと干渉しないように、入力時のイベント伝播を制御
        nameInput.addEventListener('mousedown', e => e.stopPropagation());
        nameInput.addEventListener('touchstart', e => e.stopPropagation());
        nameInput.addEventListener('input', e => currentTasks[index].name = e.target.value);
        
        durInput.addEventListener('mousedown', e => e.stopPropagation());
        durInput.addEventListener('touchstart', e => e.stopPropagation());
        durInput.addEventListener('change', e => currentTasks[index].duration = parseInt(e.target.value) || 1);
        
        li.querySelector('.del-btn').addEventListener('click', () => {
            if(confirm('削除しますか？')) {
                currentTasks.splice(index, 1);
                renderTaskList();
            }
        });
        
        els.taskList.appendChild(li);
    });

    // SortableJS設定 (スマホ最適化)
    new Sortable(els.taskList, {
        handle: '.drag-handle',   // ハンドル部分のみでドラッグ可能にする
        delay: 100,               // 誤タップ防止
        delayOnTouchOnly: true,
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'bg-blue-50',
        onEnd: evt => {
            const item = currentTasks.splice(evt.oldIndex, 1)[0];
            currentTasks.splice(evt.newIndex, 0, item);
        }
    });
}
