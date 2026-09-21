/**
 * DataService - 解耦的背单词数据访问层
 * 
 * 设计规范：
 * 1. 所有方法均返回 Promise，强制使用 async/await 规范调用。
 * 2. 当前阶段：底层基于 LocalStorage + 内存种子数据（INITIAL_VOCABULARY）实现本地离线持久化。
 * 3. 后期迁移：只需在对应函数内部切换为 Supabase 客户端调用（如 supabase.from('words').select()），
 *    而外部上层 UI、算法及视图层代码 0 修改无缝兼容！
 */

const OLD_STORAGE_KEY = 'bubei_vocabulary_v1';
const STORAGE_KEY = 'bubei_academic_vocab_v2';
const DEVICE_ID_KEY = 'bubei_device_user_id';
const SETTINGS_KEY = 'bubei_user_settings_v1';
const VOCAB_VERSION_KEY = 'bubei_vocab_schema_v2';

/**
 * 获取或初始化当前设备的唯一匿名 ID，确保云端同步不会与其他设备/用户冲突
 */
function getDeviceId() {
  let id = null;
  try {
    id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = 'dev_' + (typeof crypto !== 'undefined' && crypto.randomUUID 
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) 
        : Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
  } catch (e) {
    id = 'dev_local_fallback';
  }
  return id;
}

/**
 * ---------------- 用户学习与交互偏好设置服务 ----------------
 */
const DEFAULT_SETTINGS = {
  dailyNewLimit: 20,    // 每日新词限额: 10 | 20 | 30 | 50 | 100
  studyBand: 'all',      // 'all' | 'band4-5' | 'band6-7' | 'band8-9' | 'starred'
  accent: 'us',          // 'us' (美音) | 'uk' (英音)
  autoPronounce: false,  // 切词自动发音
  hapticEnabled: true    // 触觉震动反馈
};

const SettingsService = {
  getSettings() {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (stored) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
      }
    } catch (e) {}
    return { ...DEFAULT_SETTINGS };
  },
  saveSettings(updates) {
    try {
      const current = this.getSettings();
      const updated = { ...current, ...updates };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
      return updated;
    } catch (e) {
      return DEFAULT_SETTINGS;
    }
  },
  updateSettings(updates) {
    return this.saveSettings(updates);
  }
};

/**
 * ---------------- Supabase 云端同步配置与服务 (支持设备级命名空间隔离) ----------------
 */
const SUPABASE_CONFIG = {
  url: 'https://ikflvnmqoophvyuypxmb.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlrZmx2bm1xb29waHZ5dXlweG1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5ODkyOTgsImV4cCI6MjEwNTU2NTI5OH0.rm9Lr2ZyHKTWbxNG6YcCxIQ2KminiHXNE7OyMBdNwoc'
};

