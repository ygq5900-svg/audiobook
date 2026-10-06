// ===== 听书应用核心逻辑 =====

// ---------- 存储层 ----------
const DB_NAME = 'audiobook_db';
const DB_VERSION = 1;
const STORE_BOOKS = 'books';

// IndexedDB 封装，用于存储大文本
const DB = {
    db: null,
    open() {
        return new Promise((resolve, reject) => {
            if (this.db) return resolve(this.db);
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_BOOKS)) {
                    db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            req.onerror = () => reject(req.error);
        });
    },
    put(book) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_BOOKS, 'readwrite');
            tx.objectStore(STORE_BOOKS).put(book);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    },
    get(id) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_BOOKS, 'readonly');
            const req = tx.objectStore(STORE_BOOKS).get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    },
    delete(id) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_BOOKS, 'readwrite');
            tx.objectStore(STORE_BOOKS).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }
};

// localStorage 封装（书籍元数据 + 阅读进度）
const Meta = {
    KEY_BOOKS: 'audiobook_books',
    KEY_PROGRESS: 'audiobook_progress_',
    KEY_SETTINGS: 'audiobook_settings',

    getBooks() {
        try {
            return JSON.parse(localStorage.getItem(this.KEY_BOOKS)) || [];
        } catch (e) { return []; }
    },
    saveBooks(books) {
        localStorage.setItem(this.KEY_BOOKS, JSON.stringify(books));
    },
    addBook(book) {
        const books = this.getBooks();
        // 避免重复（按标题+大小）
        const exists = books.find(b => b.title === book.title && b.size === book.size);
        if (exists) return exists;
        books.unshift(book);
        this.saveBooks(books);
        return book;
    },
    removeBook(id) {
        const books = this.getBooks().filter(b => b.id !== id);
        this.saveBooks(books);
        localStorage.removeItem(this.KEY_PROGRESS + id);
    },
    getProgress(id) {
        try {
            return JSON.parse(localStorage.getItem(this.KEY_PROGRESS + id)) || { index: 0, percent: 0 };
        } catch (e) { return { index: 0, percent: 0 }; }
    },
    saveProgress(id, progress) {
        localStorage.setItem(this.KEY_PROGRESS + id, JSON.stringify(progress));
    },
    getSettings() {
        try {
            return JSON.parse(localStorage.getItem(this.KEY_SETTINGS)) || { rate: 1, voice: '' };
        } catch (e) { return { rate: 1, voice: '' }; }
    },
    saveSettings(s) {
        localStorage.setItem(this.KEY_SETTINGS, JSON.stringify(s));
    }
};

// ---------- 应用状态 ----------
const App = {
    currentBook: null,      // {id, title, content, paragraphs}
    currentIndex: 0,        // 当前段落索引
    isPlaying: false,
    voices: [],
    currentUtterance: null,
    timerId: null,
    timerEndTime: 0,
    timerDisplayId: null,
    stopAtChapterEnd: false,
};

// ---------- DOM 引用 ----------
const $ = id => document.getElementById(id);