const SupabaseService = {
  client: null,
  isInitialized: false,
  connectionState: 'idle', // 'idle' | 'connected' | 'table_missing' | 'error'

  getClient() {
    if (this.client) return this.client;
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
      try {
        this.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
        this.isInitialized = true;
      } catch (e) {
        console.warn('[SupabaseService] 初始化客户端异常:', e);
      }
    }
    return this.client;
  },

  /**
   * 检测 Supabase 连接状态与数据表就绪情况
   */
  async checkConnection() {
    const client = this.getClient();
    if (!client) {
      this.connectionState = 'error';
      return { ok: false, state: 'sdk_missing', message: 'Supabase SDK 尚未加载或当前处于离线模式' };
    }

    try {
      // 探测 words 表
      const { data, error, count } = await client
        .from('words')
        .select('id', { count: 'exact', head: true });

      if (error) {
        if (error.code === 'PGRST205' || (error.message && error.message.includes('schema cache'))) {
          this.connectionState = 'table_missing';
          return { ok: false, state: 'table_missing', message: '已成功连通 Supabase！但数据表尚未初始化，请先在 Supabase SQL Editor 中执行建表' };
        }
        this.connectionState = 'error';
        return { ok: false, state: 'error', message: error.message || '连接异常' };
      }

      this.connectionState = 'connected';
      return { ok: true, state: 'connected', cloudCount: count || 0, message: '云端数据库连接正常' };
    } catch (err) {
      this.connectionState = 'error';
      return { ok: false, state: 'error', message: err.message || '网络连接异常' };
    }
  },

  /**
   * 同步单个单词到云端（带 device_id 隔离，异步静默执行，不阻塞本地）
   */
  async syncWord(word) {
    const client = this.getClient();
    if (!client || this.connectionState !== 'connected') return;
    try {
      const deviceId = getDeviceId();
      const payload = {
        id: `${deviceId}_${word.id}`,
        device_id: deviceId,
        word_id: word.id,
        word: word.word,
        phonetic: word.phonetic || '',
        partOfSpeech: word.partOfSpeech || 'n.',
        definition: word.definition || '',
        exampleEn: word.exampleEn || '',
        exampleCn: word.exampleCn || '',
        tags: Array.isArray(word.tags) ? word.tags : [],
        status: word.status || 'new',
        reviewCount: Number(word.reviewCount) || 0,
        interval: Number(word.interval) || 0,
        nextReviewDate: Number(word.nextReviewDate) || Date.now(),
        lastReviewedAt: word.lastReviewedAt || null,
        userNotes: word.userNotes || '',
        isStarred: !!word.isStarred,
        createdAt: word.createdAt || Date.now(),
        lastModifiedAt: word.lastModifiedAt || Date.now()
      };
      await client.from('words').upsert(payload, { onConflict: 'id' });
    } catch (e) {
      console.warn('[SupabaseService] 单词同步静默捕获:', e);
    }
  },

  /**
   * 从云端删除单词
   */
  async deleteWord(id) {
    const client = this.getClient();
    if (!client || this.connectionState !== 'connected') return;
    try {
      const deviceId = getDeviceId();
      await client.from('words').delete().eq('id', `${deviceId}_${id}`);
    } catch (e) {
      console.warn('[SupabaseService] 删除单词同步静默捕获:', e);
    }
  },

  /**
   * 同步统计与打卡数据到云端 (以 deviceId 为主键隔离，杜绝覆盖他人记录)
   */
  async syncStats(stats) {
    const client = this.getClient();
    if (!client || this.connectionState !== 'connected') return;
    try {
      const deviceId = getDeviceId();
      const payload = {
        id: `stats_${deviceId}`,
        device_id: deviceId,
        dailyCounts: stats.dailyCounts || {},
        checkInDates: stats.checkInDates || [],
        bestStreak: Number(stats.bestStreak) || 0,
        lastActiveDate: stats.lastActiveDate || '',
        updatedAt: Date.now()
      };
      await client.from('study_stats').upsert(payload, { onConflict: 'id' });
    } catch (e) {
      console.warn('[SupabaseService] 打卡数据同步静默捕获:', e);
    }
  },

  /**
   * 分批全量推送本地数据到云端 (使用独立 device_id 隔离)
   * @param {(progress: { percent: number, current: number, total: number }) => void} [onProgress]
   */
  async pushAllToCloud(onProgress) {
    const client = this.getClient();
    if (!client) throw new Error('Supabase 客户端尚未初始化');

    const deviceId = getDeviceId();
    const words = await DataService.getWords();
    const stats = StatsService.getStats();

    // 1. 同步当前设备的打卡记录
    await this.syncStats(stats);

    // 2. 分批次同步当前设备词汇
    const batchSize = 200;
    const total = words.length;

    for (let i = 0; i < total; i += batchSize) {
      const batch = words.slice(i, i + batchSize).map(w => ({
        id: `${deviceId}_${w.id}`,
        device_id: deviceId,
        word_id: w.id,
        word: w.word,
        phonetic: w.phonetic || '',
        partOfSpeech: w.partOfSpeech || 'n.',
        definition: w.definition || '',
        exampleEn: w.exampleEn || '',
        exampleCn: w.exampleCn || '',
        tags: Array.isArray(w.tags) ? w.tags : [],
        status: w.status || 'new',
        reviewCount: Number(w.reviewCount) || 0,
        interval: Number(w.interval) || 0,
        nextReviewDate: Number(w.nextReviewDate) || Date.now(),
        lastReviewedAt: w.lastReviewedAt || null,
        userNotes: w.userNotes || '',
        isStarred: !!w.isStarred,
        createdAt: w.createdAt || Date.now(),
        lastModifiedAt: w.lastModifiedAt || Date.now()
      }));

      const { error } = await client.from('words').upsert(batch, { onConflict: 'id' });
      if (error) throw error;

      const current = Math.min(i + batchSize, total);
      if (typeof onProgress === 'function') {
        onProgress({
          percent: Math.round((current / total) * 100),
          current,
          total
        });
      }
    }

    return { total };
  },

  /**
   * 从云端拉取当前设备的数据并合并到本地
   */
  async pullAllFromCloud() {
    const client = this.getClient();
    if (!client) throw new Error('Supabase 客户端尚未初始化');

    const deviceId = getDeviceId();

    // 1. 拉取打卡记录
    try {
      const { data: statsData } = await client
        .from('study_stats')
        .select('*')
        .eq('id', `stats_${deviceId}`)
        .maybeSingle();

      if (statsData) {
        const localStats = StatsService.getStats();
        const mergedCheckIns = Array.from(new Set([...(localStats.checkInDates || []), ...(statsData.checkInDates || [])])).sort();
        const mergedCounts = { ...(localStats.dailyCounts || {}), ...(statsData.dailyCounts || {}) };
        const mergedStreak = Math.max(localStats.bestStreak || 0, statsData.bestStreak || 0);
        const newStats = {
          dailyCounts: mergedCounts,
          checkInDates: mergedCheckIns,
          bestStreak: mergedStreak,
          lastActiveDate: statsData.lastActiveDate || localStats.lastActiveDate
        };
        StatsService.saveStats(newStats);
      }
    } catch (e) {
      console.warn('[SupabaseService] 拉取打卡记录警告:', e);
    }

    // 2. 分页拉取云端词库
    let allCloudWords = [];
    let from = 0;
    const step = 1000;

    while (true) {
      const { data, error } = await client
        .from('words')
        .select('*')
        .eq('device_id', deviceId)
        .range(from, from + step - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;
      allCloudWords.push(...data);
      if (data.length < step) break;
      from += step;
    }

    if (allCloudWords.length === 0) {
      return { total: 0, added: 0, updated: 0 };
    }

    // 标准化数据格式并安全合并至本地
    const normalized = allCloudWords.map(item => ({
      id: item.word_id || (item.id && item.id.includes('_') ? item.id.split('_').slice(1).join('_') : item.id),
      word: item.word,
      phonetic: item.phonetic || '',
      partOfSpeech: item.partOfSpeech || item.part_of_speech || 'n.',
      definition: item.definition || '',
      exampleEn: item.exampleEn || item.example_en || '',
      exampleCn: item.exampleCn || item.example_cn || '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      status: item.status || 'new',
      reviewCount: Number(item.reviewCount || item.review_count) || 0,
      interval: Number(item.interval) || 0,
      nextReviewDate: Number(item.nextReviewDate || item.next_review_date) || Date.now(),
      lastReviewedAt: item.lastReviewedAt || item.last_reviewed_at || null,
      userNotes: item.userNotes || item.user_notes || '',
      isStarred: !!(item.isStarred || item.is_starred),
      createdAt: item.createdAt || item.created_at || Date.now()
    }));

    const result = await DataService.importBackup(normalized, 'merge');
    return {
      total: allCloudWords.length,
      added: result.added,
      updated: result.updated
    };
  }
};

/**
 * ---------------- IndexedDB 存储适配器 (支持海量词库与笔记，彻底消除 LocalStorage 5MB 配额溢出风险) ----------------
 */
const IDB_CONFIG = {
  dbName: 'bubei_vocabulary_db',
  version: 1,
  storeName: 'vocabulary'
};

const IdbStorage = {
  _db: null,

  async getDb() {
    if (this._db) return this._db;
    if (typeof indexedDB === 'undefined') return null;

    return new Promise((resolve) => {
      try {
        const request = indexedDB.open(IDB_CONFIG.dbName, IDB_CONFIG.version);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_CONFIG.storeName)) {
            db.createObjectStore(IDB_CONFIG.storeName, { keyPath: 'id' });
          }
        };
        request.onsuccess = (e) => {
          this._db = e.target.result;
          resolve(this._db);
        };
        request.onerror = (e) => {
          console.warn('[IdbStorage] 打开 IndexedDB 失败，自动降级至 LocalStorage:', e);
          resolve(null);
        };
      } catch (err) {
        console.warn('[IdbStorage] 初始化异常:', err);
        resolve(null);
      }
    });
  },

  async getAllWords() {
    const db = await this.getDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_CONFIG.storeName, 'readonly');
        const store = tx.objectStore(IDB_CONFIG.storeName);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve(null);
      } catch (e) {
        console.warn('[IdbStorage] getAllWords 读取失败:', e);
        resolve(null);
      }
    });
  },

  async saveAllWords(words) {
    const db = await this.getDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_CONFIG.storeName, 'readwrite');
        const store = tx.objectStore(IDB_CONFIG.storeName);
        store.clear();
        for (const w of words) {
          store.put(w);
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        console.warn('[IdbStorage] saveAllWords 写入失败:', e);
        resolve(false);
      }
    });
  },

  async putWord(word) {
    const db = await this.getDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_CONFIG.storeName, 'readwrite');
        const store = tx.objectStore(IDB_CONFIG.storeName);
        store.put(word);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  },

  async deleteWord(id) {
    const db = await this.getDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_CONFIG.storeName, 'readwrite');
        const store = tx.objectStore(IDB_CONFIG.storeName);
        store.delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }
};

const DataService = {
  _cachedWords: null,

  /**
   * 统一持久化存储：优先写入 IndexedDB（无上限容量），LocalStorage 仅维护轻量状态标记
   * 彻底杜绝移动端 LocalStorage 5MB 配额溢出 (QuotaExceededError) 与卡顿
   */
  async _persistWords(list) {
    this._cachedWords = list;
    await IdbStorage.saveAllWords(list);
    try {
      localStorage.setItem('bubei_vocab_meta', JSON.stringify({
        count: list.length,
        version: 2,
        updatedAt: Date.now()
      }));
      // 清理旧版可能占用的巨型 LocalStorage 避免挤占 5MB 配额
      localStorage.removeItem(STORAGE_KEY);
    } catch (quotaErr) {
      console.warn('[DataService] LocalStorage 写入轻量元数据异常:', quotaErr);
    }
    try {
      localStorage.setItem('bubei_data_sync_trigger', Date.now().toString());
    } catch (e) {}
  },

  /**
   * 初始化存储数据（支持从旧版迁移、增量迁移、以及 LocalStorage 自动平滑平移至 IndexedDB）
   * @returns {Promise<void>}
   */
  async init() {
    try {
      // 1. 优先探测 IndexedDB
      const idbList = await IdbStorage.getAllWords();
      if (idbList && idbList.length > 0) {
        // 增量检查是否有缺失字段 (如 isStarred 收藏状态)，自动平滑补齐
        let needsSave = false;
        idbList.forEach(w => {
          if (w.isStarred === undefined) {
            w.isStarred = false;
            needsSave = true;
          }
        });
        if (needsSave) {
          await IdbStorage.saveAllWords(idbList);
        }
        this._cachedWords = idbList;
        // 清理旧版可能残留的 3.8MB LocalStorage 垃圾数据
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        return;
      }

      // 2. 探测 LocalStorage (从旧版本自动平滑无缝导入 IndexedDB)
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        try {
          const list = JSON.parse(stored);
          if (Array.isArray(list) && list.length > 0) {
            list.forEach(w => {
              if (w.isStarred === undefined) w.isStarred = false;
            });
            this._cachedWords = list;
            await IdbStorage.saveAllWords(list);
            // 迁移完成后释放 LocalStorage
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
            return;
          }
        } catch (e) {
          console.warn('[DataService] 解析 LocalStorage 异常:', e);
        }
      }

      // 3. 首次启动：使用 INITIAL_VOCABULARY 种子数据初始化
      const oldStored = localStorage.getItem(OLD_STORAGE_KEY);
      const userNotesMap = new Map();
      const userStatusMap = new Map();
      const customWords = [];

      if (oldStored) {
        try {
          const oldList = JSON.parse(oldStored);
          if (Array.isArray(oldList)) {
            oldList.forEach(w => {
              if (w && w.word) {
                const key = w.word.toLowerCase();
                if (w.userNotes) userNotesMap.set(key, w.userNotes);
                if (w.status && w.status !== 'new') {
                  userStatusMap.set(key, {
                    status: w.status,
                    interval: w.interval || 0,
                    nextReviewDate: w.nextReviewDate,
                    reviewCount: w.reviewCount || 0,
                    lastReviewedAt: w.lastReviewedAt || null,
                    isStarred: !!w.isStarred
                  });
                }
                if (w.id && String(w.id).startsWith('word_custom_')) {
                  customWords.push(w);
                }
              }
            });
          }
        } catch (e) {
          console.warn('[DataService] 解析旧版本数据失败:', e);
        }
      }

      const now = Date.now();
      const seedData = (typeof INITIAL_VOCABULARY !== 'undefined') ? INITIAL_VOCABULARY.map(w => {
        const key = w.word.toLowerCase();
        const customState = userStatusMap.get(key);
        const userNote = userNotesMap.get(key) || w.userNotes || '';
        return {
          ...w,
          status: customState ? customState.status : (w.status || 'new'),
          interval: customState ? customState.interval : (w.interval || 0),
          nextReviewDate: customState ? customState.nextReviewDate : (w.nextReviewDate || now),
          reviewCount: customState ? customState.reviewCount : (w.reviewCount || 0),
          lastReviewedAt: customState ? customState.lastReviewedAt : (w.lastReviewedAt || null),
          userNotes: userNote,
          isStarred: customState ? !!customState.isStarred : false
        };
      }) : [];

      if (customWords.length > 0) {
        seedData.push(...customWords);
      }

      await this._persistWords(seedData);
    } catch (err) {
      console.warn('[DataService] 本地存储初始化警告:', err);
    }
  },

  /**
   * 切换单词星标收藏状态
   * @param {string} id 单词唯一标识
   * @returns {Promise<boolean>} 当前是否已收藏
   */
  async toggleStar(id) {
    const list = await this.getWords();
    const item = list.find(w => w.id === id);
    if (!item) return false;
    item.isStarred = !item.isStarred;
    item.lastModifiedAt = Date.now();
    this._cachedWords = list;
    await IdbStorage.putWord(item);
    SupabaseService.syncWord(item).catch(() => {});
    return item.isStarred;
  },

  /**
   * 导出为 Anki / 制表符分隔的 TSV 文本格式
   * 包含：单词、音标、词性、释义、英文例句、中文例句、标签、笔记
   */
  async exportAnkiTsv() {
    const list = await this.getWords();
    const headers = ['Word', 'Phonetic', 'PartOfSpeech', 'Definition', 'ExampleEn', 'ExampleCn', 'Tags', 'Notes'];
    const rows = list.map(w => [
      (w.word || '').replace(/[\r\n\t]/g, ' '),
      (w.phonetic || '').replace(/[\r\n\t]/g, ' '),
      (w.partOfSpeech || '').replace(/[\r\n\t]/g, ' '),
      (w.definition || '').replace(/[\r\n\t]/g, ' '),
      (w.exampleEn || '').replace(/[\r\n\t]/g, ' '),
      (w.exampleCn || '').replace(/[\r\n\t]/g, ' '),
      (w.tags || []).join('; '),
      (w.userNotes || '').replace(/[\r\n\t]/g, ' ')
    ].join('\t'));
    return [headers.join('\t'), ...rows].join('\n');
  },

  /**
   * 获取全部单词列表 (多级缓存：内存 -> IndexedDB -> LocalStorage -> INITIAL_VOCABULARY)
   * @returns {Promise<Array>} 单词对象数组
   */
  async getWords() {
    if (this._cachedWords && this._cachedWords.length > 0) {
      return [...this._cachedWords];
    }

    // 优先读取 IndexedDB
    const idbWords = await IdbStorage.getAllWords();
    if (idbWords && idbWords.length > 0) {
      this._cachedWords = idbWords;
      return [...idbWords];
    }

    // 回退读取 LocalStorage
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this._cachedWords = parsed;
          IdbStorage.saveAllWords(parsed).catch(() => {});
          return [...parsed];
        }
      }
    } catch (err) {
      console.error('[DataService] getWords 读取异常:', err);
    }

    const fallback = (typeof INITIAL_VOCABULARY !== 'undefined') ? [...INITIAL_VOCABULARY] : [];
    this._cachedWords = fallback;
    return [...fallback];
  },

  /**
   * 根据唯一 ID 查询单个单词
   * @param {string} id 单词唯一标识
   * @returns {Promise<Object|null>}
   */
  async getWordById(id) {
    const list = await this.getWords();
    const found = list.find(item => item.id === id);
    return found ? { ...found } : null;
  },

  /**
   * 新增单词（含防重校验、空值过滤与数据清洗）
   * @param {Object} word 单词实体
   * @returns {Promise<Object>} 保存成功的单词对象
   */
  async addWord(word) {
    if (!word || !word.word || typeof word.word !== 'string') {
      throw new Error('新增单词失败：单词英文内容不能为空');
    }
    const cleanWord = word.word.trim();
    if (!/[a-zA-Z]/.test(cleanWord)) {
      throw new Error('新增单词失败：单词必须包含有效英文字母');
    }

    const list = await this.getWords();
    // 严格大小写不敏感防重复校验
    const existing = list.find(w => w.word.toLowerCase().trim() === cleanWord.toLowerCase());
    if (existing) {
      const statusText = existing.status === 'mastered' ? '已掌握' : (existing.status === 'learning' ? '复习中' : '新词');
      throw new Error(`单词 "${cleanWord}" 已在词库中（当前状态: ${statusText}）`);
    }

    const cleanDef = (word.definition || '').trim() || '未指定释义';
    const now = Date.now();
    const newWord = {
      id: word.id || `word_custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      word: cleanWord,
      phonetic: (word.phonetic || '').trim(),
      partOfSpeech: word.partOfSpeech || 'n.',
      definition: cleanDef,
      exampleEn: (word.exampleEn || '').trim(),
      exampleCn: (word.exampleCn || '').trim(),
      tags: Array.isArray(word.tags) && word.tags.length > 0 ? word.tags : ['自定义'],
      status: word.status || 'new',
      reviewCount: Number(word.reviewCount) || 0,
      userNotes: (word.userNotes || '').trim(),
      isStarred: !!word.isStarred,
      interval: Number(word.interval) || 0,
      nextReviewDate: Number(word.nextReviewDate) || now,
      lastReviewedAt: word.lastReviewedAt || null,
      createdAt: now,
      lastModifiedAt: now
    };

    list.push(newWord);
    this._cachedWords = list;
    await IdbStorage.putWord(newWord);
    SupabaseService.syncWord(newWord).catch(() => {});
    return newWord;
  },

  /**
   * 更新指定单词（状态、复习次数、释义等）
   * @param {string} id 单词唯一标识
   * @param {Object} updates 需要更新的键值对
   * @returns {Promise<Object>} 更新后的单词对象
   */
  async updateWord(id, updates) {
    const list = await this.getWords();
    const index = list.findIndex(item => item.id === id);

    if (index === -1) {
      throw new Error(`[DataService] 未找到 ID 为 ${id} 的单词`);
    }

    const updatedItem = {
      ...list[index],
      ...updates,
      lastModifiedAt: Date.now()
    };

    list[index] = updatedItem;
    this._cachedWords = list;
    await IdbStorage.putWord(updatedItem);
    SupabaseService.syncWord(updatedItem).catch(() => {});
    return updatedItem;
  },

  /**
   * 错题联动反向降级（用于拼写或自测答错时快速重置排期）
   * @param {string} id 单词唯一标识
   * @returns {Promise<Object|null>} 降级更新后的单词
   */
  async downgradeWord(id) {
    const list = await this.getWords();
    const index = list.findIndex(item => item.id === id);
    if (index === -1) return null;

    const currentWord = list[index];
    const srsUpdate = SRSService.calculateFuzzy(currentWord);
    const updated = {
      ...currentWord,
      ...srsUpdate,
      status: 'learning',
      lastModifiedAt: Date.now()
    };

    list[index] = updated;
    this._cachedWords = list;
    await IdbStorage.putWord(updated);
    SupabaseService.syncWord(updated).catch(() => {});
    return updated;
  },

  /**
   * 删除指定单词（级联同步 IndexedDB 与 Supabase）
   * @param {string} id 单词唯一标识
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteWord(id) {
    const list = await this.getWords();
    const index = list.findIndex(item => item.id === id);
    if (index === -1) {
      return false;
    }

    list.splice(index, 1);
    this._cachedWords = list;
    await IdbStorage.deleteWord(id);
    SupabaseService.deleteWord(id).catch(() => {});
    return true;
  },

  /**
   * 导出备份数据包
   * @returns {Promise<Object>}
   */
  async exportBackup() {
    const list = await this.getWords();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    return {
      version: 2,
      appName: '不背英语',
      exportedAt: now.toISOString(),
      backupFileName: `bubei_backup_${timeStr}.json`,
      totalWords: list.length,
      vocabulary: list
    };
  },

  /**
   * 导入并恢复数据（含严谨 Schema 结构校验、异常回滚防护）
   * @param {Array|Object} rawData - 待导入的原始数据（支持数组或包含 vocabulary 字段的对象）
   * @param {'overwrite'|'merge'} [strategy='merge'] - 导入策略
   * @returns {Promise<{ success: boolean, total: number, added: number, updated: number, list: Array }>}
   */
  async importBackup(rawData, strategy = 'merge') {
    if (!rawData) {
      throw new Error('导入失败：上传的备份文件内容为空');
    }

    let itemsToProcess = rawData;
    if (!Array.isArray(rawData) && typeof rawData === 'object') {
      if (Array.isArray(rawData.vocabulary)) {
        itemsToProcess = rawData.vocabulary;
      } else if (Array.isArray(rawData.words)) {
        itemsToProcess = rawData.words;
      }
    }

    if (!Array.isArray(itemsToProcess) || itemsToProcess.length === 0) {
      throw new Error('导入失败：备份文件中未检测到合法的词汇数组列表 (vocabulary)');
    }

    // 格式化与清洗每一项词汇，过滤非法字段
    const cleanIncoming = [];
    for (const item of itemsToProcess) {
      if (!item || typeof item !== 'object' || !item.word || typeof item.word !== 'string') {
        continue;
      }
      const cleanWord = item.word.trim();
      if (!cleanWord) continue;

      cleanIncoming.push({
        id: String(item.id || `word_import_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
        word: cleanWord,
        phonetic: String(item.phonetic || '').trim(),
        partOfSpeech: String(item.partOfSpeech || 'n.').trim(),
        definition: String(item.definition || '未指定释义').trim(),
        exampleEn: String(item.exampleEn || '').trim(),
        exampleCn: String(item.exampleCn || '').trim(),
        tags: Array.isArray(item.tags) && item.tags.length > 0 ? item.tags : ['自定义'],
        status: ['new', 'learning', 'mastered'].includes(item.status) ? item.status : 'new',
        reviewCount: Math.max(0, Number(item.reviewCount) || 0),
        interval: Math.max(0, Number(item.interval) || 0),
        nextReviewDate: Number(item.nextReviewDate) || Date.now(),
        lastReviewedAt: item.lastReviewedAt ? Number(item.lastReviewedAt) : null,
        userNotes: String(item.userNotes || '').trim(),
        isStarred: !!(item.isStarred || item.is_starred),
        createdAt: Number(item.createdAt) || Date.now(),
        lastModifiedAt: Date.now()
      });
    }

    if (cleanIncoming.length === 0) {
      throw new Error('导入失败：未找到格式合规的单词对象，数据校验未通过');
    }

    let finalList = [];
    let addedCount = 0;
    let updatedCount = 0;

    if (strategy === 'overwrite') {
      finalList = cleanIncoming;
      addedCount = cleanIncoming.length;
    } else {
      const currentList = await this.getWords();
      const wordMap = new Map();

      currentList.forEach(w => {
        wordMap.set(w.word.toLowerCase().trim(), { ...w });
      });

      cleanIncoming.forEach(item => {
        const key = item.word.toLowerCase().trim();
        if (wordMap.has(key)) {
          const existing = wordMap.get(key);
          wordMap.set(key, {
            ...existing,
            ...item,
            reviewCount: Math.max(existing.reviewCount || 0, item.reviewCount || 0),
            status: (item.status === 'mastered' || existing.status === 'mastered') 
              ? 'mastered' 
              : (item.status === 'learning' || existing.status === 'learning' ? 'learning' : 'new'),
            interval: Math.max(existing.interval || 0, item.interval || 0),
            nextReviewDate: item.nextReviewDate || existing.nextReviewDate || Date.now(),
            lastReviewedAt: item.lastReviewedAt || existing.lastReviewedAt || null,
            userNotes: item.userNotes || existing.userNotes || '',
            isStarred: (item.isStarred !== undefined ? !!item.isStarred : !!existing.isStarred),
            lastModifiedAt: Date.now()
          });
          updatedCount++;
        } else {
          wordMap.set(key, item);
          addedCount++;
        }
      });

      finalList = Array.from(wordMap.values());
    }

    await this._persistWords(finalList);

    return {
      success: true,
      total: finalList.length,
      added: addedCount,
      updated: updatedCount,
      list: finalList
    };
  },

  /**
   * 重置/恢复默认词库
   * @returns {Promise<Array>}
   */
  async resetVocabulary() {
    const seedData = (typeof INITIAL_VOCABULARY !== 'undefined') ? INITIAL_VOCABULARY.map(w => ({
      ...w,
      interval: 0,
      nextReviewDate: Date.now(),
      lastReviewedAt: null
    })) : [];
    await this._persistWords(seedData);
    return seedData;
  },

  /**
   * 重置整个应用（恢复出厂设置）
   * 清空复习进度、自建词条、打卡天数与成就徽章，重新载入初始词库
   * @param {{ resetStats?: boolean, resetAchievements?: boolean }} [options]
   * @returns {Promise<Array>}
   */
  async resetApp(options = { resetStats: true, resetAchievements: true }) {
    // 1. 重建词库数据为纯净初始种子词
    const seedData = (typeof INITIAL_VOCABULARY !== 'undefined') ? INITIAL_VOCABULARY.map(w => ({
      ...w,
      interval: 0,
      nextReviewDate: Date.now(),
      lastReviewedAt: null,
      reviewCount: 0,
      status: 'new'
    })) : [];
    await this._persistWords(seedData);

    // 2. 清空连续打卡与学习统计
    if (options.resetStats) {
      localStorage.removeItem('bubei_review_streak_stats');
      if (typeof StatsService !== 'undefined') {
        StatsService.init();
      }
    }

    // 3. 清空成就徽章解锁
    if (options.resetAchievements) {
      localStorage.removeItem('bubei_achievements_v1');
      if (typeof AchievementService !== 'undefined') {
        AchievementService.init();
      }
    }

    return seedData;
  }
};