// ---------- 工具 ----------
function showToast(msg, duration = 2000) {
    const toast = $('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.add('hidden'), duration);
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// 把文本切分为段落
function splitParagraphs(text) {
    // 按换行切分，过滤空行
    return text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
}

// ---------- 书架渲染 ----------
function renderShelf() {
    const books = Meta.getBooks();
    const list = $('book-list');
    if (books.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📖</div>
                <p>书架空空如也</p>
                <p class="hint">点击右上角「导入小说」添加 TXT 文件</p>
            </div>`;
        return;
    }
    list.innerHTML = books.map(b => {
        const prog = Meta.getProgress(b.id);
        const sizeMB = (b.size / 1024 / 1024).toFixed(2);
        return `
            <div class="book-card" data-id="${b.id}">
                <div class="book-card-header">
                    <div class="book-title">${escapeHtml(b.title)}</div>
                    <div class="book-progress">${prog.percent}%</div>
                </div>
                <div class="book-progress-bar">
                    <div class="book-progress-fill" style="width:${prog.percent}%"></div>
                </div>
                <div class="book-meta">${b.paragraphs || 0} 段 · ${sizeMB} MB · 导入于 ${b.importDate}</div>
            </div>`;
    }).join('');

    list.querySelectorAll('.book-card').forEach(card => {
        card.addEventListener('click', () => openBook(card.dataset.id));
    });
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

// ---------- 导入书籍 ----------
function importFiles(files) {
    if (!files || files.length === 0) return;
    let pending = files.length;
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            let text = e.target.result;
            // 处理 BOM
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            const paragraphs = splitParagraphs(text);
            const id = 'book_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            const title = file.name.replace(/\.txt$/i, '');
            const book = {
                id,
                title,
                content: text,
                paragraphs: paragraphs.length,
                size: file.size,
                importDate: new Date().toLocaleDateString('zh-CN')
            };
            try {
                await DB.put(book);
                Meta.addBook({
                    id, title, size: file.size,
                    paragraphs: paragraphs.length,
                    importDate: book.importDate
                });
                showToast(`已导入：${title}`);
            } catch (err) {
                showToast('导入失败：' + title);
            }
            pending--;
            if (pending === 0) renderShelf();
        };
        reader.onerror = () => {
            showToast('读取文件失败');
            pending--;
            if (pending === 0) renderShelf();
        };
        reader.readAsText(file, 'UTF-8');
    });
}

// ---------- 打开书籍 ----------
async function openBook(id) {
    showToast('加载中...', 500);
    const book = await DB.get(id);
    if (!book) {
        showToast('书籍不存在');
        return;
    }
    App.currentBook = {
        id: book.id,
        title: book.title,
        paragraphs: splitParagraphs(book.content)
    };
    const prog = Meta.getProgress(id);
    App.currentIndex = Math.min(prog.index, App.currentBook.paragraphs.length - 1);
    if (App.currentIndex < 0) App.currentIndex = 0;

    $('reader-title').textContent = book.title;
    renderReader();
    showView('reader-view');
    loadSettings();
}

function renderReader() {
    const display = $('text-display');
    display.innerHTML = App.currentBook.paragraphs.map((p, i) =>
        `<div class="paragraph" data-idx="${i}">${escapeHtml(p)}</div>`
    ).join('');
    updateProgress();
    scrollToCurrent();
}

function scrollToCurrent() {
    const el = document.querySelector(`.paragraph[data-idx="${App.currentIndex}"]`);
    if (el) {
        document.querySelectorAll('.paragraph.active').forEach(e => e.classList.remove('active'));
        el.classList.add('active');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function updateProgress() {
    const total = App.currentBook.paragraphs.length;
    const idx = App.currentIndex;
    const percent = total > 0 ? Math.round(((idx + 1) / total) * 100) : 0;
    $('progress-text').textContent = `${idx + 1} / ${total}`;
    $('progress-bar').style.width = percent + '%';
    if (App.currentBook) {
        Meta.saveProgress(App.currentBook.id, { index: idx, percent });
    }
}

// ---------- TTS 播放控制 ----------
function getVoices() {
    if (!window.speechSynthesis) return [];
    return window.speechSynthesis.getVoices().filter(v => v);
}

function populateVoices() {
    App.voices = getVoices();
    const select = $('voice-select');
    const settings = Meta.getSettings();
    const saved = settings.voice;
    // 优先中文
    const zhVoices = App.voices.filter(v => /zh|cmn|Chinese/i.test(v.lang) || /中文|普通话|chinese/i.test(v.name));
    const ordered = [...zhVoices, ...App.voices.filter(v => !zhVoices.includes(v))];
    select.innerHTML = ordered.map(v =>
        `<option value="${v.name}">${v.name} (${v.lang})</option>`
    ).join('');
    if (saved) {
        const opt = [...select.options].find(o => o.value === saved);
        if (opt) select.value = saved;
    }
}

function getSelectedVoice() {
    const name = $('voice-select').value;
    return App.voices.find(v => v.name === name) || App.voices[0] || null;
}

function speakCurrent() {
    if (!App.currentBook) return;
    if (!window.speechSynthesis) {
        showToast('当前设备不支持语音合成');
        return;
    }
    const text = App.currentBook.paragraphs[App.currentIndex];
    if (!text) {
        pause();
        showToast('已经是最后一段了');
        return;
    }
    // 取消之前的
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    const voice = getSelectedVoice();
    if (voice) utter.voice = voice;
    utter.rate = parseFloat($('rate-slider').value);
    utter.lang = voice ? voice.lang : 'zh-CN';

    utter.onend = () => {
        if (App.isPlaying) {
            // 播完本段，检查是否要停止（播完本章模式）
            if (App.stopAtChapterEnd) {
                App.stopAtChapterEnd = false;
                pause();
                showToast('已播完，停止播放');
                return;
            }
            nextParagraph(true);
        }
    };
    utter.onerror = (e) => {
        if (e.error !== 'canceled' && e.error !== 'interrupted') {
            showToast('播放出错：' + e.error);
        }
    };

    App.currentUtterance = utter;
    window.speechSynthesis.speak(utter);
    App.isPlaying = true;
    $('play-pause-btn').textContent = '⏸';
    scrollToCurrent();
    updateProgress();
}

function play() {
    if (!App.currentBook) return;
    App.isPlaying = true;
    speakCurrent();
}

function pause() {
    App.isPlaying = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    $('play-pause-btn').textContent = '▶';
}

function togglePlay() {
    if (App.isPlaying) pause();
    else play();
}

function nextParagraph(auto = false) {
    if (!App.currentBook) return;
    if (App.currentIndex < App.currentBook.paragraphs.length - 1) {
        App.currentIndex++;
        if (auto || App.isPlaying) {
            speakCurrent();
        } else {
            updateProgress();
            scrollToCurrent();
        }
    } else {
        pause();
        showToast('已经是最后一段');
    }
}

function prevParagraph() {
    if (!App.currentBook) return;
    if (App.currentIndex > 0) {
        App.currentIndex--;
        if (App.isPlaying) speakCurrent();
        else { updateProgress(); scrollToCurrent(); }
    } else {
        showToast('已经是第一段');
    }
}

// ---------- 设置 ----------
function loadSettings() {
    const s = Meta.getSettings();
    $('rate-slider').value = s.rate;
    $('rate-value').textContent = parseFloat(s.rate).toFixed(1);
}

// ---------- 定时关闭 ----------
function setTimer(minutes) {
    clearTimer();
    if (minutes <= 0) {
        $('timer-display').textContent = '∞';
        $('timer-btn').classList.remove('active');
        return;
    }
    App.timerEndTime = Date.now() + minutes * 60 * 1000;
    $('timer-btn').classList.add('active');
    App.timerDisplayId = setInterval(updateTimerDisplay, 1000);
    App.timerId = setTimeout(() => {
        pause();
        clearTimer();
        showToast('定时结束，已停止播放');
    }, minutes * 60 * 1000);
    updateTimerDisplay();
}

function updateTimerDisplay() {
    const remain = Math.max(0, App.timerEndTime - Date.now());
    const min = Math.floor(remain / 60000);
    const sec = Math.floor((remain % 60000) / 1000);
    $('timer-display').textContent = `${min}:${sec.toString().padStart(2, '0')}`;
}

function clearTimer() {
    if (App.timerId) clearTimeout(App.timerId);
    if (App.timerDisplayId) clearInterval(App.timerDisplayId);
    App.timerId = null;
    App.timerDisplayId = null;
    App.timerEndTime = 0;
    App.stopAtChapterEnd = false;
}

// ---------- 视图切换 ----------
function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $(id).classList.add('active');
}

// ---------- 事件绑定 ----------
function bindEvents() {
    // 导入
    $('import-btn').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (e) => {
        importFiles(e.target.files);
        e.target.value = '';
    });

    // 阅读器返回
    $('back-btn').addEventListener('click', () => {
        pause();
        showView('shelf-view');
        renderShelf();
    });

    // 更多
    $('more-btn').addEventListener('click', () => $('more-modal').classList.remove('hidden'));
    $('close-more-modal').addEventListener('click', () => $('more-modal').classList.add('hidden'));
    $('jump-to-begin').addEventListener('click', () => {
        App.currentIndex = 0;
        updateProgress();
        scrollToCurrent();
        if (App.isPlaying) speakCurrent();
        $('more-modal').classList.add('hidden');
        showToast('已跳到开头');
    });
    $('jump-to-last').addEventListener('click', () => {
        const prog = Meta.getProgress(App.currentBook.id);
        App.currentIndex = prog.index;
        updateProgress();
        scrollToCurrent();
        if (App.isPlaying) speakCurrent();
        $('more-modal').classList.add('hidden');
        showToast('已跳到上次位置');
    });
    $('delete-book').addEventListener('click', async () => {
        if (!confirm('确定从书架删除这本书吗？')) return;
        const id = App.currentBook.id;
        pause();
        await DB.delete(id);
        Meta.removeBook(id);
        App.currentBook = null;
        $('more-modal').classList.add('hidden');
        showView('shelf-view');
        renderShelf();
        showToast('已删除');
    });

    // 播放控制
    $('play-pause-btn').addEventListener('click', togglePlay);
    $('prev-chapter-btn').addEventListener('click', prevParagraph);
    $('next-chapter-btn').addEventListener('click', () => nextParagraph(false));

    // 语速
    $('rate-slider').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        $('rate-value').textContent = val.toFixed(1);
        Meta.saveSettings({ ...Meta.getSettings(), rate: val });
        if (App.isPlaying) speakCurrent();
    });

    // 音色
    $('voice-select').addEventListener('change', (e) => {
        Meta.saveSettings({ ...Meta.getSettings(), voice: e.target.value });
        if (App.isPlaying) speakCurrent();
    });

    // 定时
    $('timer-btn').addEventListener('click', () => $('timer-modal').classList.remove('hidden'));
    $('close-timer-modal').addEventListener('click', () => $('timer-modal').classList.add('hidden'));
    document.querySelectorAll('.timer-opt').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.min;
            document.querySelectorAll('.timer-opt').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            if (val === 'end') {
                clearTimer();
                App.stopAtChapterEnd = true;
                $('timer-display').textContent = '章末';
                $('timer-btn').classList.add('active');
                showToast('将在本段结束后停止');
            } else {
                setTimer(parseInt(val));
                showToast(val === '0' ? '已取消定时' : `已设置 ${val} 分钟定时`);
            }
            $('timer-modal').classList.add('hidden');
        });
    });
    $('set-custom-timer').addEventListener('click', () => {
        const min = parseInt($('custom-min').value);
        if (min > 0 && min <= 600) {
            setTimer(min);
            showToast(`已设置 ${min} 分钟定时`);
            $('timer-modal').classList.add('hidden');
        } else {
            showToast('请输入 1-600 之间的数字');
        }
    });

    // 点击段落跳转
    $('text-display').addEventListener('click', (e) => {
        const p = e.target.closest('.paragraph');
        if (p) {
            App.currentIndex = parseInt(p.dataset.idx);
            updateProgress();
            if (App.isPlaying) speakCurrent();
            else scrollToCurrent();
        }
    });

    // 进度条点击跳转
    $('progress-track').addEventListener('click', (e) => {
        if (!App.currentBook) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        const total = App.currentBook.paragraphs.length;
        App.currentIndex = Math.max(0, Math.min(total - 1, Math.floor(ratio * total)));
        updateProgress();
        if (App.isPlaying) speakCurrent();
        else scrollToCurrent();
    });

    // voices 加载
    if (window.speechSynthesis) {
        populateVoices();
        window.speechSynthesis.onvoiceschanged = populateVoices;
    }

    // 页面隐藏时暂停（防止后台继续消耗）
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && App.isPlaying) {
            // 不暂停，保留播放；仅保存进度
            updateProgress();
        }
    });

    // Cordova 设备就绪
    document.addEventListener('deviceready', () => {
        // 请求保持屏幕常亮（如果有插件）
        if (window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode) {
            // 可选
        }
    }, false);
}

// ---------- 初始化 ----------
function init() {
    bindEvents();
    renderShelf();
    // 预加载音色
    setTimeout(populateVoices, 300);
}

// 兼容 Cordova 与浏览器
if (window.cordova) {
    document.addEventListener('deviceready', init, false);
} else {
    document.addEventListener('DOMContentLoaded', init);
}