/**
 * SRSService - 间隔重复算法控制器 (Spaced Repetition System)
 * 复习阶梯：0天 (当天) -> 1天 -> 3天 -> 7天 -> 15天 -> 30天 (之后长期巩固翻倍)
 */
const SRS_INTERVALS = [1, 3, 7, 15, 30];

const SRSService = {
  /**
   * 点击“已掌握”计算递增复习间隔与下一次到期时间
   * 阶梯规律：0 -> 1天 -> 3天 -> 7天 -> 15天 -> 30天 (含数组越界保护与自然日归一化)
   * @param {Object} word 
   * @returns {{ interval: number, nextReviewDate: number, status: string, reviewCount: number, lastReviewedAt: number }}
   */
  calculateMastered(word) {
    const currentInterval = Number(word.interval) || 0;
    const currentReviewCount = Number(word.reviewCount) || 0;
    let nextInterval = 1;

    const matchedIdx = SRS_INTERVALS.indexOf(currentInterval);
    if (matchedIdx !== -1 && matchedIdx < SRS_INTERVALS.length - 1) {
      // 增加数组上限安全保护，确保索引不越界
      const safeIdx = Math.min(matchedIdx + 1, SRS_INTERVALS.length - 1);
      nextInterval = SRS_INTERVALS[safeIdx] || 30;
    } else if (currentInterval >= 30) {
      // 达到或超过 30 天，进入长期巩固期，间隔翻倍（最大上限 365 天）
      nextInterval = Math.min(365, Math.round(currentInterval * 2));
    } else {
      // 从未背过(0天)或自定义天数，取首个大于当前值的阶梯
      const higher = SRS_INTERVALS.find(i => i > currentInterval);
      nextInterval = higher || 1;
    }

    const now = Date.now();
    // 自然日零点归一化：将下一次复习时间锁定在目标日期的 00:00:00，杜绝深夜背词导致次日早晨复习时间漂移
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + nextInterval);
    targetDate.setHours(0, 0, 0, 0);
    const nextReviewDate = targetDate.getTime();

    // 间隔达到 15 天及以上时归为已掌握
    const status = nextInterval >= 15 ? 'mastered' : 'learning';

    return {
      interval: nextInterval,
      nextReviewDate: nextReviewDate,
      status: status,
      reviewCount: currentReviewCount + 1,
      lastReviewedAt: now
    };
  },

  /**
   * 点击“模糊 / 忘记 / 答错”：阶梯平滑退火衰减（SM-2 启发，拒绝一刀切清零）
   * 规则：
   * - 原间隔 >= 30 天：平滑衰减至 7 天 (保留深层记忆)
   * - 原间隔 >= 7 天：平滑衰减至 3 天
   * - 原间隔 >= 3 天：平滑衰减至 1 天
   * - 原间隔 <= 1 天：重置为 0 天 (放入今日待强化队列)
   * @param {Object} word
   * @returns {{ interval: number, nextReviewDate: number, status: string, reviewCount: number, lastReviewedAt: number }}
   */
  calculateFuzzy(word) {
    const currentInterval = Number(word.interval) || 0;
    const currentReviewCount = Number(word.reviewCount) || 0;
    const now = Date.now();
    let newInterval = 0;

    if (currentInterval >= 30) {
      newInterval = 7;
    } else if (currentInterval >= 7) {
      newInterval = 3;
    } else if (currentInterval >= 3) {
      newInterval = 1;
    } else {
      newInterval = 0;
    }

    let nextReviewDate = now;
    if (newInterval > 0) {
      const targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + newInterval);
      targetDate.setHours(0, 0, 0, 0);
      nextReviewDate = targetDate.getTime();
    }

    return {
      interval: newInterval,
      nextReviewDate: nextReviewDate,
      status: 'learning',
      reviewCount: Math.max(1, currentReviewCount), // 不粗暴清零，保留学习轨迹
      lastReviewedAt: now
    };
  },

  /**
   * 每日任务生成：优先提取已学且到期的复习单词，未学新词每日限量引入
   * 支持按 Band 分级筛选 (band4-5, band6-7, band8-9) 或仅背星标生词 (starred)
   * @param {Array} words 全量单词列表
   * @param {number} [newLimit=20] 每日新词限额
   * @param {string} [levelFilter='all'] 分级筛选
   * @returns {Array} 今日待复习与学习单词列表
   */
  generateTodayTasks(words, newLimit = 20, levelFilter = 'all') {
    if (!Array.isArray(words) || words.length === 0) return [];

    const now = Date.now();
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const threshold = endOfToday.getTime();

    // 根据选定分级筛选候选词池
    let pool = words;
    if (levelFilter === 'band4-5') {
      pool = words.filter(w => (w.tags || []).some(t => /band\s*[45]/i.test(t)));
    } else if (levelFilter === 'band6-7') {
      pool = words.filter(w => (w.tags || []).some(t => /band\s*[67]/i.test(t)));
    } else if (levelFilter === 'band8-9') {
      pool = words.filter(w => (w.tags || []).some(t => /band\s*[89]/i.test(t)));
    } else if (levelFilter === 'starred') {
      pool = words.filter(w => !!w.isStarred);
    }

    if (pool.length === 0) {
      pool = words; // 若该分类暂无词汇则回退至全量
    }

    // 1. 已学过且当前已到期的复习词汇
    const dueWords = [];
    // 2. 从未背过的新词
    const newWords = [];

    for (const w of pool) {
      // 本地时钟篡改保护：若未来时间戳异常超过 365 天，自动修正归位为今日到期
      let nextReviewDate = Number(w.nextReviewDate) || 0;
      if (nextReviewDate > now + (365 * 24 * 60 * 60 * 1000)) {
        nextReviewDate = threshold;
        w.nextReviewDate = nextReviewDate;
      }

      const isLearned = (Number(w.reviewCount) > 0) || (w.status === 'learning') || (w.status === 'mastered');
      if (isLearned) {
        if (nextReviewDate <= threshold) {
          dueWords.push(w);
        }
      } else {
        newWords.push(w);
      }
    }

    // 复习词按到期时间升序排列，越早超期的排在越前面
    dueWords.sort((a, b) => (a.nextReviewDate || 0) - (b.nextReviewDate || 0));

    // 每日新词配额裁剪
    const safeLimit = Math.max(1, Number(newLimit) || 20);
    const todayNewQuota = newWords.slice(0, safeLimit);

    return [...dueWords, ...todayNewQuota];
  },

  /**
   * 人性化格式化下一次复习提示（用于词库列表直观展示）
   * @param {Object} word
   * @returns {{ text: string, isDue: boolean, badgeClass: string }}
   */
  getDueInfo(word) {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const todayThreshold = endOfToday.getTime();

    const nextDate = Number(word.nextReviewDate);
    if (!nextDate || nextDate <= todayThreshold) {
      return {
        text: '今日待复习',
        isDue: true,
        badgeClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-300/30'
      };
    }

    const diffDays = Math.ceil((nextDate - Date.now()) / (24 * 60 * 60 * 1000));
    if (diffDays <= 1) {
      return {
        text: '明天复习',
        isDue: false,
        badgeClass: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-300/30'
      };
    }

    return {
      text: `${diffDays} 天后复习 (${word.interval}天阶段)`,
      isDue: false,
      badgeClass: 'bg-gold-50 dark:bg-gold-950/40 text-gold-700 dark:text-gold-300 border border-gold-300/30'
    };
  }
};

/* ---------------- 3. StatsService: 学习数据统计与打卡服务 ---------------- */
const STATS_STORAGE_KEY = 'bubei_study_stats_v1';

const StatsService = {
  /**
   * 格式化 Date 为 YYYY-MM-DD
   */
  formatDate(date = new Date()) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  /**
   * 初始化统计数据（干净初始状态，无虚假历史打卡与连击数据）
   */
  init() {
    try {
      const stored = localStorage.getItem(STATS_STORAGE_KEY);
      if (!stored) {
        const todayStr = this.formatDate();
        const cleanStats = {
          dailyCounts: { [todayStr]: 0 },
          checkInDates: [],
          bestStreak: 0,
          lastActiveDate: todayStr
        };
        localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(cleanStats));
      }
    } catch (e) {
      console.warn('[StatsService] init 异常:', e);
    }
  },

  /**
   * 读取统计数据
   */
  getStats() {
    try {
      this.init();
      const stored = localStorage.getItem(STATS_STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        if (!data.dailyCounts) data.dailyCounts = {};
        if (!Array.isArray(data.checkInDates)) data.checkInDates = [];
        if (typeof data.bestStreak !== 'number') data.bestStreak = 0;
        return data;
      }
    } catch (e) {
      console.warn('[StatsService] getStats 异常:', e);
    }
    return { dailyCounts: {}, checkInDates: [], bestStreak: 0 };
  },

  /**
   * 保存统计数据
   */
  saveStats(stats) {
    try {
      localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
      SupabaseService.syncStats(stats).catch(() => {});
    } catch (e) {
      console.warn('[StatsService] saveStats 异常:', e);
    }
  },

  /**
   * 计算连续打卡天数（Streak）
   * 采用绝对自然日 UTC 整数天数差比对，彻底解决夏令时、深夜跨天（如昨天 23:50 与今天 00:20）打卡断签误判
   */
  calculateStreak(checkInDates = []) {
    if (!Array.isArray(checkInDates) || checkInDates.length === 0) return 0;

    // 清洗并排序有效 YYYY-MM-DD 日期
    const validDates = Array.from(new Set(checkInDates.filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))).sort();
    if (validDates.length === 0) return 0;

    const parseUtcDays = (str) => {
      const [y, m, d] = str.split('-').map(Number);
      return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    };

    const todayStr = this.formatDate();
    const todayDays = parseUtcDays(todayStr);

    const lastCheckInStr = validDates[validDates.length - 1];
    const lastCheckInDays = parseUtcDays(lastCheckInStr);

    // 如果最后一次打卡距今超过 1 天（即昨天和今天均未打卡），连续天数中断归零
    if (todayDays - lastCheckInDays > 1) {
      return 0;
    }

    // 从最近一次打卡往前倒推统计连续天数
    let streak = 1;
    let expectedDays = lastCheckInDays;

    for (let i = validDates.length - 2; i >= 0; i--) {
      const currentDays = parseUtcDays(validDates[i]);
      if (currentDays === expectedDays - 1) {
        streak++;
        expectedDays = currentDays;
      } else if (currentDays === expectedDays) {
        // 重复打卡跳过
        continue;
      } else {
        break;
      }
    }

    return streak;
  },

  /**
   * 记录一次单词复习
   * @param {number} count 增加的复习词数，默认为 1
   * @returns {{ todayCount: number, streak: number, bestStreak: number, justCheckedIn: boolean, isCheckedInToday: boolean }}
   */
  recordReview(count = 1) {
    const stats = this.getStats();
    const todayStr = this.formatDate();

    const previousCount = stats.dailyCounts[todayStr] || 0;
    const newCount = previousCount + count;
    stats.dailyCounts[todayStr] = newCount;

    let justCheckedIn = false;
    const hasCheckedInBefore = stats.checkInDates.includes(todayStr);

    // 核心打卡规则：当今天复习词数达到 5 词及以上且尚未记录打卡时，自动记录今天打卡
    if (newCount >= 5 && !hasCheckedInBefore) {
      stats.checkInDates.push(todayStr);
      justCheckedIn = true;
    }

    const currentStreak = this.calculateStreak(stats.checkInDates);
    if (currentStreak > stats.bestStreak) {
      stats.bestStreak = currentStreak;
    }

    this.saveStats(stats);

    return {
      todayCount: newCount,
      streak: currentStreak,
      bestStreak: stats.bestStreak,
      justCheckedIn,
      isCheckedInToday: stats.checkInDates.includes(todayStr)
    };
  },

  /**
   * 获取最近 7 天的复习统计与图表数据（从 6 天前至今天）
   */
  getPast7DaysData() {
    const stats = this.getStats();
    const todayStr = this.formatDate();
    const result = [];
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = this.formatDate(d);
      const count = stats.dailyCounts[dateStr] || 0;
      const isToday = (i === 0);
      const dayOfWeek = weekdays[d.getDay()];
      const shortDate = `${d.getMonth() + 1}/${d.getDate()}`;
      const isCheckedIn = stats.checkInDates.includes(dateStr);

      result.push({
        dateStr,
        count,
        isToday,
        dayLabel: isToday ? '今天' : (i === 1 ? '昨天' : dayOfWeek),
        shortDate,
        isCheckedIn
      });
    }

    const total7Days = result.reduce((sum, item) => sum + item.count, 0);
    const maxCount = Math.max(5, ...result.map(r => r.count));

    return {
      days: result,
      total7Days,
      maxCount,
      streak: this.calculateStreak(stats.checkInDates),
      bestStreak: stats.bestStreak,
      todayCount: stats.dailyCounts[todayStr] || 0,
      isCheckedInToday: stats.checkInDates.includes(todayStr)
    };
  }
};

/* ---------------- 4. AchievementService: 徽章成就与里程碑服务 ---------------- */
const ACHIEVEMENTS_STORAGE_KEY = 'bubei_achievements_v1';

const PRESET_ACHIEVEMENTS = [
  {
    id: 'first_word',
    name: '初学启程',
    icon: '🌱',
    desc: '迈出学术英语第一步，掌握首个核心词汇',
    calcProgress: (ctx) => {
      const current = ctx.masteredCount || 0;
      return {
        current,
        target: 1,
        text: current >= 1 ? '已达成' : `${current}/1 词`,
        percent: Math.min(100, Math.round((current / 1) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.masteredCount || 0) >= 1
  },
  {
    id: 'vocab_100',
    name: '单词斩百',
    icon: '⚔️',
    desc: '突破百词大关，建立稳定学术语感',
    calcProgress: (ctx) => {
      const current = ctx.masteredCount || 0;
      return {
        current,
        target: 100,
        text: current >= 100 ? '已达成' : `${current}/100 词`,
        percent: Math.min(100, Math.round((current / 100) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.masteredCount || 0) >= 100
  },
  {
    id: 'vocab_500',
    name: '学术进阶',
    icon: '📚',
    desc: '累计掌握 500 个学术核心词，轻松应对阅读障碍',
    calcProgress: (ctx) => {
      const current = ctx.masteredCount || 0;
      return {
        current,
        target: 500,
        text: current >= 500 ? '已达成' : `${current}/500 词`,
        percent: Math.min(100, Math.round((current / 500) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.masteredCount || 0) >= 500
  },
  {
    id: 'vocab_1000',
    name: '词汇破千',
    icon: '🛡️',
    desc: '斩获千词里程碑，从容精读原版学术文献',
    calcProgress: (ctx) => {
      const current = ctx.masteredCount || 0;
      return {
        current,
        target: 1000,
        text: current >= 1000 ? '已达成' : `${current}/1000 词`,
        percent: Math.min(100, Math.round((current / 1000) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.masteredCount || 0) >= 1000
  },
  {
    id: 'streak_3',
    name: '自律星火',
    icon: '🔥',
    desc: '持之以恒，连续完成 3 天打卡',
    calcProgress: (ctx) => {
      const current = ctx.streak || 0;
      return {
        current,
        target: 3,
        text: current >= 3 ? '已达成' : `${current}/3 天`,
        percent: Math.min(100, Math.round((current / 3) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.streak || 0) >= 3
  },
  {
    id: 'streak_7',
    name: '自律达人',
    icon: '👑',
    desc: '百炼成钢，连续完成 7 天打卡',
    calcProgress: (ctx) => {
      const current = ctx.streak || 0;
      return {
        current,
        target: 7,
        text: current >= 7 ? '已达成' : `${current}/7 天`,
        percent: Math.min(100, Math.round((current / 7) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.streak || 0) >= 7
  },
  {
    id: 'streak_30',
    name: '月度标兵',
    icon: '🌟',
    desc: '自律沉淀为习惯，连续坚持打卡达到 30 天',
    calcProgress: (ctx) => {
      const current = ctx.streak || 0;
      return {
        current,
        target: 30,
        text: current >= 30 ? '已达成' : `${current}/30 天`,
        percent: Math.min(100, Math.round((current / 30) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.streak || 0) >= 30
  },
  {
    id: 'perfect_test',
    name: '全能学者',
    icon: '⚡',
    desc: '在拼写测试或四选题自测中斩获 100% 满分',
    calcProgress: (ctx) => {
      const isDone = !!ctx.hasPerfectScore;
      return {
        current: isDone ? 1 : 0,
        target: 1,
        text: isDone ? '已达成' : '待自测满分',
        percent: isDone ? 100 : 0
      };
    },
    checkUnlock: (ctx) => !!ctx.hasPerfectScore
  }
];

const AchievementService = {
  init() {
    try {
      const stored = localStorage.getItem(ACHIEVEMENTS_STORAGE_KEY);
      if (!stored) {
        const initial = {
          unlocked: {},
          hasPerfectScore: false
        };
        localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify(initial));
      }
    } catch (e) {
      console.warn('[AchievementService] init 异常:', e);
    }
  },

  getData() {
    try {
      this.init();
      const stored = localStorage.getItem(ACHIEVEMENTS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (!parsed.unlocked) parsed.unlocked = {};
        return parsed;
      }
    } catch (e) {
      console.warn('[AchievementService] getData 异常:', e);
    }
    return { unlocked: {}, hasPerfectScore: false };
  },

  saveData(data) {
    try {
      localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[AchievementService] saveData 异常:', e);
    }
  },

  /**
   * 标记已达成满分测试 (拼写或选择题)
   */
  recordPerfectScore() {
    const data = this.getData();
    data.hasPerfectScore = true;
    this.saveData(data);
  },

  /**
   * 获取所有预设成就（共 8 个）及其在当前上下文下的达成状态与进度
   */
  getAchievements(context = {}) {
    const data = this.getData();
    const mergedContext = {
      ...context,
      hasPerfectScore: data.hasPerfectScore || !!context.hasPerfectScore
    };

    return PRESET_ACHIEVEMENTS.map(ach => {
      const isUnlocked = !!data.unlocked[ach.id];
      const unlockedAt = data.unlocked[ach.id] || null;
      const progress = ach.calcProgress(mergedContext);

      return {
        id: ach.id,
        name: ach.name,
        icon: ach.icon,
        desc: ach.desc,
        isUnlocked,
        unlockedAt,
        progress
      };
    });
  },

  /**
   * 核心检测：判断是否有新满足条件的成就，自动解锁并返回最新解锁列表
   * @param {Object} context 上下文数据 { totalWords, masteredCount, streak, hasPerfectScore }
   * @returns {Array} 新解锁的成就对象列表 (若无新解锁则为空数组)
   */
  checkMilestones(context = {}) {
    const data = this.getData();
    if (context.hasPerfectScore) {
      data.hasPerfectScore = true;
    }
    const mergedContext = {
      ...context,
      hasPerfectScore: data.hasPerfectScore || !!context.hasPerfectScore
    };

    const newlyUnlocked = [];

    PRESET_ACHIEVEMENTS.forEach(ach => {
      // 若尚未解锁，且满足检测条件
      if (!data.unlocked[ach.id] && ach.checkUnlock(mergedContext)) {
        const now = Date.now();
        data.unlocked[ach.id] = now;
        newlyUnlocked.push({
          id: ach.id,
          name: ach.name,
          icon: ach.icon,
          desc: ach.desc,
          unlockedAt: now
        });
      }
    });

    if (newlyUnlocked.length > 0 || context.hasPerfectScore) {
      this.saveData(data);
    }

    return newlyUnlocked;
  }
};

// 挂载至全局与模块系统
if (typeof window !== 'undefined') {
  window.DataService = DataService;
  window.SRSService = SRSService;
  window.StatsService = StatsService;
  window.AchievementService = AchievementService;
  window.SupabaseService = SupabaseService;
  window.SUPABASE_CONFIG = SUPABASE_CONFIG;
  window.SettingsService = SettingsService;
  window.getDeviceId = getDeviceId;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DataService, SRSService, StatsService, AchievementService, SupabaseService, SUPABASE_CONFIG, SettingsService, getDeviceId };
}
